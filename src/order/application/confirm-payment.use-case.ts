import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Order, OrderStatus, PaymentStatus } from '../entities/order.entity';
import { isTerminal } from '../domain/order-status.machine';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { PaymentsService } from '../../payments/application/payments.service';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { errorMessage } from '../../common/errors/error-message';

/** Payload que llega del webhook de MercadoPago (query params `type`/`data.id`). */
export interface ConfirmPaymentInput {
  type?: string;
  dataId?: string;
  xSignature?: string;
  xRequestId?: string;
}

/**
 * Caso de uso: confirmar el pago de un pedido MERCADOPAGO a partir de la
 * notificación webhook.
 *
 * Idempotente por diseño: MercadoPago reintenta notificaciones ante cualquier
 * respuesta que no sea 2xx (y a veces igual reintenta con 2xx), así que este
 * use-case puede ejecutarse varias veces para el MISMO pago sin efectos
 * duplicados — nunca se despacha dos veces un pedido ya pagado.
 *
 * NO valida la firma acá (la valida el controller antes de llamar a
 * `execute`, para loguear el intento inválido sin filtrar detalles del
 * dominio) — este use-case asume que ya se validó.
 *
 * Tampoco habla con la pasarela ni con el ledger de pagos directamente: eso
 * es responsabilidad de `PaymentsService` (módulo `payments`). Este use-case
 * consume su resultado NORMALIZADO y aplica los efectos de NEGOCIO del
 * pedido (marcar PAID/seña, despachar) — la separación evita que `order`
 * conozca MercadoPago.
 */
@Injectable()
export class ConfirmPaymentUseCase {
  private readonly logger = new Logger(ConfirmPaymentUseCase.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly orders: OrderRepositoryPort,
    private readonly paymentsService: PaymentsService,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
  ) {}

  async execute(input: ConfirmPaymentInput): Promise<void> {
    const payment = await this.paymentsService.confirmFromGateway({
      type: input.type,
      dataId: input.dataId,
    });

    if (!payment) {
      // PaymentsService ya logueó el motivo (tipo irrelevante, sin dataId,
      // consulta a la pasarela fallida, o pago sin external_reference).
      return;
    }

    const order = await this.orders.findByIdFull(payment.externalReference);
    if (!order) {
      this.logger.warn(
        `Pago ${payment.gatewayPaymentId} referencia un pedido inexistente: ${payment.externalReference}`,
      );
      return;
    }

    if (payment.status === 'approved') {
      await this.handleApproved(order, payment.gatewayPaymentId);
      return;
    }

    if (payment.status === 'rejected' || payment.status === 'cancelled') {
      // TODO: liberar el stock reservado (GasCylinderService.restituirStock) y
      // marcar el pedido CANCELLED cuando el pago se rechaza/cancela en MP.
      // MVP: solo lo dejamos loggeado; el pedido queda PENDING/PENDING y el
      // cliente puede reintentar el pago (o un cron de expiración lo cancela).
      this.logger.log(
        `Pago ${payment.gatewayPaymentId} del pedido ${order.order_id} en estado ${payment.status} (sin acción, ver TODO)`,
      );
      return;
    }

    this.logger.debug(
      `Pago ${payment.gatewayPaymentId} del pedido ${order.order_id} en estado ${payment.status} (aún no definitivo)`,
    );
  }

  /**
   * Marca el pedido como pagado (dentro de una transacción con lock pesimista,
   * para que dos notificaciones concurrentes del MISMO pago no pasen ambas el
   * chequeo de idempotencia) y, recién tras el commit, dispara el despacho
   * best-effort. Si el pedido ya está PAID o ya tiene `gatewayPaymentId`
   * (reintento de MP), no hace nada — evita doble despacho.
   */
  private async handleApproved(order: Order, paymentId: string): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let alreadyConfirmed = false;
    try {
      const locked = await queryRunner.manager
        .createQueryBuilder(Order, 'order')
        .setLock('pessimistic_write')
        .where('order.order_id = :id', { id: order.order_id })
        .getOne();

      if (!locked) {
        await queryRunner.commitTransaction();
        this.logger.warn(
          `Pedido ${order.order_id} desapareció antes de confirmar el pago`,
        );
        return;
      }

      if (isTerminal(locked.status)) {
        // Pedido ya CANCELLED/DELIVERED: un pago que llega tarde (ej. seña de
        // una reserva ya expirada por el cron, o pedido cancelado por el
        // cliente antes del webhook) NO debe re-despachar ni marcar PAID — el
        // stock ya pudo haberse restituido. No-op idempotente.
        alreadyConfirmed = true;
        await queryRunner.commitTransaction();
        this.logger.warn(
          `Pago ${paymentId} de un pedido ${locked.status} (${locked.order_id}): ignorado (sin despacho)`,
        );
      } else if (locked.gatewayPaymentId) {
        alreadyConfirmed = true;
        await queryRunner.commitTransaction();
      } else if (locked.status === OrderStatus.RESERVED) {
        // Pago de la SEÑA de una reserva: se marca deposit_paid (no PAID: el
        // saldo se cobra al entregar) y NO se despacha — el cron activará la
        // reserva el día agendado.
        locked.deposit_paid = true;
        locked.gatewayPaymentId = paymentId;
        await queryRunner.manager.save(locked);
        await queryRunner.commitTransaction();
        this.logger.log(
          `Seña de la reserva ${locked.order_id} pagada (MercadoPago ${paymentId})`,
        );
        return; // no despachar: lo hace el cron de reservas el día agendado
      } else if (locked.paymentStatus === PaymentStatus.PAID) {
        alreadyConfirmed = true;
        await queryRunner.commitTransaction();
      } else {
        locked.paymentStatus = PaymentStatus.PAID;
        locked.gatewayPaymentId = paymentId;
        await queryRunner.manager.save(locked);
        await queryRunner.commitTransaction();
      }
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    if (alreadyConfirmed) {
      this.logger.debug(
        `Pedido ${order.order_id} ya estaba confirmado (idempotencia webhook, pago ${paymentId})`,
      );
      return;
    }

    this.logger.log(
      `Pedido ${order.order_id} confirmado como PAGADO (MercadoPago ${paymentId}) → despachando`,
    );

    // Best-effort, fuera de la transacción: `order` (con relaciones completas
    // de findByIdFull) se usa solo para armar el payload del despacho.
    order.paymentStatus = PaymentStatus.PAID;
    order.gatewayPaymentId = paymentId;
    await this.dispatchOrchestrator
      .offerToNextDriver(order)
      .catch((error: unknown) =>
        this.logger.error(
          `Falló el despacho post-pago del pedido ${order.order_id}: ${errorMessage(error)}`,
        ),
      );
  }
}
