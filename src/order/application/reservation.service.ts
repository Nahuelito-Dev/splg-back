import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  DataSource,
  IsNull,
  LessThan,
  LessThanOrEqual,
  Repository,
} from 'typeorm';

import { Order, OrderStatus, PaymentMethod } from '../entities/order.entity';
import { transitionOrder } from '../domain/order-status.machine';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { errorMessage } from '../../common/errors/error-message';

/**
 * Procesos AUTOMÁTICOS de las pre-reservas (Módulo Inteligente / DSS del scope:
 * el sistema opera sin intervención humana):
 *
 *  - `activateDueReservations` (cron): el día agendado, las reservas con seña
 *    paga pasan RESERVED → PENDING y se despachan solas.
 *  - `expireUnpaidReservations` (cron): las reservas cuya seña no se pagó dentro
 *    del plazo se cancelan y LIBERAN el stock reservado.
 *  - `expireUnpaidMercadoPagoOrders` (cron): pedidos NORMALES (no reserva) con
 *    `paymentMethod=mercadopago` cuyo checkout el cliente nunca pagó quedan
 *    colgados en PENDING con stock reservado para siempre (ver
 *    CreateOrderUseCase: la reserva de stock es previa al pago). Este cron los
 *    cancela pasado un TTL corto y libera el stock.
 *
 * `confirmDeposit` es la única acción humana: el admin confirma la seña cobrada
 * en efectivo (la seña por MP la confirma el webhook automáticamente).
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  /** Horas que una reserva puede esperar el pago de la seña antes de expirar. */
  private readonly depositTtlHours: number;

  /**
   * Minutos que un pedido NORMAL (no reserva) con `paymentMethod=mercadopago`
   * puede esperar el pago del checkout antes de expirar. Corto a propósito
   * (el checkout de MP no dura horas) para no tener stock reservado colgado.
   */
  private readonly mpPendingTtlMinutes: number;

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly orders: OrderRepositoryPort,
    private readonly stock: GasCylinderService,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
    config: ConfigService,
  ) {
    // Validadas y con su valor por defecto en joi.validation.ts.
    this.depositTtlHours = config.getOrThrow<number>(
      'RESERVATION_DEPOSIT_TTL_HOURS',
    );
    this.mpPendingTtlMinutes = config.getOrThrow<number>(
      'ORDER_MERCADOPAGO_PENDING_TTL_MINUTES',
    );
  }

  /**
   * Lista las reservas (pedidos RESERVED) de la distribuidora para el panel,
   * con el cliente, la fecha agendada y el estado de la seña. Ordenadas por
   * fecha agendada ascendente (las más próximas primero).
   */
  async findReservations(distributorId?: string | null) {
    const orders = await this.orderRepository.find({
      where: {
        status: OrderStatus.RESERVED,
        ...(distributorId ? { distributorId } : {}),
      },
      // Historial: el chofer, el cliente o la dirección dados de baja siguen
      // apareciendo en lo que ya pasó (H-74).
      withDeleted: true,
      relations: ['customer', 'items', 'items.gasCylinder'],
      order: { scheduledDate: 'ASC', createdAt: 'DESC' },
    });

    return orders.map((order) => {
      const depositAmount = Number(order.depositAmount ?? 0);
      const total = Number(order.totalAmount);
      return {
        id: order.orderId,
        customerName: order.customer?.fullName ?? null,
        customerPhone: order.customer?.phoneNumber ?? null,
        scheduledDate: order.scheduledDate ?? null,
        paymentMethod: order.paymentMethod,
        total,
        depositAmount,
        depositPaid: !!order.depositPaid,
        remainingBalance: total - (order.depositPaid ? depositAmount : 0),
        createdAt: order.createdAt,
        items: (order.items ?? []).map((item) => ({
          quantity: item.quantity,
          type: item.gasCylinder?.type ?? null,
        })),
      };
    });
  }

  /** Admin confirma la seña cobrada en efectivo. Habilita la activación automática. */
  async confirmDeposit(
    orderId: string,
    distributorId?: string | null,
  ): Promise<Order> {
    const order = await this.orderRepository.findOne({
      where: {
        orderId,
        ...(distributorId ? { distributorId } : {}),
      },
    });
    if (!order) throw new NotFoundException('Reserva no encontrada');
    if (order.status !== OrderStatus.RESERVED) {
      throw new BadRequestException('El pedido no es una reserva pendiente');
    }
    order.depositPaid = true;
    return this.orderRepository.save(order);
  }

  /**
   * CRON: activa las reservas cuyo día llegó y tienen la seña paga.
   * RESERVED → PENDING + despacho automático. Sin intervención humana.
   */
  @Cron('0 */5 * * * *') // cada 5 minutos
  async activateDueReservations(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const due = await this.orderRepository.find({
      where: {
        status: OrderStatus.RESERVED,
        depositPaid: true,
        scheduledDate: LessThanOrEqual(today),
      },
      take: 50,
    });
    if (due.length === 0) return;

    this.logger.log(`Activando ${due.length} reserva(s) con día cumplido`);
    for (const order of due) {
      try {
        transitionOrder(order, OrderStatus.PENDING);
        await this.orderRepository.save(order);
        // Despacho con el pedido completo (coords + items) para armar la oferta.
        const full = await this.orders.findByIdFull(order.orderId);
        if (full) {
          await this.dispatchOrchestrator
            .offerToNextDriver(full)
            .catch(() => undefined);
        }
        this.logger.log(`Reserva ${order.orderId} activada → despachando`);
      } catch (error) {
        this.logger.error(
          `No se pudo activar la reserva ${order.orderId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * CRON: expira las reservas cuya seña no se pagó dentro del plazo.
   * RESERVED (deposit_paid=false, viejas) → CANCELLED + restituye stock.
   */
  @Cron('0 0 * * * *') // cada hora
  async expireUnpaidReservations(): Promise<void> {
    const cutoff = new Date(Date.now() - this.depositTtlHours * 3600 * 1000);
    const stale = await this.orderRepository.find({
      where: {
        status: OrderStatus.RESERVED,
        depositPaid: false,
        createdAt: LessThan(cutoff),
      },
      relations: ['items'],
      take: 50,
    });
    if (stale.length === 0) return;

    this.logger.log(`Expirando ${stale.length} reserva(s) con seña impaga`);
    for (const order of stale) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        transitionOrder(order, OrderStatus.CANCELLED);
        await queryRunner.manager.save(order);
        await this.stock.restituirStock(
          queryRunner.manager,
          (order.items ?? []).map((it) => ({
            gasCylinderId: it.gasCylinderId,
            quantity: it.quantity,
          })),
        );
        await queryRunner.commitTransaction();
        this.logger.log(
          `Reserva ${order.orderId} expirada → cancelada + stock liberado`,
        );
      } catch (error) {
        await queryRunner.rollbackTransaction();
        this.logger.error(
          `No se pudo expirar la reserva ${order.orderId}: ${errorMessage(error)}`,
        );
      } finally {
        await queryRunner.release();
      }
    }
  }

  /**
   * CRON: expira pedidos NORMALES (no reserva) con `paymentMethod=mercadopago`
   * cuyo checkout de MP nunca se pagó. PENDING + `gatewayPaymentId` null
   * (nunca confirmado por el webhook) + más viejo que el TTL → CANCELLED +
   * restituye stock. Sin este cron, el stock reservado por `CreateOrderUseCase`
   * al crear el pedido (ANTES de que el cliente pague, para evitar oversell)
   * queda bloqueado para siempre si el cliente abandona el checkout.
   *
   * Idempotencia / carrera pago-vs-expiración: dentro de la transacción,
   * re-lee el pedido con lock pesimista y solo lo cancela si SIGUE PENDING y
   * sin `gatewayPaymentId` — si el webhook confirmó el pago un instante antes,
   * no lo toca. Si el pago llegara a confirmarse recién DESPUÉS de expirado,
   * `ConfirmPaymentUseCase.handleApproved` ve el pedido en estado terminal
   * (CANCELLED) y no lo reactiva ni despacha (no-op idempotente, ver ese
   * use-case).
   */
  @Cron('0 */30 * * * *') // cada 30 minutos
  async expireUnpaidMercadoPagoOrders(): Promise<void> {
    const cutoff = new Date(Date.now() - this.mpPendingTtlMinutes * 60 * 1000);
    const stale = await this.orderRepository.find({
      where: {
        status: OrderStatus.PENDING,
        paymentMethod: PaymentMethod.MERCADOPAGO,
        gatewayPaymentId: IsNull(),
        createdAt: LessThan(cutoff),
      },
      relations: ['items'],
      take: 50,
    });
    if (stale.length === 0) return;

    this.logger.log(
      `Expirando ${stale.length} pedido(s) MercadoPago sin pagar (TTL ${this.mpPendingTtlMinutes}min)`,
    );
    for (const order of stale) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        // Re-chequeo con lock pesimista: si el webhook confirmó el pago justo
        // antes de este commit, `gatewayPaymentId` ya no es null y no tocamos
        // el pedido (evita la carrera pago-vs-expiración).
        const locked = await queryRunner.manager
          .createQueryBuilder(Order, 'order')
          .setLock('pessimistic_write')
          .where('order.orderId = :id', { id: order.orderId })
          .getOne();

        if (
          !locked ||
          locked.status !== OrderStatus.PENDING ||
          locked.gatewayPaymentId
        ) {
          await queryRunner.commitTransaction();
          continue;
        }

        transitionOrder(locked, OrderStatus.CANCELLED);
        locked.cancellationReason =
          'Pago con MercadoPago no completado dentro del plazo';
        await queryRunner.manager.save(locked);
        await this.stock.restituirStock(
          queryRunner.manager,
          (order.items ?? []).map((it) => ({
            gasCylinderId: it.gasCylinderId,
            quantity: it.quantity,
          })),
        );
        await queryRunner.commitTransaction();
        this.logger.log(
          `Pedido ${order.orderId} expirado (MercadoPago sin pagar) → cancelado + stock liberado`,
        );
      } catch (error) {
        await queryRunner.rollbackTransaction();
        this.logger.error(
          `No se pudo expirar el pedido ${order.orderId}: ${errorMessage(error)}`,
        );
      } finally {
        await queryRunner.release();
      }
    }
  }
}
