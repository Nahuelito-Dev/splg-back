import {
  calcularEstadoDeVencimiento,
  diasHastaElVencimiento,
  ExpirationStatus,
} from './expiration-status';

describe('calcularEstadoDeVencimiento', () => {
  const ahora = new Date('2026-09-26T12:00:00Z');

  it('sin fecha límite no hay estado que calcular', () => {
    expect(calcularEstadoDeVencimiento(null, 30, ahora)).toBeNull();
  });

  it('vigente: falta más que el lead time', () => {
    const dueAt = new Date('2026-12-01T00:00:00Z');
    expect(calcularEstadoDeVencimiento(dueAt, 30, ahora)).toBe(
      ExpirationStatus.CURRENT,
    );
  });

  it('por vencer: dentro de la ventana de anticipación', () => {
    const dueAt = new Date('2026-10-10T00:00:00Z'); // 14 días de hoy
    expect(calcularEstadoDeVencimiento(dueAt, 30, ahora)).toBe(
      ExpirationStatus.DUE_SOON,
    );
  });

  it('vencido: la fecha límite ya pasó', () => {
    const dueAt = new Date('2026-09-01T00:00:00Z');
    expect(calcularEstadoDeVencimiento(dueAt, 30, ahora)).toBe(
      ExpirationStatus.EXPIRED,
    );
  });

  it('el límite exacto de la ventana ya es "por vencer"', () => {
    const dueAt = new Date('2026-10-26T12:00:00Z'); // exactamente 30 días
    expect(calcularEstadoDeVencimiento(dueAt, 30, ahora)).toBe(
      ExpirationStatus.DUE_SOON,
    );
  });

  it('el instante mismo del vencimiento todavía no es "vencido"', () => {
    expect(calcularEstadoDeVencimiento(ahora, 30, ahora)).toBe(
      ExpirationStatus.DUE_SOON,
    );
  });

  /**
   * El ejemplo exacto que dio nahue: un documento que vence el 31/12 tiene
   * que seguir vigente hasta terminar ESE día en hora argentina (ART,
   * UTC-3), no hasta las 00:00 UTC (que son las 21:00 ART del 30/12).
   */
  describe('vence al terminar el día en hora argentina, no a las 00:00 UTC', () => {
    const dueAt = new Date('2026-12-31T00:00:00.000Z'); // "vence el 31/12"

    it('a las 21:00 ART del 30/12 (00:00 UTC del 31/12) todavía NO está vencido', () => {
      const alPrincipioDelDiaUtc = new Date('2026-12-31T00:00:00.000Z');
      expect(
        calcularEstadoDeVencimiento(dueAt, 30, alPrincipioDelDiaUtc),
      ).not.toBe(ExpirationStatus.EXPIRED);
    });

    it('a las 23:59 ART del 31/12 (02:59 UTC del 1/1) todavía NO está vencido', () => {
      const casiFinDelDiaArt = new Date('2027-01-01T02:59:59.999Z');
      expect(calcularEstadoDeVencimiento(dueAt, 30, casiFinDelDiaArt)).not.toBe(
        ExpirationStatus.EXPIRED,
      );
    });

    it('a las 00:00 ART del 1/1 (03:00 UTC) ya está vencido: terminó el 31/12 en Argentina', () => {
      const inicioDelDiaSiguienteArt = new Date('2027-01-01T03:00:00.000Z');
      expect(
        calcularEstadoDeVencimiento(dueAt, 30, inicioDelDiaSiguienteArt),
      ).toBe(ExpirationStatus.EXPIRED);
    });
  });
});

describe('diasHastaElVencimiento', () => {
  const ahora = new Date('2026-09-26T00:00:00Z');

  it('null sin fecha límite', () => {
    expect(diasHastaElVencimiento(null, ahora)).toBeNull();
  });

  /**
   * Mide contra `finDeVigenciaEnArgentina` (1/1/2026-10-07T03:00:00Z para un
   * `dueAt` del 6/10), no contra `dueAt` crudo (revisión de vehículo en uso):
   * si no, esta cuenta podía contradecir al estado cerca del límite. 10 días
   * calendario + el día completo y las 3hs del cutoff ART = 12.
   */
  it('positivo si falta', () => {
    expect(
      diasHastaElVencimiento(new Date('2026-10-06T00:00:00Z'), ahora),
    ).toBe(12);
  });

  it('negativo si ya venció', () => {
    expect(
      diasHastaElVencimiento(new Date('2026-09-16T00:00:00Z'), ahora),
    ).toBe(-8);
  });
});
