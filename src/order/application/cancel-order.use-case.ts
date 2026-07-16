import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Order, OrderStatus } from '../entities/order.entity';
import { transitionOrder } from '../domain/order-status.machine';
import { StockReservationService } from '../domain/stock-reservation.service';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';

/** Quién dispara la cancelación (define la política de estado y stock). */
export type CancelActor = 'customer' | 'driver' | 'admin' | 'superadmin';

/**
 * Caso de uso: cancelar (o liberar) un pedido.
 *
 * La política depende del actor:
 *  - customer/admin → CANCELLED + restitución de stock.
 *  - driver → NO cancela: libera el pedido a PENDING (re-dispatch) sin tocar stock.
 *
 * La restitución de stock corre en su propia transacción con lock pesimista
 * (StockReservationService). Los avisos de tiempo real son best-effort.
 *
 * Extraído de OrderService para respetar SRP.
 */
@Injectable()
export class CancelOrderUseCase {
  constructor(
    private readonly dataSource: DataSource,
    private readonly stock: StockReservationService,
    private readonly dispatch: RealtimeDispatchPort,
    private readonly orders: OrderRepositoryPort,
  ) {}

  async execute(
    orderId: string,
    userId: string,
    role: CancelActor,
    reason?: string,
  ): Promise<Order> {
    const order = await this.orders.findByIdFull(orderId);
    if (!order) {
      throw new NotFoundException(`Order with ID: ${orderId} not found`);
    }

    if (
      order.status === OrderStatus.DELIVERED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException('No se puede cancelar un pedido finalizado');
    }

    const previousDriverId = order.delivery_id;
    const shouldReturnStock = this.applyCancellationPolicy(order, userId, role);

    // shouldReturnStock ⇔ el pedido quedó CANCELLED (customer/admin); driver solo
    // lo libera a PENDING y no lleva motivo de cancelación.
    if (shouldReturnStock) {
      order.cancellationReason = reason || `Cancelado por ${role}`;
    }

    if (shouldReturnStock) {
      await this.restoreStock(order);
    }

    await this.orders.save(order);
    this.notify(order, role, previousDriverId);

    return order;
  }

  /**
   * Muta el estado del pedido según el actor y devuelve si hay que restituir
   * stock. customer/admin cancelan; driver libera a PENDING para re-dispatch.
   */
  private applyCancellationPolicy(
    order: Order,
    userId: string,
    role: CancelActor,
  ): boolean {
    if (role === 'driver') {
      transitionOrder(order, OrderStatus.PENDING);
      order.delivery_id = null;
      order.acceptedAt = null;
      order.onTheWayAt = null;
      return false;
    }

    if (role === 'customer') {
      if (order.status === OrderStatus.ON_THE_WAY) {
        throw new BadRequestException(
          'El pedido ya está en camino. Contacte al soporte.',
        );
      }
      if (order.customer_id !== userId) {
        throw new BadRequestException('No autorizado');
      }
    }

    // customer (validado) o admin/superadmin → cancelación con devolución.
    transitionOrder(order, OrderStatus.CANCELLED);
    return true;
  }

  /** Devuelve el stock de los ítems del pedido en una transacción con lock. */
  private async restoreStock(order: Order): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await this.stock.restore(queryRunner.manager, order.items);
      await queryRunner.commitTransaction();
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  /** Avisos de tiempo real al cliente y (si corresponde) al chofer previo. */
  private notify(
    order: Order,
    role: CancelActor,
    previousDriverId: string | null,
  ): void {
    const payload = {
      orderId: order.order_id,
      status: order.status,
      reason: order.cancellationReason,
    };

    if (role === 'driver') {
      this.dispatch.notifyCustomer(
        order.customer_id,
        'order:searching-driver',
        payload,
      );
    } else {
      this.dispatch.notifyCustomer(order.customer_id, 'order:cancelled', payload);
    }

    if (previousDriverId && role !== 'driver') {
      this.dispatch.notifyDriverOrderCancelled(previousDriverId, {
        ...payload,
        message: 'El cliente canceló el pedido. No es necesario ir.',
      });
    }

    // Panel admin en vivo. Un chofer liberando el pedido NO es una cancelación
    // (vuelve a PENDING) → solo avisamos a admins la cancelación real.
    if (order.status === OrderStatus.CANCELLED) {
      this.dispatch.notifyAdmins('order:cancelled', {
        orderId: order.order_id,
        status: order.status,
        reason: order.cancellationReason,
      });
    }
  }
}
