import { BadRequestException } from '@nestjs/common';
import { ClaimStatus } from './entities/claim.entity';

/**
 * Máquina de estados del reclamo (CU-025). `claims` es módulo de SOPORTE
 * (`CONVENCIONES.md` §3), así que esto no vive en un `domain/` hexagonal como
 * `order` o `cylinder`: es un archivo plano, sin dependencias de TypeORM, que
 * centraliza la única regla de negocio del módulo y la saca de `ClaimsService`.
 *
 * Reglas:
 *  - PENDING     → IN_PROCESS (el admin toma el reclamo) | RESOLVED | REJECTED
 *  - IN_PROCESS  → RESOLVED | REJECTED
 *  - RESOLVED    → IN_PROCESS (se reabre)
 *  - REJECTED    → IN_PROCESS (se reabre)
 *
 * Ningún camino vuelve a PENDING: ese estado es sólo el de alta (CU-023). Antes
 * de esto, `resolve` aceptaba cualquier `status` del enum sin mirar el estado de
 * partida: un reclamo ya resuelto podía "re-resolverse" infinitas veces, pisando
 * la nota anterior sin dejar rastro (comentario de CU-025 en `splg-docs`). Con
 * la máquina, reabrir es un paso explícito (`PATCH /claims/:id/reopen`).
 */
export const CLAIM_TRANSITIONS: Readonly<Record<ClaimStatus, ClaimStatus[]>> = {
  [ClaimStatus.PENDING]: [
    ClaimStatus.IN_PROCESS,
    ClaimStatus.RESOLVED,
    ClaimStatus.REJECTED,
  ],
  [ClaimStatus.IN_PROCESS]: [ClaimStatus.RESOLVED, ClaimStatus.REJECTED],
  [ClaimStatus.RESOLVED]: [ClaimStatus.IN_PROCESS],
  [ClaimStatus.REJECTED]: [ClaimStatus.IN_PROCESS],
};

export function canTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  // Repetir el estado nunca es una transición (pisaría la nota anterior): la
  // tabla no tiene ninguna de un estado a sí mismo.
  return (CLAIM_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Igual que `canTransition` pero lanza `BadRequestException` (excepción HTTP
 * de Nest: `claims` es módulo de soporte, CONVENCIONES §8) con mensaje claro
 * si la transición es inválida.
 */
export function assertClaimTransition(
  from: ClaimStatus,
  to: ClaimStatus,
): void {
  if (!canTransition(from, to)) {
    throw new BadRequestException(
      `Transición de reclamo inválida: ${from} → ${to}`,
    );
  }
}
