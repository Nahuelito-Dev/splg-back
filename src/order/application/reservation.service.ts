import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, LessThanOrEqual, Repository } from 'typeorm';

import { Order, OrderStatus } from '../entities/order.entity';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { StockReservationService } from '../domain/stock-reservation.service';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';

/**
 * Procesos AUTOMÁTICOS de las pre-reservas (Módulo Inteligente / DSS del scope:
 * el sistema opera sin intervención humana):
 *
 *  - `activateDueReservations` (cron): el día agendado, las reservas con seña
 *    paga pasan RESERVED → PENDING y se despachan solas.
 *  - `expireUnpaidReservations` (cron): las reservas cuya seña no se pagó dentro
 *    del plazo se cancelan y LIBERAN el stock reservado (tapa también el hueco
 *    de pedidos MP que quedaban colgados).
 *
 * `confirmDeposit` es la única acción humana: el admin confirma la seña cobrada
 * en efectivo (la seña por MP la confirma el webhook automáticamente).
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  /** Horas que una reserva puede esperar el pago de la seña antes de expirar. */
  private readonly depositTtlHours = Number(
    process.env.RESERVATION_DEPOSIT_TTL_HOURS ?? 48,
  );

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly orders: OrderRepositoryPort,
    private readonly stock: StockReservationService,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
  ) {}

  /** Admin confirma la seña cobrada en efectivo. Habilita la activación automática. */
  async confirmDeposit(
    orderId: string,
    distributorId?: string | null,
  ): Promise<Order> {
    const order = await this.orderRepository.findOne({
      where: {
        order_id: orderId,
        ...(distributorId ? { distributor_id: distributorId } : {}),
      },
    });
    if (!order) throw new NotFoundException('Reserva no encontrada');
    if (order.status !== OrderStatus.RESERVED) {
      throw new BadRequestException('El pedido no es una reserva pendiente');
    }
    order.deposit_paid = true;
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
        deposit_paid: true,
        scheduled_date: LessThanOrEqual(today),
      },
      take: 50,
    });
    if (due.length === 0) return;

    this.logger.log(`Activando ${due.length} reserva(s) con día cumplido`);
    for (const order of due) {
      try {
        order.status = OrderStatus.PENDING;
        await this.orderRepository.save(order);
        // Despacho con el pedido completo (coords + items) para armar la oferta.
        const full = await this.orders.findByIdFull(order.order_id);
        if (full) {
          await this.dispatchOrchestrator
            .offerToNextDriver(full)
            .catch(() => undefined);
        }
        this.logger.log(`Reserva ${order.order_id} activada → despachando`);
      } catch (error: any) {
        this.logger.error(
          `No se pudo activar la reserva ${order.order_id}: ${error?.message}`,
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
        deposit_paid: false,
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
        order.status = OrderStatus.CANCELLED;
        await queryRunner.manager.save(order);
        await this.stock.restore(
          queryRunner.manager,
          (order.items ?? []).map((it) => ({
            gas_cylinder_id: it.gas_cylinder_id,
            quantity: it.quantity,
          })),
        );
        await queryRunner.commitTransaction();
        this.logger.log(
          `Reserva ${order.order_id} expirada → cancelada + stock liberado`,
        );
      } catch (error: any) {
        await queryRunner.rollbackTransaction();
        this.logger.error(
          `No se pudo expirar la reserva ${order.order_id}: ${error?.message}`,
        );
      } finally {
        await queryRunner.release();
      }
    }
  }
}
