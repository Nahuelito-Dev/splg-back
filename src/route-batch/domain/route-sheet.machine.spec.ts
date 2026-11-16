import { RouteBatchKind, RouteBatchStatus as S } from './route-batch.enums';
import { InvalidRouteBatchTransitionError } from './errors/route-sheet.errors';
import {
  assertTransition,
  canTransition,
  OFFER_TRANSITIONS,
  PLANNED_HOLDING_STATUSES,
  PLANNED_TRANSITIONS,
} from './route-sheet.machine';

const ESTADOS = Object.values(S);
const PLANNED = RouteBatchKind.PLANNED;
const OFFER = RouteBatchKind.OFFER;

describe('máquina de estados del lote de recorrido', () => {
  describe('hoja de ruta (planned)', () => {
    it.each([
      [S.DRAFT, S.CONFIRMED],
      [S.DRAFT, S.DISSOLVED],
      [S.CONFIRMED, S.DRAFT],
      [S.CONFIRMED, S.ASSIGNED],
      [S.CONFIRMED, S.DISSOLVED],
      [S.ASSIGNED, S.COMPLETED],
    ])('%s → %s es válida', (desde, hacia) => {
      expect(canTransition(PLANNED, desde, hacia)).toBe(true);
    });

    it.each([
      [S.DRAFT, S.ASSIGNED, 'no se inicia sin confirmar'],
      [S.DRAFT, S.COMPLETED, 'no se cierra sin iniciar'],
      [S.CONFIRMED, S.COMPLETED, 'no se cierra sin iniciar'],
      [S.ASSIGNED, S.DISSOLVED, 'una hoja en curso no se cancela'],
      [S.ASSIGNED, S.CONFIRMED, 'una hoja en curso no se reabre'],
      [S.ASSIGNED, S.DRAFT, 'una hoja en curso no vuelve a borrador'],
      [S.DISSOLVED, S.DRAFT, 'una cancelada no se reabre'],
      [S.COMPLETED, S.ASSIGNED, 'una cerrada no se reabre'],
      [S.DRAFT, S.OFFERED, 'no pasa a los estados de la oferta'],
      [S.DRAFT, S.FORMING, 'no pasa a los estados de la oferta'],
    ])('%s → %s es inválida (%s)', (desde, hacia) => {
      expect(canTransition(PLANNED, desde, hacia)).toBe(false);
    });

    it('lanza un error de dominio con el estado de origen y de destino', () => {
      expect(() => assertTransition(PLANNED, S.DRAFT, S.ASSIGNED)).toThrow(
        InvalidRouteBatchTransitionError,
      );
      expect(() => assertTransition(PLANNED, S.DRAFT, S.ASSIGNED)).toThrow(
        'La hoja de ruta no puede pasar de draft a assigned',
      );
      expect(() =>
        assertTransition(PLANNED, S.DRAFT, S.CONFIRMED),
      ).not.toThrow();
    });
  });

  describe('lote ofrecido (offer)', () => {
    it.each([
      [S.FORMING, S.OFFERED],
      [S.FORMING, S.DISSOLVED],
      [S.OFFERED, S.ASSIGNED],
      [S.OFFERED, S.DISSOLVED],
      [S.ASSIGNED, S.COMPLETED],
    ])('%s → %s es válida', (desde, hacia) => {
      expect(canTransition(OFFER, desde, hacia)).toBe(true);
    });

    it.each([
      [S.FORMING, S.ASSIGNED],
      [S.FORMING, S.COMPLETED],
      [S.OFFERED, S.FORMING],
      [S.ASSIGNED, S.DISSOLVED],
      [S.DISSOLVED, S.FORMING],
      [S.COMPLETED, S.ASSIGNED],
      [S.FORMING, S.DRAFT],
      [S.OFFERED, S.CONFIRMED],
    ])('%s → %s es inválida', (desde, hacia) => {
      expect(canTransition(OFFER, desde, hacia)).toBe(false);
    });

    it('el mensaje habla del lote, no de la hoja', () => {
      expect(() => assertTransition(OFFER, S.FORMING, S.COMPLETED)).toThrow(
        'El lote no puede pasar de forming a completed',
      );
    });
  });

  it('repetir el mismo estado no es una transición y pasa', () => {
    for (const kind of [OFFER, PLANNED]) {
      for (const estado of ESTADOS) {
        expect(canTransition(kind, estado, estado)).toBe(true);
      }
    }
  });

  it('los estados terminales no salen a ningún lado', () => {
    for (const tabla of [OFFER_TRANSITIONS, PLANNED_TRANSITIONS]) {
      expect(tabla[S.DISSOLVED]).toEqual([]);
      expect(tabla[S.COMPLETED]).toEqual([]);
    }
  });

  it('una hoja retiene sus pedidos en borrador y confirmada, no en curso', () => {
    expect([...PLANNED_HOLDING_STATUSES].sort()).toEqual([
      'confirmed',
      'draft',
    ]);
  });
});
