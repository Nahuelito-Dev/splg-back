import {
  avance,
  estadoDelVehiculo,
  finEstimado,
  paradasEnVivo,
  porcentajeDeCarga,
  type ParadaDeHoja,
} from './live-fleet.rules';

const INICIO = new Date('2026-11-21T12:00:00.000Z');
const parada = (over: Partial<ParadaDeHoja>): ParadaDeHoja => ({
  orderId: 'o1',
  sequence: 1,
  active: true,
  removedReason: null,
  removedAt: null,
  etaAt: null,
  orderStatus: 'accepted',
  ...over,
});

describe('porcentajeDeCarga', () => {
  it('envases a bordo sobre la capacidad, redondeado', () => {
    expect(porcentajeDeCarga(33, 40)).toBe(83);
    expect(porcentajeDeCarga(0, 40)).toBe(0);
  });

  it('puede pasar de 100 si va excedido', () => {
    expect(porcentajeDeCarga(50, 40)).toBe(125);
  });

  it('sin capacidad cargada (o inválida) no hay porcentaje', () => {
    expect(porcentajeDeCarga(10, null)).toBeNull();
    expect(porcentajeDeCarga(10, 0)).toBeNull();
  });
});

describe('estadoDelVehiculo', () => {
  it('en ruta con la hoja iniciada o con un pedido en curso; si no, esperando', () => {
    expect(estadoDelVehiculo(true, 0)).toBe('on_route');
    expect(estadoDelVehiculo(false, 1)).toBe('on_route');
    expect(estadoDelVehiculo(false, 0)).toBe('waiting');
  });
});

describe('paradasEnVivo', () => {
  it('antes de iniciar sólo cuentan las activas, en su orden', () => {
    const r = paradasEnVivo(
      [
        parada({ orderId: 'b', sequence: 2 }),
        parada({ orderId: 'a', sequence: 1 }),
        parada({ orderId: 'x', active: false, removedReason: 'moved' }),
        parada({ orderId: 'y', active: false, removedReason: null }),
      ],
      null,
    );
    expect(r.map((p) => [p.orderId, p.sequence, p.progress])).toEqual([
      ['a', 1, 'pending'],
      ['b', 2, 'pending'],
    ]);
  });

  it('en la calle: entregada, en camino, pendiente y la que falló; no las que salieron por otro motivo', () => {
    const despues = new Date(INICIO.getTime() + 60_000);
    const antes = new Date(INICIO.getTime() - 60_000);
    const r = paradasEnVivo(
      [
        parada({ orderId: 'hecha', sequence: 1, orderStatus: 'delivered' }),
        parada({ orderId: 'va', sequence: 2, orderStatus: 'on_the_way' }),
        parada({ orderId: 'falta', sequence: 3 }),
        parada({
          orderId: 'fallo',
          active: false,
          removedReason: 'rescheduled',
          removedAt: despues,
        }),
        parada({
          orderId: 'cancelada',
          active: false,
          removedReason: 'cancelled',
          removedAt: despues,
        }),
        parada({
          orderId: 'vieja',
          active: false,
          removedReason: 'rescheduled',
          removedAt: antes,
        }),
      ],
      INICIO,
    );
    expect(r.map((p) => [p.orderId, p.sequence, p.progress])).toEqual([
      ['hecha', 1, 'delivered'],
      ['va', 2, 'on_the_way'],
      ['falta', 3, 'pending'],
      ['fallo', null, 'failed'],
    ]);
  });
});

describe('avance y finEstimado', () => {
  const paradas = [
    { progress: 'delivered' as const, etaAt: new Date('2026-11-21T13:00:00Z') },
    {
      progress: 'on_the_way' as const,
      etaAt: new Date('2026-11-21T13:30:00Z'),
    },
    { progress: 'pending' as const, etaAt: new Date('2026-11-21T14:10:00Z') },
    { progress: 'pending' as const, etaAt: null },
    { progress: 'failed' as const, etaAt: new Date('2026-11-21T18:00:00Z') },
  ];

  it('cuenta entregadas, fallidas y lo que falta (pendientes más la que está en camino)', () => {
    expect(avance(paradas)).toEqual({
      total: 5,
      delivered: 1,
      failed: 1,
      pending: 3,
    });
  });

  it('el fin estimado es la llegada más tardía de lo que falta', () => {
    expect(finEstimado(paradas)?.toISOString()).toBe(
      '2026-11-21T14:10:00.000Z',
    );
  });

  it('sin nada pendiente con hora no hay fin estimado', () => {
    expect(finEstimado([paradas[0], paradas[3], paradas[4]])).toBeNull();
  });
});
