import type { EntityManager } from 'typeorm';

/**
 * La hora de la base de datos. Las marcas de tiempo que otros módulos comparan
 * entre sí (`acceptedAt`, `onTheWayAt` y `deliveredAt` del pedido contra
 * `opened_at`, `departed_at`, `returned_at` y `closed_at` de la carga del camión, y
 * el `occurred_at` de los movimientos del libro de stock) salen todas del mismo
 * reloj: el del servidor de Postgres, no el de cada instancia de Node. Así un
 * servidor desfasado no deja una entrega adentro o afuera de la ventana de la carga.
 * `clock_timestamp()` y no `now()`: este último es el inicio de la transacción.
 */
export async function ahoraDeLaBase(manager: EntityManager): Promise<Date> {
  const [{ ahora }]: Array<{ ahora: Date }> = await manager.query(
    `SELECT clock_timestamp() AS ahora`,
  );
  return ahora;
}
