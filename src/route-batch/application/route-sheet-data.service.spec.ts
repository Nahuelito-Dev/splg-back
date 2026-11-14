import { DataSource, EntityManager } from 'typeorm';
import { FleetDispatchLockService } from '../../fleet/fleet-dispatch-lock.service';
import { instanteDelDia } from '../domain/route-sheet-rules';
import { RouteSheetDataService } from './route-sheet-data.service';
import { DIA, DIST } from './route-sheet.fixtures';

const fila = (over: Record<string, unknown> = {}) => ({
  orderId: 'o1',
  status: 'pending',
  deliveryId: null,
  scheduledDate: DIA,
  slotStart: '09:00:00',
  slotEnd: '13:00:00',
  slotName: 'Mañana',
  dayStart: '08:00:00',
  dayEnd: '20:00:00',
  deliveryMode: 'standard',
  depositPaid: false,
  fraudHold: false,
  lat: '-27.37',
  lng: '-55.9',
  createdAtMs: '1700000000000',
  customerName: 'Ana',
  customerPhone: '376',
  address: 'Calle 1',
  units: '2',
  weightKg: '20.004',
  collectUnits: '1',
  unpaidOnline: false,
  offeredNow: false,
  activeBatchId: null,
  ...over,
});

function armar(filas: unknown[] = [], inhabilitados = new Set<string>()) {
  const ds = { query: jest.fn().mockResolvedValue(filas), manager: {} };
  ds.manager = { query: ds.query };
  const fleet = {
    choferesInhabilitados: jest.fn().mockResolvedValue(inhabilitados),
    habilitacionAlDia: jest.fn().mockResolvedValue({
      choferes: new Map([...inhabilitados].map((u) => [u, ['de licencia']])),
      vehiculos: new Map([...inhabilitados].map((c) => [c, ['VTV vencida']])),
    }),
  };
  return {
    ds,
    fleet,
    svc: new RouteSheetDataService(
      ds as unknown as DataSource,
      fleet as unknown as FleetDispatchLockService,
    ),
  };
}

describe('RouteSheetDataService', () => {
  it('pedidos: sin ids no consulta; con ids filtra por distribuidora y mapea punto, franja y carga', async () => {
    const vacio = armar();
    expect(await vacio.svc.pedidos(DIST, [])).toEqual([]);
    expect(vacio.ds.query).not.toHaveBeenCalled();

    const { svc, ds } = armar([
      fila(),
      fila({
        orderId: 'o2',
        lat: null,
        lng: null,
        slotStart: null,
        slotEnd: null,
        scheduledDate: null,
      }),
    ]);
    const [p, sinPunto] = await svc.pedidos(DIST, ['o1', 'o2']);
    expect((ds.query.mock.calls as unknown[][])[0][1]).toEqual([
      DIST,
      ['o1', 'o2'],
    ]);
    expect((ds.query.mock.calls as unknown[][])[0][0]).toContain(
      'o."distributor_id" = $1',
    );
    expect(p).toMatchObject({
      hasPoint: true,
      hasSlot: true,
      lat: -27.37,
      lng: -55.9,
      slotStartMs: instanteDelDia(DIA, '09:00:00'),
      slotEndMs: instanteDelDia(DIA, '13:00:00'),
      createdAtMs: 1700000000000,
      units: 2,
      weightKg: 20,
      collectUnits: 1,
    });
    expect(sinPunto).toMatchObject({
      hasPoint: false,
      // Sin fecha no hay jornada que aplicar.
      hasSlot: false,
      lat: null,
      lng: null,
      slotStartMs: null,
      slotEndMs: null,
    });
  });

  it('pedidos SIN franja fija (reprogramado o sólo con fecha): la franja es la jornada de la distribuidora', async () => {
    const { svc, ds } = armar([
      fila({ slotStart: null, slotEnd: null, slotName: null }),
      fila({
        orderId: 'o2',
        slotStart: null,
        slotEnd: null,
        dayStart: null,
        dayEnd: null,
      }),
    ]);
    const [p, sinJornada] = await svc.pedidos(DIST, ['o1', 'o2']);
    expect((ds.query.mock.calls as unknown[][])[0][0]).toContain(
      'min(j."startTime")',
    );
    expect(p).toMatchObject({
      hasSlot: true,
      fixedSlot: false,
      slotStartMs: instanteDelDia(DIA, '08:00:00'),
      slotEndMs: instanteDelDia(DIA, '20:00:00'),
      dayStartMs: instanteDelDia(DIA, '08:00:00'),
      dayEndMs: instanteDelDia(DIA, '20:00:00'),
    });
    // La distribuidora sin franjas activas: no se puede planificar.
    expect(sinJornada).toMatchObject({
      hasSlot: false,
      fixedSlot: false,
      slotStartMs: null,
      slotEndMs: null,
    });
  });

  it('pedidos: usa el manager de la transacción si se lo pasan', async () => {
    const { svc, ds } = armar();
    const manager = { query: jest.fn().mockResolvedValue([fila()]) };
    await svc.pedidos(DIST, ['o1'], manager as unknown as EntityManager);
    expect(manager.query).toHaveBeenCalled();
    expect(ds.query).not.toHaveBeenCalled();
  });

  it('pedidos con bloquear toma la fila del pedido (FOR UPDATE OF o); sin bloquear, no', async () => {
    const { svc, ds } = armar([fila()]);
    await svc.pedidos(DIST, ['o1']);
    expect((ds.query.mock.calls as unknown[][])[0][0]).not.toContain(
      'FOR UPDATE',
    );
    await svc.pedidos(DIST, ['o1'], undefined, true);
    expect((ds.query.mock.calls as unknown[][])[1][0]).toContain(
      'FOR UPDATE OF o',
    );
  });

  it('pedidosSinHoja: del día, sin chofer, pendientes, y los de los borradores liberables cuentan como libres', async () => {
    const { svc, ds } = armar([fila()]);
    await svc.pedidosSinHoja(DIST, DIA, ['h1']);
    const [sql, params] = ds.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([DIST, DIA, ['h1']]);
    expect(sql).toContain('o."delivery_id" IS NULL');
    expect(sql).toContain(`IN ('pending', 'reserved')`);
    await svc.pedidosSinHoja(DIST, DIA);
    expect((ds.query.mock.calls as unknown[][])[1][1]).toEqual([DIST, DIA, []]);
  });

  it('deposito: el pedido o el predeterminado; null si no hay ninguno ubicado', async () => {
    const { svc, ds } = armar([
      { warehouseId: 'w1', lat: '-27.1', lng: '-55.2' },
    ]);
    expect(await svc.deposito(DIST, 'w1')).toEqual({
      warehouseId: 'w1',
      lat: -27.1,
      lng: -55.2,
    });
    expect((ds.query.mock.calls as unknown[][])[0][1]).toEqual([DIST, 'w1']);
    ds.query.mockResolvedValueOnce([]);
    expect(await svc.deposito(DIST, null)).toBeNull();
  });

  it('existeDeposito: sólo de la distribuidora y no borrado', async () => {
    const { svc, ds } = armar([{}]);
    expect(await svc.existeDeposito(DIST, 'w1')).toBe(true);
    expect((ds.query.mock.calls as unknown[][])[0][1]).toEqual(['w1', DIST]);
    ds.query.mockResolvedValueOnce([]);
    expect(await svc.existeDeposito(DIST, 'w2')).toBe(false);
  });

  it('choferes: disponible = habilitado y validado, y sin inhabilitación de flota', async () => {
    const { svc, ds, fleet } = armar(
      [
        {
          deliveryId: 'd1',
          userId: 'u1',
          name: 'A',
          enabled: true,
          usualCarId: 'c1',
        },
        {
          deliveryId: 'd2',
          userId: 'u2',
          name: 'B',
          enabled: true,
          usualCarId: null,
        },
        {
          deliveryId: 'd3',
          userId: 'u3',
          name: 'C',
          enabled: false,
          usualCarId: null,
        },
      ],
      new Set(['u2']),
    );
    const r = await svc.choferes(DIST, ['d1', 'd2', 'd3']);
    expect(fleet.choferesInhabilitados).toHaveBeenCalledWith(
      ['u1', 'u2'],
      DIST,
    );
    expect(r.map((c) => [c.deliveryId, c.available, c.usualCarId])).toEqual([
      ['d1', true, 'c1'],
      ['d2', false, null],
      ['d3', false, null],
    ]);
    expect((ds.query.mock.calls as unknown[][])[0][1]).toEqual([
      DIST,
      ['d1', 'd2', 'd3'],
    ]);
  });

  it('choferes: sin habilitados no consulta la flota; sin filtro manda null', async () => {
    const { svc, ds, fleet } = armar([
      {
        deliveryId: 'd3',
        userId: 'u3',
        name: null,
        enabled: false,
        usualCarId: null,
      },
    ]);
    expect((await svc.choferes(DIST))[0].available).toBe(false);
    expect(fleet.choferesInhabilitados).not.toHaveBeenCalled();
    expect((ds.query.mock.calls as unknown[][])[0][1]).toEqual([DIST, null]);
  });

  it('vehiculos: la capacidad en kg sale de max_load_kg o, si no, de car_capacity', async () => {
    const { svc, ds } = armar([
      {
        carId: 'c1',
        patent: 'A',
        description: 'Camión',
        maxLoadKg: '800.5',
        carCapacity: 500,
        maxCylinders: 40,
        available: true,
      },
      {
        carId: 'c2',
        patent: 'B',
        description: null,
        maxLoadKg: null,
        carCapacity: 300,
        maxCylinders: null,
        available: true,
      },
      {
        carId: 'c3',
        patent: null,
        description: null,
        maxLoadKg: null,
        carCapacity: null,
        maxCylinders: null,
        available: false,
      },
    ]);
    const r = await svc.vehiculos(DIST);
    expect(
      r.map((v) => [v.carId, v.capacityKg, v.capacityUnits, v.available]),
    ).toEqual([
      ['c1', 800.5, 40, true],
      ['c2', 300, null, true],
      ['c3', null, null, false],
    ]);
    expect((ds.query.mock.calls as unknown[][])[0][1]).toEqual([DIST, null]);
    await svc.vehiculos(DIST, ['c1']);
    expect((ds.query.mock.calls as unknown[][])[1][1]).toEqual([DIST, ['c1']]);
  });

  it('choferes a la fecha del plan: la habilitación de ese día, no la de ahora (y sin exigir vehículo en uso)', async () => {
    const { svc, fleet } = armar(
      [
        {
          deliveryId: 'd1',
          userId: 'u1',
          name: 'A',
          enabled: true,
          usualCarId: null,
        },
        {
          deliveryId: 'd2',
          userId: 'u2',
          name: 'B',
          enabled: true,
          usualCarId: null,
        },
      ],
      new Set(['u2']),
    );
    const r = await svc.choferes(DIST, undefined, '2026-11-20');
    expect(fleet.habilitacionAlDia).toHaveBeenCalledWith(
      ['u1', 'u2'],
      [],
      DIST,
      '2026-11-20',
    );
    expect(fleet.choferesInhabilitados).not.toHaveBeenCalled();
    expect(r.map((c) => c.available)).toEqual([true, false]);
  });

  it('vehiculos a la fecha del plan: los activos con algo vencido o en taller ese día no están disponibles', async () => {
    const { svc, fleet } = armar(
      [
        {
          carId: 'c1',
          patent: 'A',
          description: null,
          maxLoadKg: null,
          carCapacity: null,
          maxCylinders: null,
          available: true,
        },
        {
          carId: 'c2',
          patent: 'B',
          description: null,
          maxLoadKg: null,
          carCapacity: null,
          maxCylinders: null,
          available: true,
        },
        {
          carId: 'c3',
          patent: 'C',
          description: null,
          maxLoadKg: null,
          carCapacity: null,
          maxCylinders: null,
          available: false,
        },
      ],
      new Set(['c2']),
    );
    const r = await svc.vehiculos(DIST, undefined, '2026-11-20');
    expect(fleet.habilitacionAlDia).toHaveBeenCalledWith(
      [],
      ['c1', 'c2'],
      DIST,
      '2026-11-20',
    );
    expect(r.map((v) => v.available)).toEqual([true, false, false]);
    // Sin activos no consulta la flota.
    const vacio = armar([
      {
        carId: 'c3',
        patent: 'C',
        description: null,
        maxLoadKg: null,
        carCapacity: null,
        maxCylinders: null,
        available: false,
      },
    ]);
    await vacio.svc.vehiculos(DIST, undefined, '2026-11-20');
    expect(vacio.fleet.habilitacionAlDia).not.toHaveBeenCalled();
  });

  it('ocupadosDelDia: choferes y vehículos de las hojas confirmadas o en curso, salvo la propia', async () => {
    const { svc, ds } = armar([
      { deliveryId: 'd1', carId: 'c1' },
      { deliveryId: null, carId: null },
    ]);
    const r = await svc.ocupadosDelDia(DIST, DIA, 'h1');
    expect(r).toEqual({
      deliveryIds: new Set(['d1']),
      carIds: new Set(['c1']),
    });
    const [sql, params] = ds.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([DIST, DIA, 'h1']);
    expect(sql).toContain(`"status" IN ('confirmed', 'assigned')`);
  });
});
