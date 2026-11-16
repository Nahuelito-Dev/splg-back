/**
 * Escritura directa de un estado o un saldo desde un fixture de prueba, saltando
 * los triggers de la base (tanda V2). El bypass es explícito y vale sólo dentro
 * de la transacción de esta llamada (`SET LOCAL`): el back nunca lo usa.
 *
 *  - `splg.bypass_transiciones`: transiciones de estado inválidas;
 *  - `splg.bypass_saldos`: saldo que no cierra con el libro, cobro sin deuda;
 *  - `splg.bypass_reglas`: fechas futuras, odómetros.
 */
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

export type Bypass = 'transiciones' | 'saldos' | 'reglas';

const encender = (runner: QueryRunner, bypass: readonly Bypass[]) =>
  Promise.all(
    bypass.map((b) =>
      runner.query(`SELECT set_config('splg.bypass_${b}', 'on', true)`),
    ),
  );

/**
 * Corre `trabajo` con los bypass encendidos. El `SET LOCAL` queda activo hasta el
 * final de la transacción (los controles de saldo son diferidos y corren en el
 * commit, así que no se puede apagar antes): si el runner no estaba en una
 * transacción abre una propia y el bypass muere con su commit; si ya estaba en
 * una, vale hasta que ella termine.
 */
export async function conBypassEn<T>(
  runner: QueryRunner,
  bypass: readonly Bypass[],
  trabajo: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const propia = !runner.isTransactionActive;
  if (propia) await runner.startTransaction();
  try {
    await encender(runner, bypass);
    const resultado = await trabajo(runner.manager);
    if (propia) await runner.commitTransaction();
    return resultado;
  } catch (error) {
    if (propia) await runner.rollbackTransaction();
    throw error;
  }
}

/** Igual que `conBypassEn`, con un runner propio de la conexión. */
export async function conBypassManager<T>(
  dataSource: DataSource,
  bypass: readonly Bypass[],
  trabajo: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    return await conBypassEn(runner, bypass, trabajo);
  } finally {
    await runner.release();
  }
}

export const conBypass = <T>(
  dataSource: DataSource,
  bypass: readonly Bypass[],
  consulta: string,
  parametros: unknown[] = [],
): Promise<T> =>
  conBypassManager(dataSource, bypass, (manager) =>
    manager.query(consulta, parametros),
  );

/** Forzar un estado inválido en un `UPDATE` de fixture (con un DataSource o un QueryRunner). */
export const forzarEstado = (
  origen: DataSource | QueryRunner,
  consulta: string,
  parametros: unknown[] = [],
): Promise<unknown> =>
  'createQueryRunner' in origen
    ? conBypass(origen, ['transiciones'], consulta, parametros)
    : conBypassEn(origen, ['transiciones'], (manager) =>
        manager.query(consulta, parametros),
      );
