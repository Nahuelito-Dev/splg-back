import { BadRequestException } from '@nestjs/common';
import { rangoDeDias, rangoDeFiltros } from './rango';

describe('rangoDeFiltros', () => {
  it('sin filtros no acota', () => {
    expect(rangoDeFiltros()).toEqual({ desde: undefined, hasta: undefined });
  });

  it('toma los días completos en hora argentina, con el último inclusivo', () => {
    const { desde, hasta } = rangoDeFiltros('2026-10-01', '2026-10-31');
    expect(desde?.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(hasta?.toISOString()).toBe('2026-11-01T03:00:00.000Z');
  });

  it('el mismo día de inicio y fin es válido', () => {
    expect(() => rangoDeFiltros('2026-10-05', '2026-10-05')).not.toThrow();
  });

  it('el inicio posterior al fin es 400', () => {
    expect(() => rangoDeFiltros('2026-10-06', '2026-10-05')).toThrow(
      BadRequestException,
    );
  });

  it('una fecha imposible es 400', () => {
    expect(() => rangoDeFiltros('2026-02-31', undefined)).toThrow(
      BadRequestException,
    );
  });
});

describe('rangoDeDias', () => {
  it('rechaza el que supera el máximo', () => {
    expect(() => rangoDeDias('2020-01-01', '2026-10-31', 365)).toThrow(
      /no puede superar/,
    );
  });

  it('acepta el que está dentro del máximo', () => {
    expect(() => rangoDeDias('2026-01-01', '2026-10-31', 366)).not.toThrow();
  });
});
