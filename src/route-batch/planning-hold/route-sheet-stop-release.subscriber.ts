import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntitySubscriberInterface,
  QueryRunner,
  TransactionCommitEvent,
  TransactionRollbackEvent,
  UpdateEvent,
} from 'typeorm';
import { Order, OrderStatus } from '../../order/entities/order.entity';
import { RouteStopRemovedReason } from '../../order/entities/route-batch-stop.entity';
import { errorMessage } from '../../common/errors/error-message';

/** Estados con los que el pedido ya no se reparte en una hoja de ruta. */
const SALE_DE_LA_HOJA: Partial<Record<OrderStatus, RouteStopRemovedReason>> = {
  [OrderStatus.CANCELLED]: RouteStopRemovedReason.CANCELLED,
  [OrderStatus.DELIVERED]: RouteStopRemovedReason.UNAVAILABLE,
};

/** Evento (después del commit) de una parada de una hoja EN CURSO que cambió. */
export const EVENTO_PARADA_EN_CURSO = 'hoja-de-ruta.parada-en-curso';

/**
 * Qué le pasó al pedido de una parada de una hoja en curso:
 *  - `cancelled`, `released` (el chofer o un admin lo liberó) y `reassigned`
 *    (se lo asignaron a otro chofer): la parada sale de la hoja;
 *  - `delivered` y `on_the_way`: la parada sigue; la hoja avanza.
 */
export type CausaDeCambio =
  | 'cancelled'
  | 'released'
  | 'reassigned'
  | 'delivered'
  | 'on_the_way';

export interface ParadaEnCursoCambiada {
  batchId: string;
  orderId: string;
  cause: CausaDeCambio;
}

const ESTADOS_DEL_CHOFER: readonly OrderStatus[] = [
  OrderStatus.ACCEPTED,
  OrderStatus.ON_THE_WAY,
];

/**
 * Qué pasó con el pedido de una parada de una hoja en curso, o `null` si el
 * cambio no le importa a la hoja. Pura (la prueba el spec).
 */
export function causaEnCurso(
  antes: { status: OrderStatus; deliveryId: string | null },
  despues: { status: OrderStatus; deliveryId: string | null },
): CausaDeCambio | null {
  if (despues.status === OrderStatus.CANCELLED) {
    return antes.status === OrderStatus.CANCELLED ? null : 'cancelled';
  }
  if (
    despues.status === OrderStatus.PENDING &&
    ESTADOS_DEL_CHOFER.includes(antes.status)
  ) {
    return 'released';
  }
  if (
    despues.status === OrderStatus.ACCEPTED &&
    despues.deliveryId !== null &&
    antes.deliveryId !== despues.deliveryId
  ) {
    return 'reassigned';
  }
  if (despues.status === antes.status) return null;
  if (despues.status === OrderStatus.DELIVERED) return 'delivered';
  if (despues.status === OrderStatus.ON_THE_WAY) return 'on_the_way';
  return null;
}

const MOTIVO_EN_CURSO: Partial<Record<CausaDeCambio, RouteStopRemovedReason>> =
  {
    cancelled: RouteStopRemovedReason.CANCELLED,
    // Liberado por fuera de la hoja: espera al admin (no vuelve solo al despacho).
    released: RouteStopRemovedReason.NEEDS_RESCHEDULE,
    reassigned: RouteStopRemovedReason.REASSIGNED,
  };

/**
 * Las paradas de las hojas de ruta siguen a su pedido, en la misma transacción
 * que el cambio de estado (toda transición se guarda con `save`, ver
 * `OrderStatusHistorySubscriber`, así que ningún camino se lo saltea):
 *
 *  - Hoja en borrador o confirmada: un pedido que se cancela o se entrega sale
 *    de la hoja (baja lógica con su motivo).
 *  - Hoja en curso (`assigned`, E4): un pedido cancelado, liberado por fuera
 *    de la hoja (queda esperando al admin: `needs_reschedule`) o asignado a
 *    otro chofer sale de la hoja con su motivo; uno
 *    entregado o en camino se queda. En los dos casos, DESPUÉS del commit se
 *    emite `EVENTO_PARADA_EN_CURSO` para que la ejecución reordene, recalcule
 *    la hora estimada y avise (lo que no puede ir en la transacción del pedido).
 *    La red, si el evento se pierde, es el seguimiento cada minuto
 *    (`route_sheet_watch`).
 *
 * Una parada que la ejecución ya sacó (con su propio motivo y nota) no se pisa:
 * las bajas sólo tocan paradas activas.
 */
@Injectable()
export class RouteSheetStopReleaseSubscriber
  implements EntitySubscriberInterface<Order>
{
  private readonly logger = new Logger(RouteSheetStopReleaseSubscriber.name);
  /** Eventos que esperan el commit de su transacción. */
  private readonly pendientes = new WeakMap<
    QueryRunner,
    ParadaEnCursoCambiada[]
  >();

  constructor(
    @InjectDataSource() dataSource: DataSource,
    private readonly events: EventEmitter2,
  ) {
    dataSource.subscribers.push(this);
  }

  listenTo() {
    return Order;
  }

  async afterUpdate(event: UpdateEvent<Order>): Promise<void> {
    const order = event.entity as Order | undefined;
    const anterior = event.databaseEntity as Order | undefined;
    if (!order?.status || !anterior) return;
    const orderId = order.orderId ?? anterior.orderId;

    if (order.status !== anterior.status) {
      const motivo = SALE_DE_LA_HOJA[order.status];
      if (motivo) {
        await event.manager.query(
          `UPDATE "route_batch_stop" s
              SET "active" = false, "removed_reason" = $2, "removed_at" = now()
             FROM "route_batch" b
            WHERE b."batch_id" = s."batch_id" AND s."order_id" = $1 AND s."active"
              AND b."kind" = 'planned' AND b."status" IN ('draft', 'confirmed')`,
          [orderId, motivo],
        );
      }
    }

    const causa = causaEnCurso(
      { status: anterior.status, deliveryId: anterior.deliveryId ?? null },
      { status: order.status, deliveryId: order.deliveryId ?? null },
    );
    if (!causa) return;
    const baja = MOTIVO_EN_CURSO[causa];
    // Un UPDATE con RETURNING devuelve [filas, cantidad]; un SELECT, las filas.
    const filas: Array<{ batchId: string }> = baja
      ? (
          await event.manager.query<[Array<{ batchId: string }>, number]>(
            `UPDATE "route_batch_stop" s
              SET "active" = false, "removed_reason" = $2, "removed_at" = now()
             FROM "route_batch" b
            WHERE b."batch_id" = s."batch_id" AND s."order_id" = $1 AND s."active"
              AND b."kind" = 'planned' AND b."status" = 'assigned'
              AND ($3::uuid IS NULL OR b."delivery_id" IS DISTINCT FROM $3::uuid)
          RETURNING s."batch_id" AS "batchId"`,
            [orderId, baja, causa === 'reassigned' ? order.deliveryId : null],
          )
        )[0]
      : await event.manager.query(
          `SELECT s."batch_id" AS "batchId" FROM "route_batch_stop" s
             JOIN "route_batch" b ON b."batch_id" = s."batch_id"
            WHERE s."order_id" = $1 AND s."active"
              AND b."kind" = 'planned' AND b."status" = 'assigned'`,
          [orderId],
        );
    if (filas.length === 0) return;
    const cambios = filas.map((f) => ({
      batchId: f.batchId,
      orderId,
      cause: causa,
    }));
    const qr = event.queryRunner;
    if (qr?.isTransactionActive) {
      this.pendientes.set(qr, [...(this.pendientes.get(qr) ?? []), ...cambios]);
    } else {
      this.emitir(cambios);
    }
  }

  afterTransactionCommit(event: TransactionCommitEvent): void {
    const cambios = this.pendientes.get(event.queryRunner);
    if (!cambios) return;
    this.pendientes.delete(event.queryRunner);
    this.emitir(cambios);
  }

  afterTransactionRollback(event: TransactionRollbackEvent): void {
    this.pendientes.delete(event.queryRunner);
  }

  private emitir(cambios: readonly ParadaEnCursoCambiada[]): void {
    for (const c of cambios) {
      try {
        this.events.emit(EVENTO_PARADA_EN_CURSO, c);
      } catch (error) {
        this.logger.warn(
          `Hoja ${c.batchId}: no se pudo avisar el cambio del pedido ${c.orderId}: ${errorMessage(error)}`,
        );
      }
    }
  }
}
