import {
  EstadoDeVigencia,
  calcularVigencia,
  estaVencido,
} from './cylinder-vigencia';
import { finDelDia } from './dia-calendario';

describe('calcularVigencia', () => {
  const ahora = new Date('2026-10-17T12:00:00.000Z');
  const enDias = (n: number) => new Date(ahora.getTime() + n * 86400000);

  it('sin vencimiento cargado es "sin acreditar", no vencido', () => {
    expect(calcularVigencia(null, ahora)).toEqual({
      estado: EstadoDeVigencia.SIN_ACREDITAR,
      diasRestantes: null,
    });
    expect(estaVencido(null, ahora)).toBe(false);
  });

  it('con vencimiento futuro es vigente y cuenta los días', () => {
    expect(calcularVigencia(enDias(10), ahora)).toEqual({
      estado: EstadoDeVigencia.VIGENTE,
      diasRestantes: 10,
    });
  });

  it('cuenta días calendario argentinos, no tramos de 24 h', () => {
    // 22:00 del 17/10 en Buenos Aires.
    const noche = new Date('2026-10-18T01:00:00.000Z');
    expect(calcularVigencia(finDelDia('2026-10-18'), noche).diasRestantes).toBe(
      1,
    );
    expect(calcularVigencia(finDelDia('2026-10-17'), noche).diasRestantes).toBe(
      0,
    );
  });

  it('un vencido hace N días según el calendario, y no queda en -0', () => {
    const ahoraAr = new Date('2026-10-17T15:00:00.000Z');
    expect(
      calcularVigencia(finDelDia('2026-10-12'), ahoraAr).diasRestantes,
    ).toBe(-5);
    expect(Object.is(calcularVigencia(ahora, ahora).diasRestantes, 0)).toBe(
      true,
    );
  });

  describe('borde del día de vencimiento (hora Argentina)', () => {
    const vence = finDelDia('2026-10-20');

    it.each([
      ['00:00 del día', '2026-10-20T03:00:00.000Z'],
      ['21:00 del día (medianoche UTC)', '2026-10-21T00:00:00.000Z'],
      ['23:59 del día', '2026-10-21T02:59:00.000Z'],
    ])('a las %s sigue vigente y vence hoy', (_, instante) => {
      expect(calcularVigencia(vence, new Date(instante))).toEqual({
        estado: EstadoDeVigencia.VIGENTE,
        diasRestantes: 0,
      });
    });

    it('a las 00:00 del día siguiente ya está vencido, hace 1 día', () => {
      expect(
        calcularVigencia(vence, new Date('2026-10-21T03:00:00.000Z')),
      ).toEqual({ estado: EstadoDeVigencia.VENCIDO, diasRestantes: -1 });
    });
  });

  it('el vencimiento exacto ya cuenta como vencido', () => {
    expect(estaVencido(ahora, ahora)).toBe(true);
  });
});
