import { EntityManager } from 'typeorm';
import { ProcessConfigService } from '../../distributor/process-config.service';
import {
  RouteBatchStop,
  RouteStopRemovedReason,
} from '../../order/entities/route-batch-stop.entity';
import { instanteDelDia } from '../domain/route-sheet-rules';
import { RouteSheetDataService } from './route-sheet-data.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import {
  DEPOSITO,
  DIA,
  DIST,
  PARAMS,
  calculadora,
  hoja,
  parada,
  pedido,
} from './route-sheet.fixtures';

function armar(paradas: RouteBatchStop[] = [], deposito = DEPOSITO) {
  const pedidos = new Map(['o1', 'o2', 'o3'].map((id) => [id, pedido(id)]));
  const data = {
    pedidos: jest.fn((_d: string, ids: readonly string[]) =>
      Promise.resolve(ids.map((id) => pedidos.get(id)).filter(Boolean)),
    ),
    deposito: jest.fn().mockResolvedValue(deposito),
  };
  const processConfig = {
    obtener: jest.fn().mockResolvedValue({
      ...PARAMS,
      enabled: 1,
      cutoffHour: 18,
    }),
  };
  const manager = {
    find: jest.fn().mockResolvedValue(paradas),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
    query: jest.fn().mockResolvedValue([{ ultima: 2 }]),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
  };
  const writer = new RouteSheetWriter(
    data as unknown as RouteSheetDataService,
    calculadora(),
    processConfig as unknown as ProcessConfigService,
  );
  return {
    writer,
    data,
    manager,
    processConfig,
    m: manager as unknown as EntityManager,
  };
}

describe('RouteSheetWriter', () => {
  it('parametros: los tres que usa el cálculo, del proceso route_planning', async () => {
    const { writer } = armar();
    expect(await writer.parametros(DIST)).toEqual(PARAMS);
  });

  it('paradasActivas: las activas en orden y con la fila bloqueada', async () => {
    const { writer, manager, m } = armar([parada('o1', 1)]);
    await writer.paradasActivas(m, 'hoja-1');
    expect(manager.find).toHaveBeenCalledWith(RouteBatchStop, {
      where: { batchId: 'hoja-1', active: true },
      order: { sequence: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('estado: los pedidos en el orden de las paradas, las fijadas y la salida por omisión (8:00 o media hora antes de la primera franja)', async () => {
    const { writer, m } = armar([
      parada('o2', 1, { sequenceLocked: true }),
      parada('o1', 2),
      parada('fantasma', 3),
    ]);
    const e = await writer.estado(m, hoja(), PARAMS);
    expect(e.orden).toEqual(['o2', 'o1', 'fantasma']);
    expect(e.pedidos.map((p) => p.orderId)).toEqual(['o2', 'o1']);
    expect(e.startMs).toBe(instanteDelDia(DIA, '07:30'));
    expect(e.escenario.stops.find((s) => s.id === 'o2')?.locked).toBe(true);
  });

  it('paradasActivas y estado sin bloquear (lecturas fuera de una transacción) no piden lock', async () => {
    const { writer, manager, m } = armar([parada('o1', 1)]);
    await writer.paradasActivas(m, 'hoja-1', false);
    expect((manager.find.mock.calls as unknown[][])[0][1]).toEqual({
      where: { batchId: 'hoja-1', active: true },
      order: { sequence: 'ASC' },
    });
    await writer.estado(m, hoja(), PARAMS, ['o1'], false);
    expect((manager.find.mock.calls as unknown[][])[1][1]).not.toHaveProperty(
      'lock',
    );
  });

  it('estado: con un orden pedido lo usa; con salida cargada en la hoja, también', async () => {
    const { writer, m } = armar([parada('o1', 1)]);
    const salida = new Date('2026-11-14T13:00:00Z');
    const e = await writer.estado(m, hoja({ plannedStartAt: salida }), PARAMS, [
      'o3',
      'o1',
    ]);
    expect(e.orden).toEqual(['o3', 'o1']);
    expect(e.startMs).toBe(salida.getTime());
  });

  it('escribirOrden: corre las secuencias lejos y después las numera 1..n; sin paradas no hace nada', async () => {
    const { writer, manager, m } = armar();
    await writer.escribirOrden(m, 'hoja-1', []);
    expect(manager.query).not.toHaveBeenCalled();
    await writer.escribirOrden(m, 'hoja-1', ['o2', 'o1']);
    expect((manager.query.mock.calls as unknown[][])[0][1]).toEqual([
      'hoja-1',
      100_000,
    ]);
    expect((manager.query.mock.calls as unknown[][])[1][1]).toEqual([
      'hoja-1',
      ['o2', 'o1'],
    ]);
    expect((manager.query.mock.calls as unknown[][])[1][0]).toContain(
      'WITH ORDINALITY',
    );
  });

  it('activarParada: una parada nueva entra al final con una secuencia temporal alta', async () => {
    const { writer, manager, m } = armar();
    await writer.activarParada(m, 'hoja-1', 'o3', true);
    expect(manager.insert).toHaveBeenCalledWith(RouteBatchStop, {
      batchId: 'hoja-1',
      orderId: 'o3',
      sequence: 200_001,
      active: true,
      sequenceLocked: true,
      legDistanceKm: 0,
    });
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('activarParada: si el pedido ya estuvo en la hoja, reactiva su fila y borra la ETA prometida', async () => {
    const { writer, manager, m } = armar();
    manager.query.mockResolvedValueOnce([{ ultima: 300_000 }]);
    manager.findOne.mockResolvedValueOnce(parada('o3', 4, { active: false }));
    await writer.activarParada(m, 'hoja-1', 'o3', false);
    expect(manager.update).toHaveBeenCalledWith(
      RouteBatchStop,
      { stopId: 's-o3' },
      expect.objectContaining({
        active: true,
        removedAt: null,
        removedReason: null,
        sequenceLocked: false,
        sequence: 300_001,
        plannedEtaAt: null,
      }),
    );
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('activarParada: si otra operación activó el pedido en el medio (único de parada activa), 409 ORDER_ALREADY_IN_ROUTE y no un 500', async () => {
    const { writer, manager, m } = armar();
    manager.insert.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'UQ_route_batch_stop_pedido_activo',
      }),
    );
    await expect(
      writer.activarParada(m, 'hoja-1', 'o3', false),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'ORDER_ALREADY_IN_ROUTE' },
    });
    manager.findOne.mockResolvedValueOnce(parada('o3', 4, { active: false }));
    manager.update.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key'), {
        driverError: {
          code: '23505',
          constraint: 'UQ_route_batch_stop_pedido_activo',
        },
      }),
    );
    await expect(
      writer.activarParada(m, 'hoja-1', 'o3', false),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_ALREADY_IN_ROUTE' },
    });
  });

  it('activarParada: otro error de la base se propaga tal cual', async () => {
    const { writer, manager, m } = armar();
    const otro = Object.assign(new Error('otra'), {
      code: '23505',
      constraint: 'UQ_route_batch_stop_secuencia',
    });
    manager.insert.mockRejectedValueOnce(otro);
    await expect(writer.activarParada(m, 'hoja-1', 'o3', false)).rejects.toBe(
      otro,
    );
  });

  it('sugiereTardios: sólo con lateOrderPolicy = 1', async () => {
    const { writer } = armar();
    expect(await writer.sugiereTardios(DIST)).toBe(false);
    const { writer: w2, processConfig } = armar();
    processConfig.obtener.mockResolvedValueOnce({ lateOrderPolicy: 1 });
    expect(await w2.sugiereTardios(DIST)).toBe(true);
  });

  it('apagarParada y apagarTodas: borrado lógico con motivo (o sin motivo, al rehacer una propuesta)', async () => {
    const { writer, manager, m } = armar();
    await writer.apagarParada(m, 'hoja-1', 'o1', RouteStopRemovedReason.MOVED);
    expect((manager.update.mock.calls as unknown[][])[0][1]).toEqual({
      batchId: 'hoja-1',
      orderId: 'o1',
      active: true,
    });
    expect((manager.update.mock.calls as unknown[][])[0][2]).toMatchObject({
      active: false,
      removedReason: 'moved',
    });
    await writer.apagarTodas(m, 'hoja-1', RouteStopRemovedReason.ADMIN);
    expect((manager.update.mock.calls as unknown[][])[1][2]).toMatchObject({
      active: false,
      removedReason: 'admin',
    });
    await writer.apagarTodas(m, 'hoja-1', null);
    expect((manager.update.mock.calls as unknown[][])[2][2]).toEqual({
      active: false,
    });
  });

  it('recalcular: guarda ETA y tramo de cada parada y los totales de la hoja', async () => {
    const { writer, manager, m } = armar([parada('o1', 1), parada('o2', 2)]);
    const h = hoja();
    await writer.recalcular(m, h, PARAMS);
    const porParada = (manager.update.mock.calls as unknown[][]).filter(
      (c) => c[0] === RouteBatchStop,
    );
    expect(porParada).toHaveLength(2);
    expect(porParada[0][2]).toEqual(
      expect.objectContaining({
        etaAt: expect.any(Date) as Date,
        legDistanceKm: expect.any(Number) as number,
      }),
    );
    expect(h.totalDistanceKm).toBeGreaterThan(0);
    expect(h.totalDurationMin).toBeGreaterThan(0);
    expect(h.totalUnits).toBe(2);
    expect(h.totalWeightKg).toBe(20);
    expect(h.matrixSource).toBe('haversine');
    expect(manager.save).toHaveBeenCalledWith(h);
  });

  it('recalcular: una hoja vacía queda en cero', async () => {
    const { writer, m } = armar([], null as never);
    const h = hoja({ totalDistanceKm: 9, totalDurationMin: 9 });
    await writer.recalcular(m, h, PARAMS);
    expect([h.totalDistanceKm, h.totalDurationMin, h.totalUnits]).toEqual([
      0, 0, 0,
    ]);
  });
});
