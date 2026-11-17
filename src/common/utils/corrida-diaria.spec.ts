import { tocaCorrerHoy } from './corrida-diaria';

// 09:00 ART = 12:00Z
const A_LAS_9 = new Date('2026-10-31T12:00:00Z');
const A_LAS_10 = new Date('2026-10-31T13:00:00Z');
const A_LAS_8 = new Date('2026-10-31T11:00:00Z');
const DIA_SIGUIENTE = new Date('2026-11-01T12:00:00Z');

describe('tocaCorrerHoy', () => {
  it('a la hora exacta corre', () =>
    expect(tocaCorrerHoy(A_LAS_9, 9, null)).toBe(true));
  it('una hora después sin corrida hoy recupera', () =>
    expect(tocaCorrerHoy(A_LAS_10, 9, '2026-10-30')).toBe(true));
  it('una hora después con corrida hoy no corre', () =>
    expect(tocaCorrerHoy(A_LAS_10, 9, '2026-10-31')).toBe(false));
  it('antes de la hora no corre', () =>
    expect(tocaCorrerHoy(A_LAS_8, 9, null)).toBe(false));
  it('al día siguiente vuelve a correr', () =>
    expect(tocaCorrerHoy(DIA_SIGUIENTE, 9, '2026-10-31')).toBe(true));
});
