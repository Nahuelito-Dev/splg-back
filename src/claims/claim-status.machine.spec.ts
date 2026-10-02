import { BadRequestException } from '@nestjs/common';
import { ClaimStatus } from './entities/claim.entity';
import { assertClaimTransition, canTransition } from './claim-status.machine';

/**
 * Máquina de estados del reclamo (CU-025):
 *  PENDING    → IN_PROCESS | RESOLVED | REJECTED
 *  IN_PROCESS → RESOLVED | REJECTED
 *  RESOLVED   → IN_PROCESS (reabrir)
 *  REJECTED   → IN_PROCESS (reabrir)
 */
describe('claim-status.machine', () => {
  describe('canTransition — válidas', () => {
    it.each([
      [ClaimStatus.PENDING, ClaimStatus.IN_PROCESS],
      [ClaimStatus.PENDING, ClaimStatus.RESOLVED],
      [ClaimStatus.PENDING, ClaimStatus.REJECTED],
      [ClaimStatus.IN_PROCESS, ClaimStatus.RESOLVED],
      [ClaimStatus.IN_PROCESS, ClaimStatus.REJECTED],
      [ClaimStatus.RESOLVED, ClaimStatus.IN_PROCESS],
      [ClaimStatus.REJECTED, ClaimStatus.IN_PROCESS],
    ])('permite %s → %s', (from, to) => {
      expect(canTransition(from, to)).toBe(true);
    });
  });

  describe('canTransition — inválidas', () => {
    it.each([
      [ClaimStatus.RESOLVED, ClaimStatus.REJECTED], // ya resuelto no "re-resuelve" a otra cosa
      [ClaimStatus.REJECTED, ClaimStatus.RESOLVED],
      [ClaimStatus.IN_PROCESS, ClaimStatus.PENDING], // nada vuelve a pending
      [ClaimStatus.RESOLVED, ClaimStatus.PENDING],
      [ClaimStatus.REJECTED, ClaimStatus.PENDING],
    ])('rechaza %s → %s', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    });
  });

  describe('repetir el estado', () => {
    it.each(Object.values(ClaimStatus))(
      'no es una transición: %s → %s',
      (estado) => {
        expect(canTransition(estado, estado)).toBe(false);
      },
    );
  });

  describe('assertClaimTransition', () => {
    it('no lanza en una transición válida', () => {
      expect(() =>
        assertClaimTransition(ClaimStatus.PENDING, ClaimStatus.IN_PROCESS),
      ).not.toThrow();
    });

    it('lanza BadRequestException con mensaje claro en una inválida', () => {
      expect(() =>
        assertClaimTransition(ClaimStatus.RESOLVED, ClaimStatus.REJECTED),
      ).toThrow(BadRequestException);
      expect(() =>
        assertClaimTransition(ClaimStatus.RESOLVED, ClaimStatus.REJECTED),
      ).toThrow(/inválida: resolved → rejected/);
    });
  });
});
