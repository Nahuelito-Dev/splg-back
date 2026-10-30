import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { Payment } from '../entities/payment.entity';
import {
  montoCoincide,
  puedeTransicionarElPago,
} from '../domain/payment-status.machine';
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
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { OrderStatus, PaymentStatus } from '../../order/entities/order.entity';
import { errorMessage } from '../../common/errors/error-message';
import {
  ResultadoDelAsiento,
  SalesCashService,
} from '../../cash/application/sales-cash.service';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';

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
  /**
   * Presente cuando la pasarela aprobó un importe distinto del esperado: el
   * caller no tiene que dar el pedido por pagado ni despacharlo.
   */
  montoDistinto?: { esperado: number; cobrado: number };
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
    private readonly orderLookup: OrderLookupService,
    private readonly ventasEnCaja: SalesCashService,
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
    await this.assertPedidoCobrable(input.orderId);

    const ledgerPayment = await this.paymentRepository.save(
      this.paymentRepository.create({
        orderId: input.orderId,
        distributorId: input.distributorId ?? null,
        gateway: PaymentGateway.MERCADOPAGO,
        integration: PaymentIntegration.CHECKOUT_PRO,
        externalReference: input.orderId,
        amount: input.amount,
        isDeposit: input.isDeposit,
        status: LedgerPaymentStatus.PENDING,
      }),
    );

    const checkout = await this.paymentGateway.createCheckout({
      orderId: input.orderId,
      items: input.items,
      payerEmail: input.payerEmail,
    });

    ledgerPayment.paymentUrl = checkout.initPoint;
    ledgerPayment.metadata = { preferenceId: checkout.preferenceId };
    await this.paymentRepository.save(ledgerPayment);

    return checkout;
  }

  /**
   * El enlace de pago vigente de cada pedido: el del ÚLTIMO intento de cobro
   * (por fecha), y sólo si ese intento sigue pendiente y tiene URL (cubre el
   * checkout del pedido y el de la seña de una reserva). Un intento posterior
   * rechazado, cancelado o sin URL reemplaza al anterior: el enlace viejo no se
   * vuelve a publicar. Sin pedido en el mapa = no hay enlace vigente.
   */
  async findPendingCheckoutUrls(
    orderIds: string[],
  ): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (orderIds.length === 0) return urls;
    const pagos = await this.paymentRepository.find({
      where: { orderId: In(orderIds) },
      order: { createdAt: 'ASC' },
    });
    const ultimo = new Map<string, Payment>();
    for (const pago of pagos) ultimo.set(pago.orderId, pago);
    for (const [orderId, pago] of ultimo) {
      if (pago.status === LedgerPaymentStatus.PENDING && pago.paymentUrl) {
        urls.set(orderId, pago.paymentUrl);
      }
    }
    return urls;
  }

  /** 404 si el pedido no existe; 409 si ya no se puede cobrar. */
  private async assertPedidoCobrable(orderId: string): Promise<void> {
    const pedido = await this.orderLookup.findPaymentState(orderId);
    if (!pedido) {
      throw new NotFoundException(`Pedido ${orderId} no encontrado`);
    }
    if (pedido.paymentStatus === PaymentStatus.PAID) {
      throw new ConflictException('El pedido ya está pagado');
    }
    if (pedido.status === OrderStatus.CANCELLED) {
      throw new ConflictException(
        'El pedido está cancelado: no se puede cobrar',
      );
    }
    if (pedido.status === OrderStatus.DELIVERED) {
      throw new ConflictException(
        'El pedido ya fue entregado: no se puede cobrar',
      );
    }
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

    const { isDeposit, estadoAtrasado, montoDistinto, asiento } =
      await this.updateLedger(gatewayPayment);
    if (asiento) {
      this.ventasEnCaja.avisarSinAsentar(
        asiento.distributorId,
        asiento.resultado,
        gatewayPayment.externalReference,
      );
    }

    return {
      externalReference: gatewayPayment.externalReference,
      gatewayPaymentId: gatewayPayment.id,
      // Una notificación atrasada no cambia lo que ya sabemos del pago.
      status: estadoAtrasado ?? gatewayPayment.status,
      isDeposit,
      ...(montoDistinto && { montoDistinto }),
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
  private async updateLedger(
    gatewayPayment: GatewayPayment,
    reintento = false,
  ): Promise<{
    isDeposit: boolean;
    /** Estado vigente del ledger cuando la notificación llegó atrasada. */
    estadoAtrasado?: LedgerPaymentStatus;
    montoDistinto?: { esperado: number; cobrado: number };
    /** Qué pasó con el ingreso a caja de un pago recién aprobado. */
    asiento?: { resultado: ResultadoDelAsiento; distributorId: string };
  }> {
    // Leer, validar y escribir con la fila del pago bloqueada: dos notificaciones
    // intercaladas se aplican una detrás de la otra y la segunda ya ve el estado
    // que dejó la primera (no hay carrera que deje `pending` después de `approved`).
    try {
      return await this.actualizarLedgerEnTransaccion(gatewayPayment);
    } catch (error) {
      // Otra notificación del mismo pago ya se llevó ese id de pasarela
      // (índice único): no es un error, el pago ya está procesado. Se vuelve a
      // resolver y se aplica sobre el intento que corresponde.
      if (!reintento && codigoSqlDelError(error) === '23505') {
        this.logger.warn(
          `Pago ${gatewayPayment.id}: otra notificación lo procesó al mismo tiempo, se reintenta`,
        );
        return this.updateLedger(gatewayPayment, true);
      }
      throw error;
    }
  }

  private async actualizarLedgerEnTransaccion(
    gatewayPayment: GatewayPayment,
  ): Promise<{
    isDeposit: boolean;
    estadoAtrasado?: LedgerPaymentStatus;
    montoDistinto?: { esperado: number; cobrado: number };
    asiento?: { resultado: ResultadoDelAsiento; distributorId: string };
  }> {
    return this.paymentRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(Payment);
      const bloqueado = { mode: 'pessimistic_write' } as const;
      const porPasarela = () =>
        repo.findOne({
          where: { gatewayPaymentId: gatewayPayment.id },
          lock: bloqueado,
        });

      let ledgerPayment = await porPasarela();
      if (!ledgerPayment) {
        const candidato = await repo.findOne({
          where: {
            externalReference: gatewayPayment.externalReference ?? undefined,
            gatewayPaymentId: IsNull(),
          },
          order: { createdAt: 'DESC' },
          lock: bloqueado,
        });
        // Con el candidato bloqueado se vuelve a resolver la identidad: si otra
        // notificación del mismo pago ya tomó OTRO intento (con dos intentos sin
        // id de pasarela, cada una pudo elegir uno distinto), ese es el pago.
        ledgerPayment = (await porPasarela()) ?? candidato;
      }

      if (!ledgerPayment) {
        // No debería ocurrir (todo checkout pasa por createCheckout), pero un
        // pago sin ledger asociado no debe romper la confirmación del pedido.
        this.logger.warn(
          `Pago ${gatewayPayment.id} sin Payment de ledger asociado (pedido ${gatewayPayment.externalReference})`,
        );
        return { isDeposit: false };
      }

      const nuevoEstado = this.toLedgerStatus(gatewayPayment.status);
      const permitido = puedeTransicionarElPago(
        ledgerPayment.status,
        nuevoEstado,
      );
      if (!permitido) {
        this.logger.warn(
          `Pago ${gatewayPayment.id}: la notificación (${gatewayPayment.status}) llegó después de ${ledgerPayment.status} y no se aplica`,
        );
      }

      // Lo que la pasarela cobró tiene que ser lo que se pidió cobrar.
      const esperado = Number(ledgerPayment.amount);
      const cobrado = gatewayPayment.amount ?? null;
      const montoNuevo =
        permitido &&
        nuevoEstado === LedgerPaymentStatus.APPROVED &&
        cobrado !== null &&
        !montoCoincide(esperado, cobrado)
          ? { esperado, cobrado }
          : undefined;
      if (montoNuevo) {
        this.logger.error(
          `ALERTA: el pago ${gatewayPayment.id} del pedido ${ledgerPayment.orderId} se aprobó por ${cobrado} y se esperaba ${esperado}: no se da por pagado ni se despacha`,
        );
      }
      // La alerta es persistente: una vez marcado, cualquier notificación
      // posterior del pago (incluso un `pending` atrasado) la sigue informando.
      const montoDistinto = montoNuevo ?? montoDistintoGuardado(ledgerPayment);

      const aprobadoAhora =
        permitido &&
        nuevoEstado === LedgerPaymentStatus.APPROVED &&
        ledgerPayment.status !== LedgerPaymentStatus.APPROVED;
      const devuelto = devueltoSegunLaPasarela(gatewayPayment);
      const devueltoGuardado = Number(
        ledgerPayment.metadata?.gatewayRefunded ?? 0,
      );
      ledgerPayment.gatewayPaymentId = gatewayPayment.id;
      if (permitido) ledgerPayment.status = nuevoEstado;
      if (aprobadoAhora) ledgerPayment.approvedAt = new Date();
      ledgerPayment.metadata = {
        ...(ledgerPayment.metadata ?? {}),
        gatewayStatus: gatewayPayment.status,
        ...(aprobadoAhora && {
          gatewayAmount: cobrado ?? esperado,
          feeAmount: gatewayPayment.feeAmount ?? null,
          feeStatus:
            gatewayPayment.feeAmount == null ? 'unreported' : 'reported',
        }),
        ...(devuelto > devueltoGuardado && { gatewayRefunded: devuelto }),
        ...(montoDistinto && { montoDistinto }),
      };
      await repo.save(ledgerPayment);

      // El dinero que la pasarela acreditó entra a la caja de Mercado Pago en la
      // misma transacción que aprueba el pago, y lo que la pasarela devolvió por
      // su cuenta (devolución desde su panel, contracargo) sale de ella. Un fallo
      // del asiento no frena la confirmación: queda sin asentar.
      const distributorId = ledgerPayment.distributorId;
      const resultados: ResultadoDelAsiento[] = [];
      if (distributorId && aprobadoAhora) {
        resultados.push(
          await this.ventasEnCaja.asentarCobroDeMercadoPago(manager, {
            distributorId,
            orderId: ledgerPayment.orderId,
            paymentId: ledgerPayment.paymentId,
            gatewayPaymentId: gatewayPayment.id,
            amount: cobrado ?? esperado,
            feeAmount: gatewayPayment.feeAmount,
            feeUnreported: gatewayPayment.feeAmount == null,
          }),
        );
      }
      if (distributorId && devuelto > 0) {
        resultados.push(
          await this.ventasEnCaja.asentarDevolucionExterna(manager, {
            distributorId,
            orderId: ledgerPayment.orderId,
            paymentId: ledgerPayment.paymentId,
            gatewayPaymentId: gatewayPayment.id,
            refundedTotal: devuelto,
            contracargo: gatewayPayment.status === 'charged_back',
          }),
        );
      }
      const resultado =
        resultados.find((r) => r === 'fallo' || r === 'sin_caja') ??
        resultados[0];
      const asiento =
        distributorId && resultado ? { distributorId, resultado } : undefined;

      return {
        isDeposit: ledgerPayment.isDeposit,
        ...(!permitido && { estadoAtrasado: ledgerPayment.status }),
        ...(montoDistinto && { montoDistinto }),
        ...(asiento && { asiento }),
      };
    });
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

/** La alerta de monto distinto que quedó guardada en el pago, si la hay. */
function montoDistintoGuardado(
  pago: Payment,
): { esperado: number; cobrado: number } | undefined {
  const guardado: unknown = pago.metadata?.montoDistinto;
  if (typeof guardado !== 'object' || guardado === null) return undefined;
  const { esperado, cobrado } = guardado as Record<string, unknown>;
  return typeof esperado === 'number' && typeof cobrado === 'number'
    ? { esperado, cobrado }
    : undefined;
}

/** Lo que la pasarela dice que devolvió de un pago: lo informado, o todo si está devuelto o con contracargo. */
function devueltoSegunLaPasarela(pago: GatewayPayment): number {
  const informado = pago.refundedAmount ?? 0;
  if (pago.status === 'refunded' || pago.status === 'charged_back') {
    return informado > 0 ? informado : (pago.amount ?? 0);
  }
  return informado;
}
