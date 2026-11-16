import { RouteMatrixPort } from '../../routes/route-matrix.port';
import { haversineMatrix } from '../../routes/route-matrix';
import { RouteSheetCalculator } from './route-sheet-calculator.service';
import { DEPOSITO, PARAMS, calculadora, pedido } from './route-sheet.fixtures';

describe('RouteSheetCalculator.escenario', () => {
  it('el punto 0 es el depósito; sólo entran los pedidos con punto y franja, con su carga y las fijadas', async () => {
    const pedidos = [
      pedido('o1'),
      pedido('o2', { lat: null, lng: null, hasPoint: false }),
      pedido('o3', { slotStartMs: null, slotEndMs: null, hasSlot: false }),
      pedido('o4', { units: 3, weightKg: 30, collectUnits: 2 }),
    ];
    const e = await calculadora().escenario(
      pedidos,
      DEPOSITO,
      1000,
      PARAMS,
      new Set(['o4']),
    );
    expect(e.origin).toEqual({
      lat: DEPOSITO.lat,
      lng: DEPOSITO.lng,
      fromWarehouse: true,
    });
    expect(e.stops.map((s) => [s.id, s.point, s.locked])).toEqual([
      ['o1', 1, false],
      ['o4', 2, true],
    ]);
    expect(e.schedule).toMatchObject({
      originPoint: 0,
      startMs: 1000,
      serviceMinutes: 10,
    });
    expect(e.schedule.matrix.minutes).toHaveLength(3);
    expect(e.source).toBe('haversine');
    // La carga se arma para todos (también los que no tienen punto).
    expect(e.loads.get('o4')).toEqual({
      deliverUnits: 3,
      deliverKg: 30,
      collectUnits: 2,
      collectKg: 0,
      pickupUnits: 0,
      pickupKg: 0,
    });
    expect(e.loads.has('o2')).toBe(true);
  });

  it('sin depósito el recorrido sale del centro de las paradas', async () => {
    const e = await calculadora().escenario(
      [
        pedido('o1', { lat: -27, lng: -55 }),
        pedido('o2', { lat: -28, lng: -56 }),
      ],
      null,
      0,
      PARAMS,
    );
    expect(e.origin).toEqual({ lat: -27.5, lng: -55.5, fromWarehouse: false });
  });

  it('sin depósito ni pedidos el origen queda en 0,0', async () => {
    const e = await calculadora().escenario([], null, 0, PARAMS);
    expect(e.origin).toEqual({ lat: 0, lng: 0, fromWarehouse: false });
    expect(e.stops).toEqual([]);
  });

  it('el factor de tránsito multiplica los minutos de la matriz', async () => {
    const base = haversineMatrix([
      { lat: DEPOSITO.lat, lng: DEPOSITO.lng },
      { lat: pedido('o1').lat as number, lng: pedido('o1').lng as number },
    ]);
    const port: RouteMatrixPort = {
      matrix: () => Promise.resolve({ ...base, source: 'osrm' }),
    };
    const e = await new RouteSheetCalculator(port).escenario(
      [pedido('o1')],
      DEPOSITO,
      0,
      { ...PARAMS, trafficFactor: 2 },
    );
    expect(e.source).toBe('osrm');
    expect(e.schedule.matrix.minutes[0][1]).toBeCloseTo(base.minutes[0][1] * 2);
  });
});
