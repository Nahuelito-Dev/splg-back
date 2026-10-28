import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Order, OrderStatus, PaymentStatus } from '../entities/order.entity';
import { isTerminal } from '../domain/order-status.machine';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { PaymentsService } from '../../payments/application/payments.service';
import { RefundsService } from '../../payments/application/refunds.service';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { NotificationPort } from '../domain/ports/notification.port';
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
    private readonly dispatch: RealtimeDispatchPort,
    private readonly notificationService: NotificationPort,
    private readonly refunds: RefundsService,
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
      if (payment.montoDistinto) {
        // La pasarela aprobó un importe distinto del esperado (el ledger ya
        // quedó marcado): el pedido no se da por pagado ni se despacha hasta
        // que alguien lo revise.
        this.logger.error(
          `Pago ${payment.gatewayPaymentId} del pedido ${order.orderId} aprobado por ${payment.montoDistinto.cobrado} (esperado ${payment.montoDistinto.esperado}): pedido sin despachar, requiere revisión`,
        );
        return;
      }
      await this.handleApproved(order, payment.gatewayPaymentId);
      return;
    }

    if (payment.status === 'rejected' || payment.status === 'cancelled') {
      // TODO: liberar el stock reservado (GasCylinderService.restituirStock) y
      // marcar el pedido CANCELLED cuando el pago se rechaza/cancela en MP.
      // MVP: solo lo dejamos loggeado; el pedido queda PENDING/PENDING y el
      // cliente puede reintentar el pago (o un cron de expiración lo cancela).
      this.logger.log(
        `Pago ${payment.gatewayPaymentId} del pedido ${order.orderId} en estado ${payment.status} (sin acción, ver TODO)`,
      );
      return;
    }

    this.logger.debug(
      `Pago ${payment.gatewayPaymentId} del pedido ${order.orderId} en estado ${payment.status} (aún no definitivo)`,
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
    let senaPagada = false;
    let pagoSobreCancelado = false;
    try {
      const locked = await queryRunner.manager
        .createQueryBuilder(Order, 'order')
        .setLock('pessimistic_write')
        .where('order.orderId = :id', { id: order.orderId })
        .getOne();

      if (!locked) {
        await queryRunner.commitTransaction();
        this.logger.warn(
          `Pedido ${order.orderId} desapareció antes de confirmar el pago`,
        );
        return;
      }

      if (isTerminal(locked.status)) {
        // Pedido ya CANCELLED/DELIVERED: un pago que llega tarde (ej. seña de
        // una reserva ya expirada por el cron, o pedido cancelado por el
        // cliente antes del webhook) NO debe re-despachar ni marcar PAID — el
        // stock ya pudo haberse restituido. No-op idempotente.
        alreadyConfirmed = true;
        pagoSobreCancelado = locked.status === OrderStatus.CANCELLED;
        await queryRunner.commitTransaction();
        this.logger.warn(
          `Pago ${paymentId} de un pedido ${locked.status} (${locked.orderId}): ignorado (sin despacho)`,
        );
      } else if (locked.gatewayPaymentId) {
        alreadyConfirmed = true;
        await queryRunner.commitTransaction();
      } else if (locked.status === OrderStatus.RESERVED) {
        // Pago de la SEÑA de una reserva: se marca deposit_paid (no PAID: el
        // saldo se cobra al entregar) y NO se despacha — el cron activará la
        // reserva el día agendado.
        locked.depositPaid = true;
        locked.gatewayPaymentId = paymentId;
        await queryRunner.manager.save(locked);
        await queryRunner.commitTransaction();
        this.logger.log(
          `Seña de la reserva ${locked.orderId} pagada (MercadoPago ${paymentId})`,
        );
        // No se despacha: lo hace el cron de reservas el día agendado. El
        // aviso sale después de liberar la conexión.
        senaPagada = true;
      } else if (locked.paymentStatus === PaymentStatus.PAID) {
        alreadyConfirmed = true;
        await queryRunner.commitTransaction();
      } else {
        locked.paymentStatus = PaymentStatus.PAID;
        locked.gatewayPaymentId = paymentId;
        // Lo que el remito y el recibo muestran como «Cobrado el».
        locked.paymentConfirmedAt = new Date();
        await queryRunner.manager.save(locked);
        await queryRunner.commitTransaction();
      }
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    if (senaPagada) {
      this.notificarPagoAprobado(order.customerId, order.orderId, true);
      return;
    }

    if (pagoSobreCancelado) {
      // El pago llegó después de la cancelación: la plata quedó cobrada de un
      // pedido que ya no existe, se devuelve (CU-168).
      await this.refunds
        .reintegrarPorCancelacion(order.orderId)
        .catch((error: unknown) =>
          this.logger.error(
            `No se pudo pedir la devolución del pago tardío del pedido ${order.orderId}: ${errorMessage(error)}`,
          ),
        );
    }

    if (alreadyConfirmed) {
      this.logger.debug(
        `Pedido ${order.orderId} ya estaba confirmado (idempotencia webhook, pago ${paymentId})`,
      );
      return;
    }

    this.logger.log(
      `Pedido ${order.orderId} confirmado como PAGADO (MercadoPago ${paymentId}) → despachando`,
    );

    // Best-effort, fuera de la transacción: `order` (con relaciones completas
    // de findByIdFull) se usa solo para armar el payload del despacho.
    order.paymentStatus = PaymentStatus.PAID;
    order.gatewayPaymentId = paymentId;
    await this.dispatchOrchestrator
      .offerToNextDriver(order)
      .catch((error: unknown) =>
        this.logger.error(
          `Falló el despacho post-pago del pedido ${order.orderId}: ${errorMessage(error)}`,
        ),
      );

    // Después del despacho y sin esperarlo: el push no demora ni al despacho
    // ni al webhook (`notificarPagoAprobado` nunca lanza).
    this.notificarPagoAprobado(order.customerId, order.orderId, false);
  }

  /**
   * Avisa al cliente que su pago (o la seña de su reserva) se aprobó, en tiempo
   * real y por push. Sólo se llama en la primera confirmación (no en los
   * reintentos del webhook), NO se espera y nunca lanza: la confirmación ya
   * está hecha. En una seña el pedido sigue con el pago pendiente (queda
   * `depositPaid`), y el evento lo dice con `tipo: 'deposit'`.
   */
  private notificarPagoAprobado(
    customerId: string,
    orderId: string,
    esSena: boolean,
  ): void {
    try {
      this.dispatch.notifyCustomer(customerId, 'order:payment-approved', {
        orderId,
        tipo: esSena ? 'deposit' : 'payment',
        paymentStatus: esSena ? PaymentStatus.PENDING : PaymentStatus.PAID,
        updatedAt: new Date(),
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo emitir order:payment-approved del pedido ${orderId}: ${errorMessage(error)}`,
      );
    }
    try {
      void this.notificationService
        .sendPaymentApprovedPush(customerId, orderId, esSena)
        .catch((error: unknown) =>
          this.logger.warn(
            `No se pudo enviar el push de pago aprobado del pedido ${orderId}: ${errorMessage(error)}`,
          ),
        );
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar el push de pago aprobado del pedido ${orderId}: ${errorMessage(error)}`,
      );
    }
  }
}
