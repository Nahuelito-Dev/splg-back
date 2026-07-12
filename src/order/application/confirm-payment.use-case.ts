import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Order, OrderStatus, PaymentStatus } from '../entities/order.entity';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { PaymentGatewayPort } from '../domain/ports/payment-gateway.port';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';

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
 */
@Injectable()
export class ConfirmPaymentUseCase {
  private readonly logger = new Logger(ConfirmPaymentUseCase.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly orders: OrderRepositoryPort,
    private readonly paymentGateway: PaymentGatewayPort,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
  ) {}

  async execute(input: ConfirmPaymentInput): Promise<void> {
    if (input.type !== 'payment' || !input.dataId) {
      // Otros tipos de notificación (merchant_order, etc.) no nos interesan.
      this.logger.debug(`Notificación ignorada (type=${input.type})`);
      return;
    }

    let payment;
    try {
      payment = await this.paymentGateway.getPayment(input.dataId);
    } catch (error: any) {
      this.logger.error(
        `No se pudo consultar el pago ${input.dataId} en MercadoPago: ${error?.message}`,
      );
      return;
    }

    if (!payment.externalReference) {
      this.logger.warn(`Pago ${payment.id} sin external_reference, se ignora`);
      return;
    }

    const order = await this.orders.findByIdFull(payment.externalReference);
    if (!order) {
      this.logger.warn(
        `Pago ${payment.id} referencia un pedido inexistente: ${payment.externalReference}`,
      );
      return;
    }

    if (payment.status === 'approved') {
      await this.handleApproved(order, payment.id);
      return;
    }

    if (payment.status === 'rejected' || payment.status === 'cancelled') {
      // TODO: liberar el stock reservado (StockReservationService.restore) y
      // marcar el pedido CANCELLED cuando el pago se rechaza/cancela en MP.
      // MVP: solo lo dejamos loggeado; el pedido queda PENDING/PENDING y el
      // cliente puede reintentar el pago (o un cron de expiración lo cancela).
      this.logger.log(
        `Pago ${payment.id} del pedido ${order.order_id} en estado ${payment.status} (sin acción, ver TODO)`,
      );
      return;
    }

    this.logger.debug(
      `Pago ${payment.id} del pedido ${order.order_id} en estado ${payment.status} (aún no definitivo)`,
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
        this.logger.warn(`Pedido ${order.order_id} desapareció antes de confirmar el pago`);
        return;
      }

      if (locked.gatewayPaymentId) {
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
      .catch((error: any) =>
        this.logger.error(
          `Falló el despacho post-pago del pedido ${order.order_id}: ${error?.message}`,
        ),
      );
  }
}
