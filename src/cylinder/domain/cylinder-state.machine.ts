import { CylinderState } from '../entities/cylinder.entity';
import { InvalidCylinderTransitionError } from './errors/invalid-cylinder-transition.error';

/**
 * Máquina de estados del ciclo de vida FÍSICO del envase (dominio puro).
 *
 * Reglas:
 *  - IN_DEPOT       → FILLED (se carga en planta) | RETIRED (baja)
 *  - FILLED         → DISPATCHED (sale a reparto) | IN_DEPOT (se revierte el llenado)
 *  - DISPATCHED     → WITH_CUSTOMER (se entregó) | IN_DEPOT (volvió sin entregar)
 *  - WITH_CUSTOMER  → EMPTY_RETURNED (el cliente devuelve el envase vacío) | RETIRED (se da
 *                     por perdido: lo decide el administrador en el recupero de envases, CU-108)
 *  - EMPTY_RETURNED → IN_DEPOT (reingresa a depósito para volver a llenarse) | RETIRED (baja)
 *  - RETIRED        → terminal: nunca con un cliente ni en reparto, y no vuelve
 */
export const CYLINDER_TRANSITIONS: Readonly<
  Record<CylinderState, CylinderState[]>
> = {
  [CylinderState.IN_DEPOT]: [CylinderState.FILLED, CylinderState.RETIRED],
  [CylinderState.FILLED]: [CylinderState.DISPATCHED, CylinderState.IN_DEPOT],
  [CylinderState.DISPATCHED]: [
    CylinderState.WITH_CUSTOMER,
    CylinderState.IN_DEPOT,
  ],
  [CylinderState.WITH_CUSTOMER]: [
    CylinderState.EMPTY_RETURNED,
    CylinderState.RETIRED,
  ],
  [CylinderState.EMPTY_RETURNED]: [
    CylinderState.IN_DEPOT,
    CylinderState.RETIRED,
  ],
  [CylinderState.RETIRED]: [],
};

export function canTransition(from: CylinderState, to: CylinderState): boolean {
  return (CYLINDER_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Igual que canTransition pero lanza `InvalidCylinderTransitionError` (dominio
 * puro) con mensaje claro si es inválida. `GlobalExceptionFilter` la mapea a
 * 400, así que el status HTTP no cambia para los callers.
 */
export function assertTransition(from: CylinderState, to: CylinderState): void {
  if (!canTransition(from, to)) {
    throw new InvalidCylinderTransitionError(from, to);
  }
}
