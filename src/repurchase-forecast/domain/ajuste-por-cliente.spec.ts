import {
  MEDIDAS_MINIMAS_DEL_OFFSET,
  OFFSET_MAXIMO_DIAS,
  VIGENCIA_MINIMA_TRAS_EL_AVISO_MS,
  aplicaElOffset,
  aplicarOffset,
  calcularOffset,
  errorContraLaBase,
  momentoDelAviso,
} from './ajuste-por-cliente';
import {
  EstimacionDeRecompra,
  RepurchaseEstimateSource,
} from './estimacion-de-recompra';

const DIA = 86_400_000;
const HORA = 3_600_000;
// 09:00 en Argentina.
const AHORA = new Date('2026-10-31T12:00:00Z');

const estimacion = (
  parcial: Partial<EstimacionDeRecompra> = {},
): EstimacionDeRecompra => ({
  ok: true,
  estimatedAt: new Date(AHORA.getTime() + 5 * DIA),
  source: RepurchaseEstimateSource.DECLARED,
  kgPerDay: 0.5,
  ordersUsed: 1,
  lastDeliveredAt: new Date(AHORA.getTime() - 5 * DIA),
  lastKg: 10,
  ...parcial,
});

describe('calcularOffset', () => {
  it('es el error medio redondeado, con signo', () => {
    expect(calcularOffset([3, 4])).toBe(4);
    expect(calcularOffset([-2, -3, -2])).toBe(-2);
  });

  it('sin medidas suficientes no hay ajuste', () => {
    expect(MEDIDAS_MINIMAS_DEL_OFFSET).toBe(2);
    expect(calcularOffset([])).toBe(0);
    expect(calcularOffset([9])).toBe(0);
  });

  it('queda acotado en el tope, hacia arriba y hacia abajo', () => {
    expect(calcularOffset([40, 50])).toBe(OFFSET_MAXIMO_DIAS);
    expect(calcularOffset([-40, -50])).toBe(-OFFSET_MAXIMO_DIAS);
    expect(calcularOffset([15, 15])).toBe(15);
    expect(calcularOffset([16, 16])).toBe(15);
  });

  it('sólo cuentan las últimas medidas (la más nueva primero)', () => {
    const errores = [2, 2, 2, 2, 2, 2, 14, 14, 14, 14];
    expect(calcularOffset(errores)).toBe(2);
  });

  it('un promedio nulo es 0 y no -0', () => {
    expect(Object.is(calcularOffset([1, -1]), 0)).toBe(true);
  });
});

describe('errorContraLaBase', () => {
  it('descuenta el ajuste que la invitación ya llevaba', () => {
    const predicha = new Date(AHORA.getTime() + 3 * DIA);
    const real = new Date(AHORA.getTime() + 5 * DIA);
    expect(errorContraLaBase(predicha, 0, real)).toBe(2);
    // La predicha ya incluía +3: la base era la de hoy, y el error es de 5 días.
    expect(errorContraLaBase(predicha, 3, real)).toBe(5);
  });
});

describe('aplicaElOffset', () => {
  it('rige con consumo declarado', () => {
    expect(
      aplicaElOffset(
        { source: RepurchaseEstimateSource.DECLARED, ordersUsed: 9 },
        3,
      ),
    ).toBe(true);
  });

  it('rige con una historia que apenas llega al mínimo', () => {
    expect(
      aplicaElOffset(
        { source: RepurchaseEstimateSource.HISTORY, ordersUsed: 3 },
        3,
      ),
    ).toBe(true);
  });

  it('con historia suficiente no rige: el ritmo propio ya corrige', () => {
    expect(
      aplicaElOffset(
        { source: RepurchaseEstimateSource.HISTORY, ordersUsed: 4 },
        3,
      ),
    ).toBe(false);
  });
});

describe('aplicarOffset', () => {
  it('corre la fecha los días del ajuste', () => {
    const r = aplicarOffset(estimacion(), 3, 3);
    expect(r.aplicado).toBe(3);
    expect(r.estimacion.estimatedAt).toEqual(
      new Date(AHORA.getTime() + 8 * DIA),
    );
  });

  it('con un ajuste negativo la adelanta', () => {
    const r = aplicarOffset(estimacion(), -2, 3);
    expect(r.estimacion.estimatedAt).toEqual(
      new Date(AHORA.getTime() + 3 * DIA),
    );
  });

  it('con historia suficiente la estimación no cambia', () => {
    const base = estimacion({
      source: RepurchaseEstimateSource.HISTORY,
      ordersUsed: 8,
    });
    const r = aplicarOffset(base, 10, 3);
    expect(r.aplicado).toBe(0);
    expect(r.estimacion).toBe(base);
  });

  it('un ajuste cero no cambia nada', () => {
    const base = estimacion();
    expect(aplicarOffset(base, 0, 3)).toEqual({
      estimacion: base,
      aplicado: 0,
    });
  });

  it('aunque llegue un valor fuera de tope, se acota', () => {
    const r = aplicarOffset(estimacion(), 99, 3);
    expect(r.aplicado).toBe(OFFSET_MAXIMO_DIAS);
    expect(r.estimacion.estimatedAt).toEqual(
      new Date(AHORA.getTime() + (5 + OFFSET_MAXIMO_DIAS) * DIA),
    );
    expect(aplicarOffset(estimacion(), -99, 3).aplicado).toBe(
      -OFFSET_MAXIMO_DIAS,
    );
  });
});

describe('momentoDelAviso', () => {
  const vence = new Date(AHORA.getTime() + 24 * HORA);

  it('sin franja, a la hora de la corrida', () => {
    expect(momentoDelAviso(AHORA, vence, null)).toEqual(AHORA);
  });

  it('con una franja que empieza más tarde hoy, a su comienzo', () => {
    // 18:00 ART = 21:00Z.
    expect(momentoDelAviso(AHORA, vence, '18:00:00')).toEqual(
      new Date('2026-10-31T21:00:00Z'),
    );
  });

  it('con una franja que ya empezó, ahora', () => {
    expect(momentoDelAviso(AHORA, vence, '08:00')).toEqual(AHORA);
    expect(momentoDelAviso(AHORA, vence, '09:00')).toEqual(AHORA);
  });

  it('si el aviso dejaría la invitación casi sin vigencia, a la hora de la corrida', () => {
    // La franja empieza a las 21:00Z; la invitación vence a las 22:00Z (queda 1 h < 2 h).
    const corta = new Date('2026-10-31T22:00:00Z');
    expect(momentoDelAviso(AHORA, corta, '18:00')).toEqual(AHORA);
  });

  it('con la vigencia mínima justa, todavía se manda en la franja', () => {
    const justa = new Date(
      new Date('2026-10-31T21:00:00Z').getTime() +
        VIGENCIA_MINIMA_TRAS_EL_AVISO_MS,
    );
    expect(momentoDelAviso(AHORA, justa, '18:00')).toEqual(
      new Date('2026-10-31T21:00:00Z'),
    );
  });

  it('nunca después del vencimiento', () => {
    for (const franja of ['00:00', '09:30', '12:00', '18:00', '23:59']) {
      for (const horas of [1, 3, 6, 12, 24]) {
        const v = new Date(AHORA.getTime() + horas * HORA);
        expect(momentoDelAviso(AHORA, v, franja).getTime()).toBeLessThan(
          v.getTime(),
        );
      }
    }
  });

  it('una franja ilegible cae a la hora de la corrida', () => {
    expect(momentoDelAviso(AHORA, vence, 'tarde')).toEqual(AHORA);
  });
});
