import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';

/**
 * Condición SQL (sobre el alias `o` de la tabla `order`) de un pedido que
 * espera su nueva visita después de una entrega fallida (C5): pendiente, sin
 * chofer, y o bien decide el admin (`awaiting_admin`), o todavía no empezó la
 * franja del día de la nueva visita (sin franja, el día). Mientras tanto no
 * está en el pool ni se ofrece; al empezar la franja vuelve solo al circuito
 * normal.
 */
export const condicionEsperaNuevaVisita = (o: string): string =>
  `(${o}."revisit_status" IS NOT NULL
    AND ${o}."status"::text = 'pending' AND ${o}."delivery_id" IS NULL
    AND (${o}."revisit_status" = 'awaiting_admin'
         OR now() < ((${o}."scheduled_date" + COALESCE(
              (SELECT nv."startTime" FROM "time_slot" nv WHERE nv."time_slot_id" = ${o}."time_slot_id"),
              time '00:00')) AT TIME ZONE '${ZONA_ARGENTINA}')))`;

/**
 * Lo mismo para un `Raw` de TypeORM sobre `Order.orderId` (entrega la propiedad
 * sin comillas y `Order` es palabra reservada: se arma la columna real).
 */
export const sqlPedidoEsperaNuevaVisita = (columna: string): string =>
  `EXISTS (SELECT 1 FROM "order" onv
            WHERE onv."order_id" = "${columna.split('.')[0].replace(/"/g, '')}"."order_id"
              AND ${condicionEsperaNuevaVisita('onv')})`;
