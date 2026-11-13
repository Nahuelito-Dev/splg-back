import { DataSource, Repository } from 'typeorm';
import {
  RouteBatch,
  RouteMatrixSource,
} from '../../order/entities/route-batch.entity';
import { RouteBatchStop } from '../../order/entities/route-batch-stop.entity';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { instanteDelDia } from '../domain/route-sheet-rules';
import { RoutePlanService } from './route-plan.service';
import {
  PedidoDeHoja,
  RouteSheetDataService,
} from './route-sheet-data.service';
import { RouteSheetQueryService } from './route-sheet-query.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { hojaOcupada } from './route-sheet.exceptions';
import { EstadoDeHoja, RouteSheetWriter } from './route-sheet-writer.service';
import {
  DEPOSITO,
  DIA,
  DIST,
  PARAMS,
  calculadora,
  hoja,
  parada,
  pedido,
  plan,
} from './route-sheet.fixtures';

const CIERRE = new Date('2026-11-13T21:00:00Z');

function armar(
  o: {
    hojas?: RouteBatch[];
    paradas?: RouteBatchStop[];
    pedidos?: PedidoDeHoja[];
    sinHoja?: PedidoDeHoja[];
  } = {},
) {
  const hojas = o.hojas ?? [hoja()];
  const paradas = o.paradas ?? [
    parada('o1', 1, { etaAt: new Date('2026-11-14T11:20:00Z') }),
    parada('o2', 2),
  ];
  const pedidos = new Map(
    (o.pedidos ?? [pedido('o1'), pedido('o2'), pedido('o3')]).map((p) => [
      p.orderId,
      p,
    ]),
  );
  const sheets = {
    findOne: jest.fn(({ where }: { where: { batchId: string } }) =>
      Promise.resolve(hojas.find((h) => h.batchId === where.batchId) ?? null),
    ),
    findAndCount: jest.fn().mockResolvedValue([hojas, hojas.length]),
    find: jest.fn().mockResolvedValue(hojas),
  };
  const stops = {
    find: jest.fn(({ where }: { where: { batchId: unknown } }) =>
      Promise.resolve(
        typeof where.batchId === 'string'
          ? paradas.filter((p) => p.batchId === where.batchId)
          : paradas,
      ),
    ),
  };
  const data = {
    pedidos: jest.fn((_d: string, ids: readonly string[]) =>
      Promise.resolve(ids.map((id) => pedidos.get(id)).filter(Boolean)),
    ),
    choferes: jest.fn().mockResolvedValue([
      {
        deliveryId: 'chofer-1',
        name: 'Juan',
        available: true,
        usualCarId: 'auto-1',
      },
      {
        deliveryId: 'chofer-2',
        name: 'Pedro',
        available: false,
        usualCarId: null,
      },
    ]),
    vehiculos: jest.fn().mockResolvedValue([
      {
        carId: 'auto-1',
        patent: 'AB123CD',
        description: null,
        capacityKg: 500,
        capacityUnits: 30,
        available: true,
      },
    ]),
    pedidosSinHoja: jest.fn().mockResolvedValue(o.sinHoja ?? []),
  };
  const plans = {
    buscar: jest
      .fn()
      .mockResolvedValue(plan({ cutoffAt: CIERRE, proposedAt: CIERRE })),
  };
  const writer = {
    parametros: jest.fn().mockResolvedValue(PARAMS),
    paradasActivas: jest.fn((_m: unknown, id: string) =>
      Promise.resolve(paradas.filter((x) => x.batchId === id)),
    ),
    sugiereTardios: jest.fn().mockResolvedValue(true),
    estado: jest.fn(
      async (
        _m: unknown,
        _h: RouteBatch,
        _p: unknown,
        ids: string[],
      ): Promise<EstadoDeHoja> => {
        const enOrden = ids
          .map((id) => pedidos.get(id))
          .filter((p): p is PedidoDeHoja => !!p);
        const startMs = instanteDelDia(DIA, '07:30');
        return {
          pedidos: enOrden,
          orden: ids,
          startMs,
          escenario: await calculadora().escenario(
            enOrden,
            DEPOSITO,
            startMs,
            PARAMS,
          ),
        };
      },
    ),
  };
  const ds = {
    query: jest.fn().mockResolvedValue([{ id: DEPOSITO.warehouseId }]),
    manager: {},
  };
  // El recálculo deja en la hoja las garrafas de sus paradas activas en recorrido.
  const recalcular = jest.fn((_m: unknown, h: RouteBatch) => {
    h.totalUnits = paradas
      .filter((x) => x.batchId === h.batchId)
      .reduce((t, x) => {
        const p = pedidos.get(x.orderId);
        return (
          t + (p && p.lat !== null && p.slotStartMs !== null ? p.units : 0)
        );
      }, 0);
    h.totalDistanceKm = 4.2;
    return Promise.resolve();
  });
  Object.assign(writer, { recalcular });
  const locks = {
    conHojas: jest.fn(
      (
        _d: string,
        pedidas: Array<{ id: string }>,
        fn: (m: unknown, h: RouteBatch[]) => Promise<unknown>,
      ) =>
        fn(
          {},
          pedidas.map(
            (x) => hojas.find((h) => h.batchId === x.id) as RouteBatch,
          ),
        ),
    ),
  };
  const svc = new RouteSheetQueryService(
    ds as unknown as DataSource,
    sheets as unknown as Repository<RouteBatch>,
    stops as unknown as Repository<RouteBatchStop>,
    data as unknown as RouteSheetDataService,
    plans as unknown as RoutePlanService,
    writer as unknown as RouteSheetWriter,
    locks as unknown as RouteSheetLocks,
  );
  return { svc, sheets, stops, data, plans, ds, writer, locks, recalcular };
}

describe('RouteSheetQueryService', () => {
  it('detalle: la hoja con chofer, patente, paradas en orden, totales y capacidad', async () => {
    const { svc } = armar({
      hojas: [
        hoja({
          totalDistanceKm: 3.2,
          totalDurationMin: 40,
          totalUnits: 2,
          peakUnits: 2,
          totalWeightKg: 20,
          plannedStartAt: CIERRE,
        }),
      ],
    });
    const d = await svc.detalle(DIST, 'hoja-1');
    expect(d).toMatchObject({
      id: 'hoja-1',
      driverName: 'Juan',
      carPatent: 'AB123CD',
      plannedStartAt: CIERRE.toISOString(),
      totals: {
        distanceKm: 3.2,
        durationMin: 40,
        units: 2,
        peakUnits: 2,
        weightKg: 20,
      },
      capacity: { kg: 500, units: 30 },
      warnings: [],
    });
    expect(
      d.stops.map((s) => [s.orderId, s.sequence, s.customerName, s.late]),
    ).toEqual([
      ['o1', 1, 'Cliente 1', false],
      ['o2', 2, 'Cliente 2', false],
    ]);
    expect(d.stops[0].etaAt).toBe('2026-11-14T11:20:00.000Z');
    expect(d.stops[1].etaAt).toBeNull();
    expect(d.stops[0].slotStart).toBe(
      new Date(instanteDelDia(DIA, '08:00')).toISOString(),
    );
  });

  it('detalle: 404 ROUTE_SHEET_NOT_FOUND si no es de la distribuidora', async () => {
    const { svc, sheets } = armar();
    await expect(svc.detalle(DIST, 'ajena')).rejects.toMatchObject({
      response: { code: 'ROUTE_SHEET_NOT_FOUND' },
    });
    expect((sheets.findOne.mock.calls as unknown[][])[0][0]).toEqual({
      where: { batchId: 'ajena', distributorId: DIST, kind: 'planned' },
    });
  });

  it('advertencias: tarde, sin capacidad cargada, línea recta, sin depósito y Mercado Pago sin pagar', async () => {
    const { svc, data } = armar({
      hojas: [
        hoja({
          matrixSource: RouteMatrixSource.HAVERSINE,
          originWarehouseId: null,
        }),
      ],
      paradas: [
        parada('o1', 1, { etaAt: new Date(instanteDelDia(DIA, '21:00')) }),
        parada('o2', 2),
      ],
      pedidos: [pedido('o1'), pedido('o2', { unpaidOnline: true })],
    });
    data.vehiculos.mockResolvedValueOnce([
      {
        carId: 'auto-1',
        patent: 'X',
        capacityKg: null,
        capacityUnits: null,
        available: true,
      },
    ]);
    const d = await svc.detalle(DIST, 'hoja-1');
    expect(d.warnings.map((w) => w.code)).toEqual([
      'late_stops',
      'no_capacity',
      'straight_line',
      'no_warehouse',
      'unpaid_online',
    ]);
    expect(d.stops[0].late).toBe(true);
  });

  it('advertencias: carga sobre la capacidad (kg o garrafas); un depósito sin ubicación cuenta como sin depósito', async () => {
    const { svc, ds } = armar({
      hojas: [
        hoja({ totalWeightKg: 900, peakUnits: 1 }),
        hoja({ batchId: 'h2', totalWeightKg: 1, peakUnits: 99 }),
      ],
    });
    ds.query.mockResolvedValueOnce([]);
    const [kg, unidades] = await svc
      .listar(DIST, { limit: 10, offset: 0 })
      .then((p) => p.items);
    expect(kg.warnings.map((w) => w.code)).toEqual([
      'capacity',
      'no_warehouse',
    ]);
    expect(unidades.warnings.map((w) => w.code)).toEqual([
      'capacity',
      'no_warehouse',
    ]);
  });

  it('una hoja sin chofer ni vehículo, con una parada cuyo pedido ya no se ve, no rompe', async () => {
    const { svc, data } = armar({
      hojas: [hoja({ deliveryId: null, carId: null })],
      paradas: [parada('o9', 1)],
    });
    data.choferes.mockResolvedValueOnce([]);
    const d = await svc.detalle(DIST, 'hoja-1');
    expect(d).toMatchObject({
      driverName: null,
      carPatent: null,
      capacity: { kg: null, units: null },
    });
    expect(d.stops[0]).toMatchObject({
      customerName: null,
      lat: null,
      slotStart: null,
      units: 0,
      weightKg: 0,
      unpaidOnline: false,
      late: false,
    });
    expect(data.choferes).toHaveBeenCalledWith(DIST, []);
  });

  it('un chofer que ya no figura deja el nombre vacío', async () => {
    const { svc, data } = armar();
    data.choferes.mockResolvedValueOnce([]);
    expect((await svc.detalle(DIST, 'hoja-1')).driverName).toBeNull();
  });

  it('listar: filtra por distribuidora y por lo que venga, pagina y mapea', async () => {
    const { svc, sheets } = armar();
    const r = await svc.listar(DIST, {
      date: DIA,
      status: RouteBatchStatus.DRAFT,
      deliveryId: 'chofer-1',
      limit: 5,
      offset: 10,
    });
    expect(r).toMatchObject({ total: 1, limit: 5, offset: 10 });
    expect((sheets.findAndCount.mock.calls as unknown[][])[0][0]).toMatchObject(
      {
        where: {
          distributorId: DIST,
          kind: 'planned',
          planDate: DIA,
          status: 'draft',
          deliveryId: 'chofer-1',
        },
        take: 5,
        skip: 10,
      },
    );
    await svc.listar(DIST, { limit: 10, offset: 0 });
    expect(
      (
        (sheets.findAndCount.mock.calls as unknown[][])[1][0] as {
          where: unknown;
        }
      ).where,
    ).toEqual({
      distributorId: DIST,
      kind: 'planned',
    });
  });

  it('listar vacío no consulta paradas', async () => {
    const { svc, stops } = armar({ hojas: [] });
    expect((await svc.listar(DIST, { limit: 10, offset: 0 })).items).toEqual(
      [],
    );
    expect(stops.find).not.toHaveBeenCalled();
  });

  it('dia: plan, hojas, «sin asignar» con su motivo y recursos con la hoja confirmada que ya tengan', async () => {
    const confirmada = hoja({ status: RouteBatchStatus.CONFIRMED });
    const { svc, plans } = armar({
      hojas: [confirmada],
      sinHoja: [
        pedido('o3'),
        pedido('o4', { offeredNow: true }),
        pedido('o5', { deliveryMode: 'express' }),
      ],
    });
    const d = await svc.dia(DIST, DIA);
    expect(plans.buscar).toHaveBeenCalledWith(DIST, DIA);
    expect(d.plan).toEqual({
      date: DIA,
      status: 'open',
      cutoffAt: CIERRE.toISOString(),
      proposedAt: CIERRE.toISOString(),
      summary: null,
      closedAt: null,
    });
    expect(d.unassigned.map((u) => [u.orderId, u.blockedReason])).toEqual([
      ['o3', null],
      ['o4', 'tiene una oferta del despacho esperando respuesta'],
      ['o5', 'es un pedido express'],
    ]);
    expect(d.resources.drivers).toEqual([
      {
        deliveryId: 'chofer-1',
        name: 'Juan',
        available: true,
        busySheetId: 'hoja-1',
        usualCarId: 'auto-1',
      },
      {
        deliveryId: 'chofer-2',
        name: 'Pedro',
        available: false,
        busySheetId: null,
        usualCarId: null,
      },
    ]);
    expect(d.resources.cars[0]).toMatchObject({
      carId: 'auto-1',
      busySheetId: 'hoja-1',
    });
  });

  it('dia: un borrador no ocupa al chofer ni al vehículo', async () => {
    const { svc } = armar();
    const d = await svc.dia(DIST, DIA);
    expect(d.resources.drivers[0].busySheetId).toBeNull();
    expect(d.resources.cars[0].busySheetId).toBeNull();
  });

  it('tardios: sólo los creados después del cierre, con la mejor inserción entre los borradores', async () => {
    const tarde = pedido('o3', { createdAtMs: CIERRE.getTime() + 60_000 });
    const noPlanificable = pedido('o4', {
      createdAtMs: CIERRE.getTime() + 60_000,
      fraudHold: true,
    });
    const sinPunto = pedido('o5', {
      createdAtMs: CIERRE.getTime() + 60_000,
      hasPoint: true,
      lat: null,
      lng: null,
    });
    const temprano = pedido('o6');
    const { svc, stops, writer } = armar({
      hojas: [hoja(), hoja({ batchId: 'hoja-2' })],
      paradas: [parada('o1', 1), parada('o2', 1, { batchId: 'hoja-2' })],
      pedidos: [
        pedido('o1'),
        pedido('o2', { lat: DEPOSITO.lat + 0.3 }),
        tarde,
        noPlanificable,
        sinPunto,
        temprano,
      ],
      sinHoja: [tarde, noPlanificable, sinPunto, temprano],
    });
    const r = await svc.tardios(DIST, DIA);
    expect(r.map((x) => x.orderId)).toEqual(['o3', 'o4', 'o5']);
    expect(r[0].suggestion).toMatchObject({ sheetId: 'hoja-1' });
    expect(r[0].suggestion?.position).toBeGreaterThanOrEqual(1);
    expect(r[0].createdAt).toBe(
      new Date(CIERRE.getTime() + 60_000).toISOString(),
    );
    expect(r[1].suggestion).toBeNull();
    expect(r[1].blockedReason).toBe('está retenido por la revisión del pago');
    expect(r[2].suggestion).toBeNull();
    expect(stops.find).toHaveBeenCalled();
    // Es una lectura: el estado de cada borrador se arma sin bloquear.
    expect(
      (writer.estado.mock.calls as unknown[][]).every((c) => c[4] === false),
    ).toBe(true);
  });

  it('tardios: sin lugar en ningún borrador, sin sugerencia', async () => {
    const tarde = pedido('o3', {
      createdAtMs: CIERRE.getTime() + 1,
      slotStartMs: instanteDelDia(DIA, '07:00'),
      slotEndMs: instanteDelDia(DIA, '07:31'),
    });
    const { svc } = armar({
      sinHoja: [tarde],
      pedidos: [pedido('o1'), pedido('o2'), tarde],
    });
    const [r] = await svc.tardios(DIST, DIA);
    expect(r.suggestion).toBeNull();
  });

  it('tardios: con lateOrderPolicy = 0 no sugiere inserciones (van al despacho del día)', async () => {
    const tarde = pedido('o3', { createdAtMs: CIERRE.getTime() + 60_000 });
    const { svc, writer, stops } = armar({
      sinHoja: [tarde],
      pedidos: [pedido('o1'), pedido('o2'), tarde],
    });
    writer.sugiereTardios.mockResolvedValueOnce(false);
    const [r] = await svc.tardios(DIST, DIA);
    expect(r).toMatchObject({
      orderId: 'o3',
      suggestion: null,
      blockedReason: null,
    });
    expect(stops.find).not.toHaveBeenCalled();
  });

  it('advertencia stops_not_plannable: una parada viva cuyo pedido se canceló; en una hoja cancelada no se avisa', async () => {
    const { svc } = armar({
      hojas: [
        hoja(),
        hoja({ batchId: 'h2', status: RouteBatchStatus.DISSOLVED }),
      ],
      paradas: [
        parada('o1', 1),
        parada('o2', 2),
        parada('o1', 1, { batchId: 'h2' }),
      ],
      pedidos: [pedido('o1', { status: 'cancelled' }), pedido('o2')],
    });
    const [viva, cancelada] = (await svc.listar(DIST, { limit: 10, offset: 0 }))
      .items;
    expect(viva.warnings).toContainEqual({
      code: 'stops_not_plannable',
      message:
        '1 parada(s) con pedidos que ya no se pueden repartir en la hoja: sacalas',
    });
    expect(cancelada.warnings.map((w) => w.code)).not.toContain(
      'stops_not_plannable',
    );
  });

  describe('totales viejos (una parada salió sola al cancelarse su pedido)', () => {
    it('una hoja viva cuyas garrafas no coinciden con las de sus paradas se recalcula bajo su cerrojo antes de mostrarla', async () => {
      const { svc, locks, recalcular } = armar({
        hojas: [
          hoja({
            totalUnits: 3,
            peakUnits: 3,
            totalWeightKg: 30,
            totalDistanceKm: 9,
          }),
        ],
      });
      const d = await svc.detalle(DIST, 'hoja-1');
      expect(locks.conHojas).toHaveBeenCalledWith(
        DIST,
        [{ id: 'hoja-1' }],
        expect.any(Function),
      );
      expect(recalcular).toHaveBeenCalledTimes(1);
      expect(d.totals).toMatchObject({ units: 2, distanceKm: 4.2 });
    });

    it('dos lecturas a la vez: la que llega segunda al cerrojo la ve al día y no recalcula (una sola escritura)', async () => {
      const { svc, recalcular, locks } = armar({
        hojas: [hoja({ totalUnits: 3 })],
      });
      const [a, b] = await Promise.all([
        svc.detalle(DIST, 'hoja-1'),
        svc.detalle(DIST, 'hoja-1'),
      ]);
      expect(locks.conHojas).toHaveBeenCalledTimes(2);
      expect(recalcular).toHaveBeenCalledTimes(1);
      expect([a.totals.units, b.totals.units]).toEqual([2, 2]);
    });

    it('si otra lectura la recalculó mientras se esperaba el cerrojo, no escribe', async () => {
      const h = hoja({ totalUnits: 3 });
      const { svc, recalcular, locks } = armar({ hojas: [h] });
      locks.conHojas.mockImplementationOnce(
        (
          _d: string,
          _p: unknown,
          fn: (m: unknown, x: RouteBatch[]) => Promise<unknown>,
        ) => {
          h.totalUnits = 2; // la otra lectura terminó antes de que se liberara el cerrojo
          return fn({}, [h]);
        },
      );
      await svc.detalle(DIST, 'hoja-1');
      expect(recalcular).not.toHaveBeenCalled();
    });

    it('con los totales al día no recalcula; una hoja cancelada tampoco', async () => {
      const { svc, recalcular } = armar({
        hojas: [
          hoja({ totalUnits: 2 }),
          hoja({
            batchId: 'h2',
            status: RouteBatchStatus.DISSOLVED,
            totalUnits: 9,
          }),
        ],
        paradas: [
          parada('o1', 1),
          parada('o2', 2),
          parada('o3', 1, { batchId: 'h2' }),
        ],
      });
      await svc.listar(DIST, { limit: 10, offset: 0 });
      expect(recalcular).not.toHaveBeenCalled();
    });

    it('una parada sin punto o sin franja no cuenta (no está en el recorrido)', async () => {
      const { svc, recalcular } = armar({
        hojas: [hoja({ totalUnits: 1 })],
        pedidos: [pedido('o1'), pedido('o2', { lat: null, lng: null })],
      });
      await svc.detalle(DIST, 'hoja-1');
      expect(recalcular).not.toHaveBeenCalled();
    });

    it('si otra sesión tiene la hoja tomada, la muestra como está; otro error se propaga', async () => {
      const { svc, locks } = armar({ hojas: [hoja({ totalUnits: 5 })] });
      locks.conHojas.mockRejectedValueOnce(hojaOcupada());
      expect((await svc.detalle(DIST, 'hoja-1')).totals.units).toBe(5);
      locks.conHojas.mockRejectedValueOnce(new Error('se cayó la base'));
      await expect(svc.detalle(DIST, 'hoja-1')).rejects.toThrow(
        'se cayó la base',
      );
    });
  });

  it('cargaSugerida: llenas y vacías por garrafa de las paradas activas; 404 si la hoja es ajena', async () => {
    const { svc, ds } = armar();
    ds.query.mockResolvedValueOnce([
      {
        gasCylinderId: 'g1',
        type: '10kg',
        fullUnits: '3',
        emptyUnitsBack: '2',
      },
    ]);
    expect(await svc.cargaSugerida(DIST, 'hoja-1')).toEqual({
      sheetId: 'hoja-1',
      items: [
        { gasCylinderId: 'g1', type: '10kg', fullUnits: 3, emptyUnitsBack: 2 },
      ],
    });
    expect((ds.query.mock.calls as unknown[][])[0][1]).toEqual(['hoja-1']);
    await expect(svc.cargaSugerida(DIST, 'ajena')).rejects.toMatchObject({
      response: { code: 'ROUTE_SHEET_NOT_FOUND' },
    });
  });
});
