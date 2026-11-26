import type { DespachoBloqueadoEvent } from '../events/despacho-bloqueado.event';
import type { EnvaseDevueltoEvent } from '../events/envase-devuelto.event';

/**
 * PUERTO de salida de los eventos de dominio de envases. Quién los escucha
 * (el aviso al panel, el recupero de envases) no es asunto del caso de uso.
 */
export abstract class CylinderEventsPort {
  /** Se rechazó un despacho por envases vencidos. */
  abstract despachoBloqueado(evento: DespachoBloqueadoEvent): void;

  /** Un envase volvió de un cliente. Se publica con la transacción ya confirmada. */
  abstract envaseDevuelto(evento: EnvaseDevueltoEvent): void;
}
