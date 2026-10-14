import { EntityManager } from 'typeorm';

/**
 * El reloj de la base: el único que se usa para todo lo que se compara contra
 * `occurred_at` del libro (apertura, salida, vuelta y cierre de una carga, y los
 * movimientos mismos). Un reloj solo evita que un servidor desfasado deje una
 * entrega adentro o afuera de la ventana de la carga. `clock_timestamp()` y no
 * `now()`: este último es el inicio de la transacción.
 */
export async function ahoraDeLaBase(manager: EntityManager): Promise<Date> {
  const [{ ahora }]: Array<{ ahora: Date }> = await manager.query(
    `SELECT clock_timestamp() AS ahora`,
  );
  return ahora;
}
