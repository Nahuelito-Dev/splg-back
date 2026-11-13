import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface, UpdateEvent } from 'typeorm';
import { Order, OrderStatus } from '../../order/entities/order.entity';
import { RouteStopRemovedReason } from '../../order/entities/route-batch-stop.entity';

/** Estados con los que el pedido ya no se reparte en una hoja de ruta. */
const SALE_DE_LA_HOJA: Partial<Record<OrderStatus, RouteStopRemovedReason>> = {
  [OrderStatus.CANCELLED]: RouteStopRemovedReason.CANCELLED,
  [OrderStatus.DELIVERED]: RouteStopRemovedReason.UNAVAILABLE,
};

/**
 * Un pedido que se cancela o se entrega sale de la hoja de ruta en borrador o
 * confirmada en la que estaba (baja lógica de la parada, con su motivo), en la
 * misma transacción que el cambio de estado. Toda transición del pedido se
 * guarda con `save` (ver `OrderStatusHistorySubscriber`), así que ningún camino
 * de cancelación se lo saltea. Las hojas en curso o cerradas no se tocan: ésas
 * las maneja la ejecución (E4).
 */
@Injectable()
export class RouteSheetStopReleaseSubscriber
  implements EntitySubscriberInterface<Order>
{
  constructor(@InjectDataSource() dataSource: DataSource) {
    dataSource.subscribers.push(this);
  }

  listenTo() {
    return Order;
  }

  async afterUpdate(event: UpdateEvent<Order>): Promise<void> {
    const order = event.entity as Order | undefined;
    const anterior = event.databaseEntity as Order | undefined;
    if (!order?.status || !anterior || order.status === anterior.status) {
      return;
    }
    const motivo = SALE_DE_LA_HOJA[order.status];
    if (!motivo) return;
    await event.manager.query(
      `UPDATE "route_batch_stop" s
          SET "active" = false, "removed_reason" = $2, "removed_at" = now()
         FROM "route_batch" b
        WHERE b."batch_id" = s."batch_id" AND s."order_id" = $1 AND s."active"
          AND b."kind" = 'planned' AND b."status" IN ('draft', 'confirmed')`,
      [order.orderId ?? anterior.orderId, motivo],
    );
  }
}
