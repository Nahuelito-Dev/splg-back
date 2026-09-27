import { MaintenanceCriticality } from '../entities/maintenance-plan.entity';
import { ExpirationStatus } from './expiration-status';

/** Lo mínimo que hace falta de una tarea abierta para decidir si inhabilita. */
export interface HabilitacionRelevante {
  expirationStatus: ExpirationStatus | null;
  criticality: MaintenanceCriticality;
}

/**
 * CU-136/137/138: un vehículo o un chofer queda INHABILITADO cuando tiene al
 * menos una habilitación bloqueante (seguro, VTV, licencia) vencida. Una
 * tarea "por vencer" todavía no bloquea; una no bloqueante (service) nunca
 * bloquea, esté vencida o no.
 *
 * Función de dominio pura, sin acceso a datos: el caller (`FleetTaskService`)
 * arma `HabilitacionRelevante[]` con las tareas abiertas (no `done` ni
 * `cancelled`) del vehículo/chofer y sus planes.
 *
 * IMPORTANTE: hoy esto NO se aplica al despacho (asignar un pedido a un
 * chofer, o un vehículo a una ruta). Lo calcula y lo expone `fleet`; queda
 * para que `order`/`delivery` lo consulten cuando decidan aplicarlo — ver
 * el informe de esta tarea para el punto exacto de enganche.
 */
export function estaInhabilitado(tareas: HabilitacionRelevante[]): boolean {
  return tareas.some(
    (t) =>
      t.criticality === MaintenanceCriticality.BLOCKING &&
      t.expirationStatus === ExpirationStatus.EXPIRED,
  );
}
