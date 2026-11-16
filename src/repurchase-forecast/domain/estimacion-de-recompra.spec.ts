import {
  COEFICIENTE_DE_ESTACIONALIDAD,
  CompraEntregada,
  RepurchaseEstimateSource,
  dentroDeLaVentana,
  diasHasta,
  estimarRecompra,
} from './estimacion-de-recompra';

const DIA = 86_400_000;
const PARAMS = { minOrders: 3, staleDays: 30 };
/** Febrero pesa 0,7 sobre el promedio del año: 2 kg por día reales son 2 / 0,7 de ritmo base. */
const BASE_FEBRERO = 2 / COEFICIENTE_DE_ESTACIONALIDAD[2];

/** Una compra entregada `dias` después del 1/2/2026 (verano: coeficiente parejo) a las 12:00 ART. */
const compra = (dias: number, kg: number): CompraEntregada => ({
  deliveredAt: new Date(Date.UTC(2026, 1, 1, 15) + dias * DIA),
  kg,
});

const dia = (d: Date): string => d.toISOString().slice(0, 10);

describe('estimarRecompra', () => {
  const ahora = new Date(Date.UTC(2026, 1, 20, 15));

  it('sin compras no proyecta, aunque haya consumo declarado', () => {
    expect(estimarRecompra([], 30, ahora, PARAMS)).toEqual({
      ok: false,
      reason: 'no_purchases',
    });
  });

  it('con historia suficiente proyecta con el ritmo de sus compras', () => {
    // 10 kg cada 5 días, tres compras: el gas de la última dura 5 días más.
    const compras = [compra(0, 10), compra(5, 10), compra(10, 10)];
    const r = estimarRecompra(compras, null, ahora, PARAMS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('debería proyectar');
    expect(r.source).toBe(RepurchaseEstimateSource.HISTORY);
    expect(r.ordersUsed).toBe(3);
    expect(dia(r.estimatedAt)).toBe('2026-02-16');
    expect(r.kgPerDay).toBeCloseTo(BASE_FEBRERO, 5);
    expect(r.lastKg).toBe(10);
    expect(r.lastDeliveredAt).toEqual(compras[2].deliveredAt);
  });

  it('pondera por kilos: una compra grande que duró más pesa más', () => {
    const r = estimarRecompra(
      [compra(0, 10), compra(5, 30), compra(20, 10)],
      null,
      new Date(Date.UTC(2026, 1, 25)),
      PARAMS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('debería proyectar');
    // (10 + 30) kg en 20 días = 2 kg por día; los 10 kg de la última duran 5 días.
    expect(r.kgPerDay).toBeCloseTo(BASE_FEBRERO, 5);
    expect(dia(r.estimatedAt)).toBe('2026-02-26');
  });

  it('descarta el intervalo atípico (una compra doble o unas vacaciones)', () => {
    // Intervalos de 5, 5, 5 y uno de 60 días: el último se ignora.
    const compras = [
      compra(0, 10),
      compra(5, 10),
      compra(10, 10),
      compra(15, 10),
      compra(75, 10),
    ];
    const r = estimarRecompra(
      compras,
      null,
      new Date(compra(76, 1).deliveredAt),
      PARAMS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('debería proyectar');
    expect(r.kgPerDay).toBeCloseTo(BASE_FEBRERO, 5);
    expect(r.ordersUsed).toBe(4);
  });

  it('descarta también el intervalo demasiado corto (una compra doble al día siguiente)', () => {
    // Intervalos de 5, 5 y 5 días y una compra repetida un día después de la última.
    const compras = [
      compra(0, 10),
      compra(5, 10),
      compra(10, 10),
      compra(15, 10),
      compra(16, 10),
    ];
    const r = estimarRecompra(
      compras,
      null,
      new Date(compra(17, 1).deliveredAt),
      PARAMS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('debería proyectar');
    expect(r.kgPerDay).toBeCloseTo(BASE_FEBRERO, 5);
    expect(r.ordersUsed).toBe(4);
  });

  it('con un minOrders mayor que 13 igual usa el historial: se miran tantas compras como se pidan', () => {
    const compras = Array.from({ length: 16 }, (_, i) => compra(i * 5, 10));
    const ahoraTarde = new Date(compra(16 * 5, 1).deliveredAt);
    const r = estimarRecompra(compras, null, ahoraTarde, {
      minOrders: 16,
      staleDays: 365,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('debería proyectar');
    expect(r.source).toBe(RepurchaseEstimateSource.HISTORY);
    expect(r.ordersUsed).toBe(16);
  });

  it('con un historial irregular y minOrders alto el motivo es «irregular», no «insuficiente»', () => {
    const compras = Array.from({ length: 16 }, (_, i) => compra(i * i, 10));
    expect(
      estimarRecompra(compras, null, new Date(compra(400, 1).deliveredAt), {
        minOrders: 16,
        staleDays: 5000,
      }),
    ).toEqual({ ok: false, reason: 'irregular_history' });
  });

  it('compras del mismo día cuentan como una sola', () => {
    const doble = [
      compra(0, 5),
      {
        deliveredAt: new Date(compra(0, 1).deliveredAt.getTime() + 3_600_000),
        kg: 5,
      },
      compra(5, 10),
      compra(10, 10),
    ];
    const r = estimarRecompra(doble, null, ahora, PARAMS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('debería proyectar');
    expect(r.ordersUsed).toBe(3);
    expect(r.kgPerDay).toBeCloseTo(BASE_FEBRERO, 5);
  });

  it('ignora lo que todavía no se entregó y los kilos inválidos', () => {
    const r = estimarRecompra(
      [
        compra(0, 10),
        compra(5, 10),
        compra(10, 10),
        compra(40, 10),
        compra(11, 0),
        compra(12, Number.NaN),
      ],
      null,
      ahora,
      PARAMS,
    );
    expect(r.ok && r.ordersUsed).toBe(3);
  });

  it('con pocas compras usa el consumo que declaró desde la última', () => {
    // 60 kg por mes = 2 kg por día; los 10 kg duran 5 días.
    const r = estimarRecompra([compra(10, 10)], 60, ahora, PARAMS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('debería proyectar');
    expect(r.source).toBe(RepurchaseEstimateSource.DECLARED);
    expect(r.kgPerDay).toBeCloseTo(2, 5);
    expect(dia(r.estimatedAt)).toBe('2026-02-16');
    expect(r.ordersUsed).toBe(1);
  });

  it('con pocas compras y sin consumo declarado no tiene con qué', () => {
    expect(estimarRecompra([compra(10, 10)], null, ahora, PARAMS)).toEqual({
      ok: false,
      reason: 'insufficient_history',
    });
    expect(estimarRecompra([compra(10, 10)], 0, ahora, PARAMS)).toEqual({
      ok: false,
      reason: 'insufficient_history',
    });
  });

  it('con una historia irregular recurre al consumo declarado, o no proyecta', () => {
    // Dos intervalos de ritmos muy distintos: ninguno cae cerca de la mediana
    // y sobra uno solo, pero se piden dos.
    const ahoraMarzo = new Date(Date.UTC(2026, 2, 10));
    const irregular = [compra(0, 10), compra(1, 10), compra(30, 10)];
    expect(estimarRecompra(irregular, null, ahoraMarzo, PARAMS)).toEqual({
      ok: false,
      reason: 'irregular_history',
    });
    const conDeclarado = estimarRecompra(irregular, 60, ahoraMarzo, PARAMS);
    expect(conDeclarado.ok && conDeclarado.source).toBe(
      RepurchaseEstimateSource.DECLARED,
    );
  });

  it('descarta al que dejó de comprar: la fecha pasó hace más de staleDays', () => {
    const compras = [compra(0, 10), compra(5, 10), compra(10, 10)];
    // Proyecta el 16/2; 50 días después ya pasaron más de 30.
    const tarde = new Date(compras[2].deliveredAt.getTime() + 60 * DIA);
    expect(estimarRecompra(compras, null, tarde, PARAMS)).toEqual({
      ok: false,
      reason: 'stale',
    });
    // Pasada hace 20 días todavía se proyecta.
    const poco = new Date(compras[2].deliveredAt.getTime() + 25 * DIA);
    expect(estimarRecompra(compras, null, poco, PARAMS).ok).toBe(true);
  });

  it('corrige por estacionalidad: el mismo plazo real es más consumo base en verano que en invierno', () => {
    const enMes =
      (mes: number) =>
      (d: number, kg: number): CompraEntregada => ({
        deliveredAt: new Date(Date.UTC(2026, mes, 1, 15) + d * DIA),
        kg,
      });
    const proyectar = (mes: number) => {
      const c = enMes(mes);
      const r = estimarRecompra(
        [c(0, 10), c(5, 10), c(10, 10)],
        null,
        new Date(Date.UTC(2026, mes, 14)),
        PARAMS,
      );
      if (!r.ok) throw new Error('debería proyectar');
      return r;
    };
    const enero = proyectar(0);
    const julio = proyectar(6);
    // Cada 5 días en ambos casos: la última compra dura 5 días.
    expect(dia(enero.estimatedAt)).toBe('2026-01-16');
    expect(dia(julio.estimatedAt)).toBe('2026-07-16');
    // Pero el ritmo base, el del año promedio, es menor si se consumió en invierno.
    expect(enero.kgPerDay).toBeCloseTo(
      10 / (5 * COEFICIENTE_DE_ESTACIONALIDAD[1]),
      5,
    );
    expect(julio.kgPerDay).toBeCloseTo(
      10 / (5 * COEFICIENTE_DE_ESTACIONALIDAD[7]),
      5,
    );
    expect(julio.kgPerDay).toBeLessThan(enero.kgPerDay);
  });

  it('proyecta aunque la compra cruce de un mes con otro coeficiente', () => {
    // 30 kg al ritmo de 1 kg por día, saltando de enero a febrero.
    const enero = (d: number, kg: number): CompraEntregada => ({
      deliveredAt: new Date(Date.UTC(2026, 0, 1, 15) + d * DIA),
      kg,
    });
    const r = estimarRecompra(
      [enero(0, 30), enero(30, 30), enero(60, 30)],
      null,
      new Date(Date.UTC(2026, 2, 5)),
      PARAMS,
    );
    expect(r.ok).toBe(true);
  });

  it('acota la proyección de un consumo ínfimo', () => {
    const r = estimarRecompra(
      [compra(0, 0.0001), compra(5, 0.0001), compra(10, 100000)],
      null,
      ahora,
      { minOrders: 3, staleDays: 5000 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('debería proyectar');
    expect(
      r.estimatedAt.getTime() - r.lastDeliveredAt.getTime(),
    ).toBeLessThanOrEqual(730 * DIA);
  });
});

describe('dentroDeLaVentana y diasHasta', () => {
  const ahora = new Date('2026-10-31T12:00:00Z');

  it('entra a la ventana cuando faltan hasta avisoDias, y también si ya se pasó', () => {
    expect(dentroDeLaVentana(new Date('2026-11-03T12:00:00Z'), 3, ahora)).toBe(
      true,
    );
    expect(dentroDeLaVentana(new Date('2026-11-03T12:00:01Z'), 3, ahora)).toBe(
      false,
    );
    expect(dentroDeLaVentana(new Date('2026-10-20T12:00:00Z'), 3, ahora)).toBe(
      true,
    );
  });

  it('cuenta los días que faltan, negativos si ya pasó', () => {
    expect(diasHasta(new Date('2026-11-02T12:00:00Z'), ahora)).toBe(2);
    expect(diasHasta(new Date('2026-10-30T00:00:00Z'), ahora)).toBe(-1.5);
  });
});
