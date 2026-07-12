import { BadRequestException } from '@nestjs/common';
import { CylinderState } from '../entities/cylinder.entity';

/**
 * Máquina de estados del ciclo de vida FÍSICO del envase (dominio puro).
 *
 * Reglas:
 *  - IN_DEPOT       → FILLED (se carga en planta)
 *  - FILLED         → DISPATCHED (sale a reparto) | IN_DEPOT (se revierte el llenado)
 *  - DISPATCHED     → WITH_CUSTOMER (se entregó) | IN_DEPOT (volvió sin entregar)
 *  - WITH_CUSTOMER  → EMPTY_RETURNED (el cliente devuelve el envase vacío)
 *  - EMPTY_RETURNED → IN_DEPOT (reingresa a depósito para volver a llenarse)
 */
export const CYLINDER_TRANSITIONS: Readonly<
  Record<CylinderState, CylinderState[]>
> = {
  [CylinderState.IN_DEPOT]: [CylinderState.FILLED],
  [CylinderState.FILLED]: [CylinderState.DISPATCHED, CylinderState.IN_DEPOT],
  [CylinderState.DISPATCHED]: [
    CylinderState.WITH_CUSTOMER,
    CylinderState.IN_DEPOT,
  ],
  [CylinderState.WITH_CUSTOMER]: [CylinderState.EMPTY_RETURNED],
  [CylinderState.EMPTY_RETURNED]: [CylinderState.IN_DEPOT],
};

export function canTransition(
  from: CylinderState,
  to: CylinderState,
): boolean {
  return (CYLINDER_TRANSITIONS[from] ?? []).includes(to);
}

/** Igual que canTransition pero lanza 400 con mensaje claro si es inválida. */
export function assertTransition(
  from: CylinderState,
  to: CylinderState,
): void {
  if (!canTransition(from, to)) {
    throw new BadRequestException(
      `Transición de envase inválida: ${from} → ${to}`,
    );
  }
}
