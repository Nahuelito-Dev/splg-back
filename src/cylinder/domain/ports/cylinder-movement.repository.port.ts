import type { MovimientoDeEnvase } from '../envase';
import type { Transaccion } from './unit-of-work.port';

/** PUERTO del historial de movimientos del envase: sólo se agrega, nunca se edita. */
export abstract class CylinderMovementRepositoryPort {
  /** Con `tx`, dentro de esa transacción. */
  abstract registrar(
    movimiento: MovimientoDeEnvase,
    tx?: Transaccion,
  ): Promise<void>;
}
