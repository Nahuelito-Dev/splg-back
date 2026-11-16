/**
 * Fragmentos SQL de la agrupación por recorrido (M4) que comparten las
 * consultas de pedidos disponibles. `columna` es la expresión de la columna
 * `order_id` del pedido que se está filtrando.
 */

/**
 * Dentro de un `Raw` TypeORM entrega la propiedad (`Order.orderId`) sin
 * comillas y sin traducir, y `Order` es palabra reservada: se arma la columna
 * real con el alias de la consulta.
 */
const columnaDelPedido = (propiedad: string): string =>
  `"${propiedad.split('.')[0].replace(/"/g, '')}"."order_id"`;

/** El pedido es parada viva de un lote que se está formando u ofreciendo. */
export const sqlPedidoEnLoteVivo = (columna: string): string =>
  `EXISTS (SELECT 1 FROM "route_batch_stop" s
            JOIN "route_batch" b ON b."batch_id" = s."batch_id"
           WHERE s."order_id" = ${columnaDelPedido(columna)} AND s."active"
             AND b."status" IN ('forming', 'offered'))`;

/**
 * Condición SQL (sobre la expresión `pedido` del `order_id`) de un pedido que
 * salió de una hoja de ruta EN LA CALLE y sigue pendiente sin chofer: el admin
 * lo sacó, se liberó por fuera de la hoja, el sistema no pudo reprogramarlo, o
 * el sistema lo reprogramó solo para otro día (F34: ningún pedido de una hoja
 * vuelve solo al despacho común; el reprogramado espera la planificación de su
 * día o al admin). Lo usan el pool, el despacho automático (M1) y el arranque de
 * pendientes; la propuesta de la planificación NO lo mira (así lo toma). Deja de
 * esperar con un chofer, otra hoja (parada activa) o la cancelación; lo que sacó
 * el admin, también cuando él le cambia la fecha.
 */
export const condicionEsperandoAlAdmin = (pedido: string): string =>
  `EXISTS (SELECT 1 FROM "route_batch_stop" sa
            JOIN "route_batch" ba ON ba."batch_id" = sa."batch_id"
            JOIN "order" oa ON oa."order_id" = sa."order_id"
           WHERE sa."order_id" = ${pedido} AND NOT sa."active"
             AND sa."removed_reason"::text IN ('rescheduled', 'needs_reschedule', 'admin', 'sheet_closed')
             AND ba."kind" = 'planned' AND ba."started_at" IS NOT NULL
             AND sa."removed_at" >= ba."started_at"
             AND oa."status"::text = 'pending' AND oa."delivery_id" IS NULL
             -- Lo que el sistema reprogramó solo (segundo intento, cierre a mano)
             -- espera la planificación del día que le tocó, y lo que espera al
             -- admin sin más (needs_reschedule) lo espera: ninguno de los dos
             -- vuelve al despacho común aunque se le haya movido la fecha. Lo que
             -- sacó el admin deja de esperar cuando él le cambia la fecha.
             AND (sa."removed_reason"::text IN ('needs_reschedule', 'rescheduled', 'sheet_closed')
                  OR oa."scheduled_date" = ba."plan_date")
             AND NOT EXISTS (SELECT 1 FROM "route_batch_stop" sv
                              WHERE sv."order_id" = sa."order_id" AND sv."active"))`;

/**
 * El pedido es parada activa de una hoja de ruta (F34) en borrador o
 * confirmada (lo lleva el chofer de la hoja), o salió de una en la calle y
 * espera al admin: no está en el pool ni se ofrece.
 */
export const sqlPedidoEnHojaDeRuta = (columna: string): string =>
  `(EXISTS (SELECT 1 FROM "route_batch_stop" s
            JOIN "route_batch" b ON b."batch_id" = s."batch_id"
           WHERE s."order_id" = ${columnaDelPedido(columna)} AND s."active"
             AND b."kind" = 'planned' AND b."status" IN ('draft', 'confirmed'))
    OR ${condicionEsperandoAlAdmin(columnaDelPedido(columna))})`;

/**
 * Con M4 encendido en la distribuidora del pedido, un programado estándar al
 * que le falta más que `batchingHoldMinutes` para su franja: es candidato de M4
 * y no se ofrece suelto. Apagado (por omisión) nunca lo retiene.
 */
export const sqlPedidoRetenidoPorAgrupacion = (columna: string): string =>
  `EXISTS (SELECT 1 FROM "order" o2
            JOIN "time_slot" ts ON ts."time_slot_id" = o2."time_slot_id"
            JOIN "module_config" mc ON mc."distributor_id" = o2."distributor_id"
                                   AND mc."module" = 'route_batching'
           WHERE o2."order_id" = ${columnaDelPedido(columna)}
             AND o2."delivery_mode" = 'standard'
             AND o2."scheduled_date" IS NOT NULL
             AND COALESCE((mc."params" ->> 'enabled')::numeric, 0) = 1
             AND COALESCE((mc."params" ->> 'batchingHoldMinutes')::numeric, 60) > 0
             AND now() < ((o2."scheduled_date" + ts."startTime") AT TIME ZONE 'America/Argentina/Buenos_Aires')
                         - make_interval(mins => COALESCE((mc."params" ->> 'batchingHoldMinutes')::numeric, 60)::int))`;
