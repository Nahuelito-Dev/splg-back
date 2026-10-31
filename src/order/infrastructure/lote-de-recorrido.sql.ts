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
