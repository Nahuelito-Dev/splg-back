import { BadRequestException } from '@nestjs/common';
import { mesDe, periodoDe, PERIODO_MAXIMO_DIAS } from './periodo';

// 14/11/2026 a las 10:00 de Argentina (13:00 UTC).
const AHORA = new Date('2026-11-14T13:00:00Z');

describe('periodoDe (métricas de plataforma)', () => {
  it('sin fechas: el mes en curso hasta hoy, en hora argentina', () => {
    const p = periodoDe(undefined, undefined, AHORA);
    expect(p).toEqual({
      from: '2026-11-01',
      to: '2026-11-14',
      desde: new Date('2026-11-01T03:00:00Z'),
      hasta: new Date('2026-11-15T03:00:00Z'),
    });
  });

  it('el 1 a las 00:30 de Argentina todavía es el mes nuevo (no el anterior por UTC)', () => {
    const p = periodoDe(undefined, undefined, new Date('2026-12-01T03:30:00Z'));
    expect([p.from, p.to]).toEqual(['2026-12-01', '2026-12-01']);
  });

  it('con sólo «hasta»: desde el primero de ese mes', () => {
    const p = periodoDe(undefined, '2026-10-20', AHORA);
    expect([p.from, p.to]).toEqual(['2026-10-01', '2026-10-20']);
  });

  it('con sólo «desde»: hasta hoy', () => {
    const p = periodoDe('2026-09-15', undefined, AHORA);
    expect([p.from, p.to]).toEqual(['2026-09-15', '2026-11-14']);
  });

  it('un día suelto abarca ese día entero', () => {
    const p = periodoDe('2026-11-03', '2026-11-03', AHORA);
    expect(p.hasta.getTime() - p.desde.getTime()).toBe(24 * 3600_000);
  });

  it.each([
    ['desde posterior a hasta', '2026-11-10', '2026-11-01'],
    ['fecha imposible', '2026-02-30', '2026-03-01'],
  ])('%s: 400', (_caso, from, to) => {
    expect(() => periodoDe(from, to, AHORA)).toThrow(BadRequestException);
  });

  it(`hasta ${PERIODO_MAXIMO_DIAS} días entra; uno más es 400`, () => {
    expect(periodoDe('2025-11-14', '2026-11-14', AHORA).from).toBe(
      '2025-11-14',
    );
    expect(() => periodoDe('2025-11-13', '2026-11-14', AHORA)).toThrow(
      BadRequestException,
    );
  });
});

describe('mesDe', () => {
  it('sin mes: el mes en curso en Argentina', () => {
    expect(mesDe(undefined, AHORA)).toEqual({
      month: '2026-11',
      desde: new Date('2026-11-01T03:00:00Z'),
      hasta: new Date('2026-12-01T03:00:00Z'),
    });
  });

  it('diciembre termina el 1 de enero', () => {
    expect(mesDe('2026-12', AHORA).hasta).toEqual(
      new Date('2027-01-01T03:00:00Z'),
    );
  });

  it('un mes inválido es 400', () => {
    expect(() => mesDe('2026-13', AHORA)).toThrow(BadRequestException);
  });
});
