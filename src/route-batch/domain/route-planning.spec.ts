import {
  armarGrupo,
  DistanciaEntrePedidos,
  FACTOR_DE_CALLES,
  MINUTOS_DE_SERVICIO,
  ordenarParadas,
  ParametrosDeAgrupacion,
  PedidoCandidato,
  pesoTotal,
  VELOCIDAD_MEDIA_KMH,
} from './route-planning';

const MIN = 60_000;
const HORA = 60 * MIN;
// 03/11/2026 08:00 hora argentina = 11:00 UTC.
const OCHO = Date.UTC(2026, 10, 3, 11, 0, 0);

const pedido = (
  orderId: string,
  over: Partial<PedidoCandidato> = {},
): PedidoCandidato => ({
  orderId,
  slotStartMs: OCHO,
  slotEndMs: OCHO + 4 * HORA,
  weightKg: 10,
  createdAtMs: 1,
  ...over,
});

/** Distancias simétricas por par; lo que no se declara está lejísimos. */
const distanciasDe = (pares: Record<string, number>): DistanciaEntrePedidos => {
  return (a, b) => {
    if (a === b) return 0;
    return pares[`${a}|${b}`] ?? pares[`${b}|${a}`] ?? 999;
  };
};

const params: ParametrosDeAgrupacion = {
  maxBatchSize: 4,
  groupingRadiusKm: 3,
  slotToleranceMinutes: 60,
};

const ids = (g: PedidoCandidato[]) => g.map((p) => p.orderId);

describe('armarGrupo (CU-107, pasos 3 a 5)', () => {
  it('junta los pedidos que están dentro del radio de la semilla', () => {
    const a = pedido('a');
    const b = pedido('b');
    const c = pedido('c');
    const d = distanciasDe({ 'a|b': 1, 'a|c': 2.9, 'b|c': 2 });
    expect(ids(armarGrupo(a, [b, c], params, d, null))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('deja afuera al que está más lejos que el radio', () => {
    const a = pedido('a');
    const b = pedido('b');
    const c = pedido('c');
    const d = distanciasDe({ 'a|b': 1, 'a|c': 3.1, 'b|c': 1 });
    expect(ids(armarGrupo(a, [b, c], params, d, null))).toEqual(['a', 'b']);
  });

  it('el radio rige entre TODAS las paradas del lote, no sólo contra la semilla', () => {
    const a = pedido('a');
    const b = pedido('b');
    const c = pedido('c');
    // c está cerca de a (2 km) pero lejos de b (5 km): b y c no pueden ir juntos.
    const d = distanciasDe({ 'a|b': 2, 'a|c': 2.5, 'b|c': 5 });
    const grupo = ids(armarGrupo(a, [b, c], params, d, null));
    expect(grupo).toEqual(['a', 'b']);
  });

  it('descarta las franjas que difieren más que la tolerancia', () => {
    const a = pedido('a');
    const dentro = pedido('dentro', { slotStartMs: OCHO + 60 * MIN });
    const fuera = pedido('fuera', { slotStartMs: OCHO + 61 * MIN });
    const d = distanciasDe({ 'a|dentro': 1, 'a|fuera': 1, 'dentro|fuera': 1 });
    expect(ids(armarGrupo(a, [dentro, fuera], params, d, null))).toEqual([
      'a',
      'dentro',
    ]);
  });

  it('con tolerancia 0 sólo entran pedidos de la misma franja', () => {
    const a = pedido('a');
    const igual = pedido('igual');
    const otra = pedido('otra', { slotStartMs: OCHO + 4 * HORA });
    const d = distanciasDe({ 'a|igual': 1, 'a|otra': 1, 'igual|otra': 1 });
    expect(
      ids(
        armarGrupo(
          a,
          [igual, otra],
          { ...params, slotToleranceMinutes: 0 },
          d,
          null,
        ),
      ),
    ).toEqual(['a', 'igual']);
  });

  it('no pasa del tamaño máximo del lote', () => {
    const a = pedido('a');
    const resto = ['b', 'c', 'd', 'e'].map((id) => pedido(id));
    const d = distanciasDe({
      'a|b': 1,
      'a|c': 1,
      'a|d': 1,
      'a|e': 1,
      'b|c': 1,
      'b|d': 1,
      'b|e': 1,
      'c|d': 1,
      'c|e': 1,
      'd|e': 1,
    });
    expect(
      armarGrupo(a, resto, { ...params, maxBatchSize: 3 }, d, null),
    ).toHaveLength(3);
  });

  it('respeta la capacidad de carga del vehículo', () => {
    const a = pedido('a', { weightKg: 40 });
    const b = pedido('b', { weightKg: 35 });
    const c = pedido('c', { weightKg: 30 });
    const d = distanciasDe({ 'a|b': 1, 'a|c': 1, 'b|c': 1 });
    // 40 + 35 = 75 entra en 80; sumar c (30) pasaría los 80.
    expect(ids(armarGrupo(a, [b, c], params, d, 80))).toEqual(['a', 'b']);
  });

  it('sin capacidad cargada no hay tope de peso', () => {
    const a = pedido('a', { weightKg: 500 });
    const b = pedido('b', { weightKg: 500 });
    const d = distanciasDe({ 'a|b': 1 });
    expect(ids(armarGrupo(a, [b], params, d, null))).toEqual(['a', 'b']);
  });

  it('un pedido que por sí solo no entra en el vehículo deja el lote de uno', () => {
    const a = pedido('a', { weightKg: 90 });
    const b = pedido('b', { weightKg: 10 });
    const d = distanciasDe({ 'a|b': 1 });
    // a solo ya pasa la capacidad: igual queda como semilla, pero nada más se le suma.
    expect(ids(armarGrupo(a, [b], params, d, 80))).toEqual(['a']);
  });

  it('a igual distancia elige al pedido más antiguo', () => {
    const a = pedido('a');
    const nuevo = pedido('nuevo', { createdAtMs: 200 });
    const viejo = pedido('viejo', { createdAtMs: 100 });
    const d = distanciasDe({ 'a|nuevo': 1, 'a|viejo': 1, 'nuevo|viejo': 1 });
    expect(
      ids(
        armarGrupo(a, [nuevo, viejo], { ...params, maxBatchSize: 2 }, d, null),
      ),
    ).toEqual(['a', 'viejo']);
  });
});

describe('ordenarParadas (CU-107, paso 6)', () => {
  it('arranca por la franja que abre antes', () => {
    const tarde = pedido('tarde', {
      slotStartMs: OCHO + 4 * HORA,
      slotEndMs: OCHO + 8 * HORA,
    });
    const temprano = pedido('temprano');
    const d = distanciasDe({ 'tarde|temprano': 1 });
    const { paradas } = ordenarParadas([tarde, temprano], d);
    expect(paradas.map((p) => p.orderId)).toEqual(['temprano', 'tarde']);
    expect(paradas.map((p) => p.sequence)).toEqual([1, 2]);
  });

  it('dentro de la misma franja va de vecino en vecino, minimizando el tramo', () => {
    const a = pedido('a', { createdAtMs: 1 });
    const b = pedido('b', { createdAtMs: 2 });
    const c = pedido('c', { createdAtMs: 3 });
    // a → c (1 km) → b (1 km) es más corto que a → b (4 km) → c (1 km).
    const d = distanciasDe({ 'a|b': 4, 'a|c': 1, 'b|c': 1 });
    const { paradas } = ordenarParadas([a, b, c], d);
    expect(paradas.map((p) => p.orderId)).toEqual(['a', 'c', 'b']);
    expect(paradas.map((p) => p.legDistanceKm)).toEqual([0, 1, 1]);
  });

  it('no deja para después una franja que se cierra antes sólo por ahorrar un tramo', () => {
    const a = pedido('a', { slotEndMs: OCHO + 4 * HORA });
    // Cierra a las 09:00 y está lejos; el otro está pegado pero abre a las 11:00.
    const urgente = pedido('urgente', {
      slotStartMs: OCHO,
      slotEndMs: OCHO + HORA,
    });
    const cercano = pedido('cercano', {
      slotStartMs: OCHO + 3 * HORA,
      slotEndMs: OCHO + 5 * HORA,
    });
    const d = distanciasDe({
      'a|urgente': 5,
      'a|cercano': 0.1,
      'urgente|cercano': 5,
    });
    const { paradas } = ordenarParadas([a, urgente, cercano], d);
    expect(paradas.map((p) => p.orderId).indexOf('urgente')).toBeLessThan(
      paradas.map((p) => p.orderId).indexOf('cercano'),
    );
  });

  it('estima la llegada con la velocidad media, los calles y el tiempo de servicio', () => {
    const a = pedido('a');
    const b = pedido('b');
    const d = distanciasDe({ 'a|b': 6 });
    const { paradas } = ordenarParadas([a, b], d);
    const minutosDeViaje = ((6 * FACTOR_DE_CALLES) / VELOCIDAD_MEDIA_KMH) * 60;
    expect(paradas[0].etaMs).toBe(OCHO);
    expect(paradas[1].etaMs).toBe(
      Math.round(OCHO + (MINUTOS_DE_SERVICIO + minutosDeViaje) * MIN),
    );
  });

  it('si llega antes de que abra la franja, espera a que abra', () => {
    const a = pedido('a');
    const b = pedido('b', {
      slotStartMs: OCHO + 3 * HORA,
      slotEndMs: OCHO + 5 * HORA,
    });
    const d = distanciasDe({ 'a|b': 1 });
    const { paradas } = ordenarParadas([a, b], d);
    expect(paradas[1].etaMs).toBe(OCHO + 3 * HORA);
  });

  it('saca del lote la parada que llegaría con la franja ya cerrada', () => {
    const a = pedido('a', { slotEndMs: OCHO + 4 * HORA });
    // Cierra a los 15 minutos de abrir pero está a 20 km de la primera parada.
    const inalcanzable = pedido('inalcanzable', { slotEndMs: OCHO + 15 * MIN });
    const d = distanciasDe({ 'a|inalcanzable': 20 });
    const r = ordenarParadas([a, inalcanzable], d);
    expect(r.paradas.map((p) => p.orderId)).toEqual(['a']);
    expect(r.excluidos).toEqual(['inalcanzable']);
  });

  it('es determinista: el mismo lote da siempre el mismo orden', () => {
    const lote = ['a', 'b', 'c', 'd'].map((id, i) =>
      pedido(id, { createdAtMs: i }),
    );
    const d = distanciasDe({
      'a|b': 1,
      'a|c': 1,
      'a|d': 1,
      'b|c': 1,
      'b|d': 1,
      'c|d': 1,
    });
    const uno = ordenarParadas(lote, d).paradas.map((p) => p.orderId);
    const otro = ordenarParadas([...lote].reverse(), d).paradas.map(
      (p) => p.orderId,
    );
    expect(otro).toEqual(uno);
  });
});

describe('pesoTotal', () => {
  it('suma los kilos y redondea a dos decimales', () => {
    expect(
      pesoTotal([
        pedido('a', { weightKg: 10.005 }),
        pedido('b', { weightKg: 4.1 }),
      ]),
    ).toBe(14.11);
  });
});
