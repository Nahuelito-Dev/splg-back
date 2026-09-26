import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Payment } from '../entities/payment.entity';
import {
  PaymentGateway,
  PaymentIntegration,
  LedgerPaymentStatus,
} from '../domain/payment.enums';
import {
  CreateCheckoutResult,
  GatewayPayment,
  PaymentCheckoutItem,
  PaymentGatewayPort,
  VerifyWebhookSignatureInput,
} from '../domain/ports/payment-gateway.port';
import { errorMessage } from '../../common/errors/error-message';

/** Input para crear un checkout: agnóstico de la pasarela concreta. */
export interface CreatePaymentCheckoutInput {
  orderId: string;
  distributorId?: string | null;
  /** Monto real a cobrar en este intento (el pedido completo o solo la seña). */
  amount: number;
  /** true si este intento cobra la SEÑA de una reserva, no el pedido completo. */
  isDeposit: boolean;
  items: PaymentCheckoutItem[];
  payerEmail: string;
}

export interface ConfirmFromGatewayInput {
  type?: string;
  dataId?: string;
}

/**
 * Resultado normalizado de una notificación de la pasarela, listo para que el
 * caller (hoy `ConfirmPaymentUseCase`, en `order`) decida los efectos de
 * NEGOCIO del pedido (marcar PAID, activar reserva, despachar, etc.) — este
 * servicio solo interpreta la pasarela y actualiza el ledger, nunca toca
 * `order`.
 */
export interface ConfirmFromGatewayResult {
  externalReference: string;
  gatewayPaymentId: string;
  /** Estado CRUDO de la pasarela (ej. 'approved'/'rejected'/'pending'). */
  status: string;
  /** Derivado del ledger: si el `Payment` matcheado es una seña. */
  isDeposit: boolean;
}

/**
 * Servicio de aplicación de pagos, GATEWAY-AGNÓSTICO: habla contra
 * `PaymentGatewayPort` (hoy MercadoPago Checkout Pro) y mantiene el ledger
 * (`Payment`) de intentos de cobro. Lo consume `order` (create-order,
 * webhook) para desacoplar el dominio de pedidos del proveedor de pago
 * concreto — sumar un gateway nuevo es agregar un adapter acá, no tocar
 * `order`.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    private readonly paymentGateway: PaymentGatewayPort,
  ) {}

  /**
   * Crea el registro de ledger (PENDING) y delega en la pasarela la creación
   * del checkout. Si la pasarela falla, el ledger queda igual (PENDING sin
   * `payment_url`) como rastro del intento fallido — el caller (hoy
   * `CreateOrderUseCase`) decide qué hacer (best-effort: el pedido queda
   * creado igual, sin URL, el cliente puede reintentar).
   */
  async createCheckout(
    input: CreatePaymentCheckoutInput,
  ): Promise<CreateCheckoutResult> {
    const ledgerPayment = await this.paymentRepository.save(
      this.paymentRepository.create({
        order_id: input.orderId,
        distributor_id: input.distributorId ?? null,
        gateway: PaymentGateway.MERCADOPAGO,
        integration: PaymentIntegration.CHECKOUT_PRO,
        external_reference: input.orderId,
        amount: input.amount,
        is_deposit: input.isDeposit,
        status: LedgerPaymentStatus.PENDING,
      }),
    );

    const checkout = await this.paymentGateway.createCheckout({
      orderId: input.orderId,
      items: input.items,
      payerEmail: input.payerEmail,
    });

    ledgerPayment.payment_url = checkout.initPoint;
    ledgerPayment.metadata = { preferenceId: checkout.preferenceId };
    await this.paymentRepository.save(ledgerPayment);

    return checkout;
  }

  /**
   * Interpreta una notificación de webhook: consulta el pago REAL en la
   * pasarela (nunca confía en el payload del webhook) y actualiza el ledger.
   * Devuelve `null` cuando no hay nada que procesar (tipo de notificación
   * irrelevante, sin `dataId`, consulta a la pasarela fallida, o pago sin
   * `external_reference`) — el caller no debe seguir el flujo en ese caso.
   */
  async confirmFromGateway(
    input: ConfirmFromGatewayInput,
  ): Promise<ConfirmFromGatewayResult | null> {
    if (input.type !== 'payment' || !input.dataId) {
      // Otros tipos de notificación (merchant_order, etc.) no nos interesan.
      this.logger.debug(`Notificación ignorada (type=${input.type})`);
      return null;
    }

    let gatewayPayment: GatewayPayment;
    try {
      gatewayPayment = await this.paymentGateway.getPayment(input.dataId);
    } catch (error) {
      this.logger.error(
        `No se pudo consultar el pago ${input.dataId} en la pasarela: ${errorMessage(error)}`,
      );
      return null;
    }

    if (!gatewayPayment.externalReference) {
      this.logger.warn(
        `Pago ${gatewayPayment.id} sin external_reference, se ignora`,
      );
      return null;
    }

    const isDeposit = await this.updateLedger(gatewayPayment);

    return {
      externalReference: gatewayPayment.externalReference,
      gatewayPaymentId: gatewayPayment.id,
      status: gatewayPayment.status,
      isDeposit,
    };
  }

  verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
    return this.paymentGateway.verifyWebhookSignature(input);
  }

  /**
   * Actualiza el registro de ledger correspondiente a este pago de la
   * pasarela. Idempotente: si ya existe un `Payment` con ese
   * `gateway_payment_id` (reintento del webhook), lo reutiliza en vez de
   * crear uno nuevo. Si es la primera notificación, matchea el `Payment`
   * PENDING creado en `createCheckout` para ese pedido (todavía sin
   * `gateway_payment_id`). Devuelve `is_deposit` del registro matcheado (o
   * `false` si no se encontró ninguno, para no romper al caller).
   */
  private async updateLedger(gatewayPayment: GatewayPayment): Promise<boolean> {
    let ledgerPayment = await this.paymentRepository.findOne({
      where: { gateway_payment_id: gatewayPayment.id },
    });

    if (!ledgerPayment) {
      ledgerPayment = await this.paymentRepository.findOne({
        where: {
          external_reference: gatewayPayment.externalReference ?? undefined,
          gateway_payment_id: IsNull(),
        },
        order: { createdAt: 'DESC' },
      });
    }

    if (!ledgerPayment) {
      // No debería ocurrir (todo checkout pasa por createCheckout), pero un
      // pago sin ledger asociado no debe romper la confirmación del pedido.
      this.logger.warn(
        `Pago ${gatewayPayment.id} sin Payment de ledger asociado (pedido ${gatewayPayment.externalReference})`,
      );
      return false;
    }

    ledgerPayment.gateway_payment_id = gatewayPayment.id;
    ledgerPayment.status = this.toLedgerStatus(gatewayPayment.status);
    ledgerPayment.metadata = {
      ...(ledgerPayment.metadata ?? {}),
      gatewayStatus: gatewayPayment.status,
    };
    await this.paymentRepository.save(ledgerPayment);

    return ledgerPayment.is_deposit;
  }

  private toLedgerStatus(gatewayStatus: string): LedgerPaymentStatus {
    switch (gatewayStatus) {
      case 'approved':
        return LedgerPaymentStatus.APPROVED;
      case 'rejected':
        return LedgerPaymentStatus.REJECTED;
      case 'cancelled':
        return LedgerPaymentStatus.CANCELLED;
      case 'refunded':
      case 'charged_back':
        return LedgerPaymentStatus.REFUNDED;
      default:
        return LedgerPaymentStatus.PENDING;
    }
  }
}
