import { revisionVencida } from './confirmacion-automatica';

describe('revisionVencida', () => {
  const PROPUESTA = Date.parse('2026-11-13T21:00:00Z');
  const MIN = 60_000;

  it('se confirma a los reviewMinutes de la propuesta, no antes', () => {
    const b = { proposedAtMs: PROPUESTA, editedAtMs: null, reabierta: false };
    expect(revisionVencida(b, 60, PROPUESTA + 59 * MIN)).toBe(false);
    expect(revisionVencida(b, 60, PROPUESTA + 60 * MIN)).toBe(true);
  });

  it('con reviewMinutes = 0 se confirma al proponer', () => {
    const b = { proposedAtMs: PROPUESTA, editedAtMs: null, reabierta: false };
    expect(revisionVencida(b, 0, PROPUESTA)).toBe(true);
    expect(revisionVencida(b, 0, PROPUESTA - 1)).toBe(false);
  });

  it('la que el admin editó también se confirma a la hora de la propuesta', () => {
    const b = {
      proposedAtMs: PROPUESTA,
      editedAtMs: PROPUESTA + 50 * MIN,
      reabierta: false,
    };
    expect(revisionVencida(b, 60, PROPUESTA + 60 * MIN)).toBe(true);
  });

  it('la reabierta cuenta la ventana desde su última edición', () => {
    const b = {
      proposedAtMs: PROPUESTA,
      editedAtMs: PROPUESTA + 120 * MIN,
      reabierta: true,
    };
    expect(revisionVencida(b, 60, PROPUESTA + 121 * MIN)).toBe(false);
    expect(revisionVencida(b, 60, PROPUESTA + 180 * MIN)).toBe(true);
  });
});
