import { DataSource, EntityManager } from 'typeorm';
import { ProcessConfigService } from '../../distributor/process-config.service';
import {
  RouteBatch,
  RouteProposedBy,
} from '../../order/entities/route-batch.entity';
import {
  RoutePlan,
  RoutePlanStatus,
} from '../../order/entities/route-plan.entity';
import { RedisService } from '../../redis/redis.service';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import {
  RoutePlanProposalService,
  emparejar,
} from './route-plan-proposal.service';
import { RoutePlanService } from './route-plan.service';
import {
  ChoferDelDia,
  PedidoDeHoja,
  RouteSheetDataService,
  VehiculoDelDia,
} from './route-sheet-data.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import {
  DEPOSITO,
  DIA,
  DIST,
  PARAMS,
  calculadora,
  hoja,
  pedido,
  plan,
} from './route-sheet.fixtures';

const chofer = (
  id: string,
  over: Partial<ChoferDelDia> = {},
): ChoferDelDia => ({
  deliveryId: id,
  userId: `u-${id}`,
  name: id,
  available: true,
  usualCarId: null,
  ...over,
});
const vehiculo = (
  id: string,
  over: Partial<VehiculoDelDia> = {},
): VehiculoDelDia => ({
  carId: id,
  patent: id,
  description: null,
  capacityKg: 1000,
  capacityUnits: 50,
  available: true,
  photoKey: null,
  ...over,
});

interface Opciones {
  enabled?: number;
  plan?: RoutePlan;
  hojas?: RouteBatch[];
  pedidos?: PedidoDeHoja[];
  choferes?: ChoferDelDia[];
  vehiculos?: VehiculoDelDia[];
  cerrojo?: boolean;
  filaVieja?: RouteBatch | null;
  /** Cómo están los pedidos al revalidar, con la fila bloqueada (si cambió algo). */
  frescos?: PedidoDeHoja[];
}

function armar(o: Opciones = {}) {
  let n = 0;
  const manager = {
    findOne: jest
      .fn()
      .mockResolvedValue(o.filaVieja === undefined ? null : o.filaVieja),
    save: jest.fn((x: RouteBatch) =>
      Promise.resolve(
        Object.assign(x, { batchId: x.batchId ?? `nueva-${++n}` }),
      ),
    ),
    create: jest.fn((_e: unknown, x: Partial<RouteBatch>) =>
      Object.assign(new RouteBatch(), x),
    ),
    update: jest.fn().mockResolvedValue({}),
  };
  const m = manager as unknown as EntityManager;
  const ds = {
    getRepository: jest.fn(() => ({
      find: jest.fn().mockResolvedValue(o.hojas ?? []),
    })),
  };
  const plans = {
    abrir: jest.fn().mockResolvedValue(o.plan ?? plan()),
    enElDia: jest.fn(
      (_d: string, _f: string, fn: (x: EntityManager) => unknown) => fn(m),
    ),
  };
  const delDia = o.pedidos ?? [pedido('o1'), pedido('o2'), pedido('o3')];
  const frescos = new Map((o.frescos ?? delDia).map((p) => [p.orderId, p]));
  const data = {
    pedidosSinHoja: jest.fn().mockResolvedValue(delDia),
    pedidos: jest.fn((_d: string, ids: readonly string[]) =>
      Promise.resolve(ids.map((id) => frescos.get(id)).filter(Boolean)),
    ),
    choferes: jest
      .fn()
      .mockResolvedValue(o.choferes ?? [chofer('d1', { usualCarId: 'c1' })]),
    vehiculos: jest.fn().mockResolvedValue(o.vehiculos ?? [vehiculo('c1')]),
    deposito: jest.fn().mockResolvedValue(DEPOSITO),
  };
  const writer = {
    parametros: jest.fn().mockResolvedValue(PARAMS),
    apagarTodas: jest.fn().mockResolvedValue(undefined),
    activarParada: jest.fn().mockResolvedValue(undefined),
    escribirOrden: jest.fn().mockResolvedValue(undefined),
    recalcular: jest.fn().mockResolvedValue(undefined),
  };
  const processConfig = {
    obtener: jest.fn().mockResolvedValue({ enabled: o.enabled ?? 1 }),
  };
  const redis = {
    withLock: jest.fn(
      async (_k: string, _t: number, fn: () => Promise<unknown>) =>
        o.cerrojo === false
          ? { obtenido: false }
          : { obtenido: true, valor: await fn() },
    ),
  };
  const svc = new RoutePlanProposalService(
    ds as unknown as DataSource,
    plans as unknown as RoutePlanService,
    data as unknown as RouteSheetDataService,
    calculadora(),
    writer as unknown as RouteSheetWriter,
    processConfig as unknown as ProcessConfigService,
    redis as unknown as RedisService,
  );
  return { svc, manager, plans, data, writer, redis };
}

describe('RoutePlanProposalService.proponer', () => {
  it('409 si la hoja de ruta está apagada, si el día está cerrado o si ya se está proponiendo', async () => {
    await expect(
      armar({ enabled: 0 }).svc.proponer(DIST, DIA),
    ).rejects.toMatchObject({ response: { code: 'ROUTE_PLANNING_DISABLED' } });
    await expect(
      armar({ plan: plan({ status: RoutePlanStatus.CLOSED }) }).svc.proponer(
        DIST,
        DIA,
      ),
    ).rejects.toMatchObject({
      response: { code: 'ROUTE_PLAN_CLOSED' },
    });
    const ocupado = armar({ cerrojo: false });
    await expect(ocupado.svc.proponer(DIST, DIA)).rejects.toMatchObject({
      response: { code: 'ROUTE_PLAN_BUSY' },
    });
    expect((ocupado.redis.withLock.mock.calls as unknown[][])[0][0]).toBe(
      `route-plan:${DIST}:${DIA}`,
    );
  });

  it('en seco calcula la propuesta sin escribir nada', async () => {
    const { svc, plans, manager } = armar();
    const r = await svc.proponer(DIST, DIA, true);
    expect(r).toMatchObject({
      dryRun: true,
      candidates: 3,
      matrixSource: 'haversine',
      unassigned: [],
      keptSheetIds: [],
    });
    expect(r.sheets).toHaveLength(1);
    expect(r.sheets[0]).toMatchObject({
      sheetId: null,
      deliveryId: 'd1',
      carId: 'c1',
    });
    expect(r.sheets[0].orderIds.sort()).toEqual(['o1', 'o2', 'o3']);
    expect(r.sheets[0].durationMin).toBeGreaterThan(0);
    expect(plans.enElDia).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('separa los que no se pueden planificar (sin punto u otro motivo) y los que tienen una oferta viva', async () => {
    const { svc } = armar({
      pedidos: [
        pedido('o1'),
        pedido('o2', { hasPoint: false, lat: null, lng: null }),
        pedido('o3', { fraudHold: true }),
        pedido('o4', { offeredNow: true }),
      ],
    });
    const r = await svc.proponer(DIST, DIA, true);
    expect(r.candidates).toBe(1);
    expect(r.unassigned).toEqual([
      { orderId: 'o2', reason: 'no_point' },
      { orderId: 'o3', reason: 'not_plannable' },
      { orderId: 'o4', reason: 'dispatch_offer' },
    ]);
  });

  it('sin vehículos libres, los pedidos quedan sin hoja (no_vehicles)', async () => {
    const { svc } = armar({
      vehiculos: [vehiculo('c1', { available: false })],
    });
    const r = await svc.proponer(DIST, DIA, true);
    expect(r.sheets).toEqual([]);
    expect(r.unassigned.map((u) => u.reason)).toEqual([
      'no_vehicles',
      'no_vehicles',
      'no_vehicles',
    ]);
  });

  it('crea los borradores del sistema, con sus paradas en orden, y deja el día propuesto con el resumen', async () => {
    const { svc, manager, writer, data } = armar();
    const r = await svc.proponer(DIST, DIA);
    expect(data.choferes).toHaveBeenCalledWith(DIST, undefined, DIA);
    expect(data.vehiculos).toHaveBeenCalledWith(DIST, undefined, DIA);
    expect(r.sheets[0].sheetId).toBe('nueva-1');
    const creada = (manager.save.mock.calls as unknown[][])[0][0];
    expect(creada).toMatchObject({
      status: 'draft',
      kind: 'planned',
      proposedBy: 'system',
      optimizationMethod: 'nn_2opt',
      deliveryId: 'd1',
      carId: 'c1',
      originWarehouseId: DEPOSITO.warehouseId,
    });
    expect(writer.activarParada).toHaveBeenCalledTimes(3);
    expect(writer.escribirOrden).toHaveBeenCalledWith(
      manager,
      'nueva-1',
      r.sheets[0].orderIds,
    );
    expect(writer.recalcular).toHaveBeenCalledTimes(1);
    expect(manager.update).toHaveBeenCalledWith(
      RoutePlan,
      { distributorId: DIST, planDate: DIA },
      expect.objectContaining({
        status: 'proposed',
        proposalSummary: {
          candidates: 3,
          sheets: 1,
          unassigned: 0,
          method: 'sweep_nn_2opt',
          matrixSource: 'haversine',
        },
      }),
    );
  });

  it('re-proponer rehace los borradores del sistema sin editar y conserva confirmadas y editadas con su chofer y vehículo', async () => {
    const rehacer = hoja({ batchId: 'sistema', deliveryId: 'd1', carId: 'c1' });
    const editada = hoja({
      batchId: 'editada',
      deliveryId: 'd2',
      carId: 'c2',
      editedAt: new Date(),
    });
    const confirmada = hoja({
      batchId: 'confirmada',
      status: RouteBatchStatus.CONFIRMED,
      deliveryId: 'd3',
      carId: 'c3',
    });
    const manual = hoja({
      batchId: 'manual',
      proposedBy: RouteProposedBy.ADMIN,
      deliveryId: null,
      carId: null,
    });
    const cancelada = hoja({
      batchId: 'cancelada',
      status: RouteBatchStatus.DISSOLVED,
    });
    const fila = hoja({ batchId: 'sistema' });
    const { svc, data, writer } = armar({
      hojas: [rehacer, editada, confirmada, manual, cancelada],
      choferes: [
        chofer('d1', { usualCarId: 'c1' }),
        chofer('d2'),
        chofer('d3'),
        chofer('d4', { available: false }),
      ],
      vehiculos: [vehiculo('c1'), vehiculo('c2'), vehiculo('c3')],
      filaVieja: fila,
    });
    const r = await svc.proponer(DIST, DIA);
    expect(data.pedidosSinHoja).toHaveBeenCalledWith(DIST, DIA, ['sistema']);
    expect(r.keptSheetIds).toEqual(['editada', 'confirmada', 'manual']);
    // Sólo queda libre el par d1–c1.
    expect(r.sheets.map((s) => [s.deliveryId, s.carId])).toEqual([
      ['d1', 'c1'],
    ]);
    expect(writer.apagarTodas).toHaveBeenCalledWith(
      expect.anything(),
      'sistema',
      null,
    );
    expect(fila).toMatchObject({ status: 'dissolved', closeReason: 'admin' });
  });

  it('un borrador que alguien editó (o confirmó) en el medio no se pisa', async () => {
    const { svc, writer } = armar({
      hojas: [hoja({ batchId: 'sistema' })],
      filaVieja: hoja({
        batchId: 'sistema',
        status: RouteBatchStatus.CONFIRMED,
      }),
    });
    await svc.proponer(DIST, DIA);
    expect(writer.apagarTodas).not.toHaveBeenCalled();
    const { svc: svc2, writer: w2 } = armar({
      hojas: [hoja({ batchId: 'sistema' })],
      filaVieja: null,
    });
    await svc2.proponer(DIST, DIA);
    expect(w2.apagarTodas).not.toHaveBeenCalled();
  });

  it('revalida con los pedidos bloqueados: lo que el admin puso en otra hoja, lo cancelado o lo ofrecido en el medio queda sin hoja', async () => {
    const { svc, data, writer, manager } = armar({
      pedidos: [pedido('o1'), pedido('o2'), pedido('o3'), pedido('o4')],
      frescos: [
        pedido('o1', { activeBatchId: 'hoja-manual' }),
        pedido('o2', { status: 'cancelled' }),
        pedido('o3', { offeredNow: true }),
      ],
    });
    const r = await svc.proponer(DIST, DIA);
    expect((data.pedidos.mock.calls as unknown[][])[0][3]).toBe(true);
    expect((data.pedidos.mock.calls as unknown[][])[0][1]).toEqual([
      'o1',
      'o2',
      'o3',
      'o4',
    ]);
    expect(r.unassigned).toEqual([
      { orderId: 'o1', reason: 'in_route' },
      { orderId: 'o2', reason: 'not_plannable' },
      { orderId: 'o3', reason: 'dispatch_offer' },
      { orderId: 'o4', reason: 'not_plannable' },
    ]);
    // Nada que armar: no se crea ninguna hoja ni se activa ninguna parada.
    expect(r.sheets).toEqual([]);
    expect(writer.activarParada).not.toHaveBeenCalled();
    expect(manager.update).toHaveBeenCalledWith(
      RoutePlan,
      { distributorId: DIST, planDate: DIA },
      expect.objectContaining({
        proposalSummary: expect.objectContaining({
          sheets: 0,
          unassigned: 4,
        }) as object,
      }),
    );
  });

  it('con un pedido que se fue, la hoja se arma con los demás y los totales salen del recálculo', async () => {
    const { svc, writer } = armar({
      frescos: [
        pedido('o1'),
        pedido('o2', { activeBatchId: 'otra' }),
        pedido('o3'),
      ],
    });
    writer.recalcular.mockImplementation((_m: unknown, h: RouteBatch) => {
      Object.assign(h, {
        totalDistanceKm: 7.5,
        totalDurationMin: 33,
        totalUnits: 2,
        peakUnits: 2,
        totalWeightKg: 20,
      });
      return Promise.resolve();
    });
    const r = await svc.proponer(DIST, DIA);
    expect(r.sheets[0].orderIds.sort()).toEqual(['o1', 'o3']);
    expect(r.sheets[0]).toMatchObject({
      distanceKm: 7.5,
      durationMin: 33,
      units: 2,
      weightKg: 20,
    });
    expect(writer.activarParada).toHaveBeenCalledTimes(2);
  });

  it('sin depósito ubicado, la hoja sale sin depósito de origen', async () => {
    const a = armar();
    a.data.deposito.mockResolvedValueOnce(null);
    await a.svc.proponer(DIST, DIA);
    expect((a.manager.save.mock.calls as unknown[][])[0][0]).toMatchObject({
      originWarehouseId: null,
    });
  });
});

describe('emparejar', () => {
  it('primero cada chofer con su vehículo habitual; después los demás con los que sobran, en orden', () => {
    const pares = emparejar(
      [
        chofer('d1'),
        chofer('d2', { usualCarId: 'c2' }),
        chofer('d3', { usualCarId: 'ajeno' }),
        chofer('d4'),
      ],
      [
        vehiculo('c1'),
        vehiculo('c2'),
        vehiculo('c3', { capacityKg: null, capacityUnits: 10 }),
      ],
    );
    expect(pares).toEqual([
      { deliveryId: 'd2', carId: 'c2', capacityKg: 1000, capacityUnits: 50 },
      { deliveryId: 'd1', carId: 'c1', capacityKg: 1000, capacityUnits: 50 },
      { deliveryId: 'd3', carId: 'c3', capacityKg: null, capacityUnits: 10 },
    ]);
  });
});
