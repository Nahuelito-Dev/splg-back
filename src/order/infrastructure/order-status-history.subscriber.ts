import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
} from 'typeorm';
import { auditContext } from '../../audit/data/audit-context';
import { OrderStatusHistory } from '../entities/order-status-history.entity';
import { Order, OrderStatus } from '../entities/order.entity';

/**
 * Historial de estados del pedido (`order_status_history`): una fila por CADA
 * transición, en la misma transacción que la guarda.
 *
 * Toda transición pasa por `transitionOrder` (la máquina de estados) y se
 * persiste con `save`; este subscriber es el único lugar que las asienta, así
 * que ningún caso de uso presente o futuro puede olvidarse. El alta registra
 * `null → estado inicial`.
 *
 *  - Quién: el usuario del request en curso (contexto de auditoría). Sin
 *    request (crons, webhooks, listeners) queda en null: lo hizo el sistema.
 *  - Motivo: `order.transitionReason` si el caso de uso lo puso (entrega
 *    manual) o, al cancelar, `cancellationReason`.
 *  - Cuándo: `changed_at` (default de la base).
 *
 * Los pedidos anteriores a esta versión no tienen historial de sus
 * transiciones pasadas: no se inventó un backfill. Sólo hay filas desde la
 * migración que lo habilita (ver la sección «Historial de estados» de
 * splg-docs/sistema/back/PEDIDOS.md).
 */
@Injectable()
export class OrderStatusHistorySubscriber
  implements EntitySubscriberInterface<Order>
{
  constructor(@InjectDataSource() dataSource: DataSource) {
    dataSource.subscribers.push(this);
  }

  listenTo() {
    return Order;
  }

  async afterInsert(event: InsertEvent<Order>): Promise<void> {
    const order = event.entity;
    if (!order?.status) return;
    await this.asentar(event, order, null, order.status);
  }

  async afterUpdate(event: UpdateEvent<Order>): Promise<void> {
    const order = event.entity as Order | undefined;
    const anterior = event.databaseEntity as Order | undefined;
    if (!order || !anterior || !order.status) return;
    if (order.status === anterior.status) return;
    await this.asentar(event, order, anterior.status, order.status);
  }

  private async asentar(
    event: InsertEvent<Order> | UpdateEvent<Order>,
    order: Order,
    desde: OrderStatus | null,
    hasta: OrderStatus,
  ): Promise<void> {
    const motivo =
      order.transitionReason ??
      (hasta === OrderStatus.CANCELLED ? order.cancellationReason : null) ??
      null;
    order.transitionReason = undefined;
    await event.manager.insert(OrderStatusHistory, {
      orderId: order.orderId,
      fromStatus: desde,
      toStatus: hasta,
      changedByUserId: auditContext.getStore()?.userId ?? null,
      reason: motivo,
    });
  }
}
