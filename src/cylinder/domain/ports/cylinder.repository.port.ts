import type { Envase, NuevoEnvase } from '../envase';
import type { Transaccion } from './unit-of-work.port';

/**
 * PUERTO de persistencia del agregado `Envase`. Los casos de uso hablan con
 * esta interfaz; el adaptador TypeORM resuelve el cómo (tablas, locks, SQL).
 * Las lecturas "bloquear" dejan la fila tomada (`FOR UPDATE`) hasta el final
 * de la transacción.
 */
export abstract class CylinderRepositoryPort {
  /**
   * Guarda un envase nuevo. Si el serial ya existe en la distribuidora lanza
   * `EnvaseEnConflictoError`.
   */
  abstract crear(nuevo: NuevoEnvase): Promise<Envase>;

  /** El pedido al que está atado el envase, sin bloquearlo; `null` si no existe en la distribuidora. */
  abstract verPedidoActual(
    tx: Transaccion,
    cylinderId: string,
    distributorId: string,
  ): Promise<{ currentOrderId: string | null } | null>;

  /** El envase de la distribuidora, bloqueado; `null` si no existe. */
  abstract bloquear(
    tx: Transaccion,
    cylinderId: string,
    distributorId: string,
  ): Promise<Envase | null>;

  /**
   * Los envases de la distribuidora con esos seriales (comparados en su forma
   * canónica), bloqueados en un orden fijo para que dos cargas cruzadas no se
   * traben entre sí. Devuelve sólo los que existen.
   */
  abstract bloquearPorSerial(
    tx: Transaccion,
    serials: string[],
    distributorId: string,
  ): Promise<Envase[]>;

  /** Los envases despachados en ese pedido, bloqueados. */
  abstract bloquearDespachadosDelPedido(
    tx: Transaccion,
    orderId: string,
    distributorId?: string | null,
  ): Promise<Envase[]>;

  /**
   * Guarda los cambios del envase y lo devuelve como quedó. Si el serial ya
   * existe en la distribuidora lanza `EnvaseEnConflictoError`.
   */
  abstract guardar(tx: Transaccion, envase: Envase): Promise<Envase>;
}
