import { EntityManager } from 'typeorm';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { instanteDelDia } from '../domain/route-sheet-rules';
import { RoutePlanService } from './route-plan.service';
import {
  PedidoDeHoja,
  RouteSheetDataService,
} from './route-sheet-data.service';
import { RouteSheetEditingService } from './route-sheet-editing.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
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
} from './route-sheet.fixtures';

/**
 * El servicio corre contra un writer en memoria: cada hoja tiene su orden de
 * paradas y los escenarios salen de la calculadora real (línea recta), así
 * que la inserción y la optimización se prueban con los algoritmos de verdad.
 */
function armar(
  o: {
    hojas?: RouteBatch[];
    paradas?: Record<string, string[]>;
    pedidos?: PedidoDeHoja[];
  } = {},
) {
  const hojas = new Map((o.hojas ?? [hoja()]).map((h) => [h.batchId, h]));
  const orden = new Map(
    Object.entries(o.paradas ?? { 'hoja-1': ['o1', 'o2'] }),
  );
  const fijadas = new Set<string>();
  const pedidos = new Map(
    (o.pedidos ?? ['o1', 'o2', 'o3', 'o4', 'o5'].map((id) => pedido(id))).map(
      (p) => [p.orderId, p],
    ),
  );
  const manager = {
    save: jest.fn((x: RouteBatch) => {
      hojas.set(
        x.batchId ?? 'nueva',
        Object.assign(x, { batchId: x.batchId ?? 'nueva' }),
      );
      return Promise.resolve(x);
    }),
    create: jest.fn((_e: unknown, x: Partial<RouteBatch>) =>
      Object.assign(new RouteBatch(), x),
    ),
    update: jest.fn().mockResolvedValue({}),
  };
  const m = manager as unknown as EntityManager;
  const escenarioDe = async (
    h: RouteBatch,
    ids: readonly string[],
  ): Promise<EstadoDeHoja> => {
    const enOrden = ids
      .map((id) => pedidos.get(id))
      .filter((p): p is PedidoDeHoja => !!p);
    const startMs = instanteDelDia(DIA, '07:30');
    return {
      pedidos: enOrden,
      orden: [...ids],
      startMs,
      escenario: await calculadora().escenario(
        enOrden,
        DEPOSITO,
        startMs,
        PARAMS,
        fijadas,
      ),
    };
  };
  const writer = {
    parametros: jest.fn().mockResolvedValue(PARAMS),
    paradasActivas: jest.fn((_m: unknown, id: string) =>
      Promise.resolve(
        (orden.get(id) ?? []).map((oid, i) =>
          parada(oid, i + 1, { batchId: id, sequenceLocked: fijadas.has(oid) }),
        ),
      ),
    ),
    estado: jest.fn(
      (_m: unknown, h: RouteBatch, _p: unknown, ids?: readonly string[]) =>
        escenarioDe(h, ids ?? orden.get(h.batchId) ?? []),
    ),
    escribirOrden: jest.fn(
      (_m: unknown, id: string, ids: readonly string[]) => {
        orden.set(id, [...ids]);
        return Promise.resolve();
      },
    ),
    activarParada: jest.fn(
      (_m: unknown, _id: string, oid: string, lock: boolean) => {
        if (lock) fijadas.add(oid);
        return Promise.resolve();
      },
    ),
    apagarParada: jest.fn().mockResolvedValue(undefined),
    recalcular: jest.fn((_m: unknown, h: RouteBatch) =>
      escenarioDe(h, orden.get(h.batchId) ?? []),
    ),
  };
  const locks = {
    conHojas: jest.fn(
      (
        _d: string,
        pedidas: Array<{ id: string }>,
        fn: (m: EntityManager, h: RouteBatch[]) => unknown,
      ) =>
        fn(
          m,
          pedidas.map((p) => hojas.get(p.id) as RouteBatch),
        ),
    ),
  };
  const data = {
    pedidos: jest.fn((_d: string, ids: readonly string[]) =>
      Promise.resolve(ids.map((id) => pedidos.get(id)).filter(Boolean)),
    ),
    choferes: jest.fn((_d: string, ids: string[]) =>
      Promise.resolve(ids.includes('chofer-x') ? [] : [{ deliveryId: ids[0] }]),
    ),
    vehiculos: jest.fn((_d: string, ids: string[]) =>
      Promise.resolve(
        ids.includes('auto-x')
          ? []
          : [{ carId: ids[0], capacityKg: 1000, capacityUnits: 50 }],
      ),
    ),
    existeDeposito: jest.fn((_d: string, id: string) =>
      Promise.resolve(id !== 'dep-x'),
    ),
    ocupadosDelDia: jest.fn().mockResolvedValue({
      deliveryIds: new Set(['chofer-ocupado']),
      carIds: new Set(['auto-ocupado']),
    }),
  };
  const plans = {
    abrirParaEditar: jest.fn().mockResolvedValue({}),
    enElDia: jest.fn(
      (_d: string, _f: string, fn: (m: EntityManager) => unknown) => fn(m),
    ),
  };
  const svc = new RouteSheetEditingService(
    locks as unknown as RouteSheetLocks,
    writer as unknown as RouteSheetWriter,
    data as unknown as RouteSheetDataService,
    plans as unknown as RoutePlanService,
  );
  return { svc, hojas, orden, fijadas, manager, writer, data, plans, locks };
}

const conCodigo = (code: string) => ({ response: { code } });

describe('RouteSheetEditingService', () => {
  describe('crear', () => {
    it('abre el día, crea el borrador manual con sus pedidos en orden y lo recalcula', async () => {
      const { svc, orden, hojas, plans, writer, data } = armar({
        hojas: [],
        paradas: {},
      });
      const id = await svc.crear(DIST, {
        planDate: DIA,
        deliveryId: 'd1',
        carId: 'c1',
        orderIds: ['o3', 'o1'],
      });
      expect(plans.abrirParaEditar).toHaveBeenCalledWith(DIST, DIA);
      expect(orden.get(id)).toEqual(['o3', 'o1']);
      expect(hojas.get(id)).toMatchObject({
        status: 'draft',
        kind: 'planned',
        proposedBy: 'admin',
        optimizationMethod: 'manual',
        deliveryId: 'd1',
        carId: 'c1',
      });
      expect(writer.recalcular).toHaveBeenCalled();
      // El pedido se lee con su fila bloqueada (no se cruza con una asignación manual).
      expect(data.pedidos).toHaveBeenCalledWith(
        DIST,
        ['o3'],
        expect.anything(),
        true,
      );
      // Antes del alta, todos los pedidos bloqueados de una vez y en orden de id.
      expect(data.pedidos).toHaveBeenCalledWith(
        DIST,
        ['o1', 'o3'],
        expect.anything(),
        true,
      );
    });

    it('sin chofer ni vehículo ni pedidos también (hoja vacía)', async () => {
      const { svc, hojas, data } = armar({ hojas: [], paradas: {} });
      const id = await svc.crear(DIST, { planDate: DIA });
      expect(hojas.get(id)).toMatchObject({ deliveryId: null, carId: null });
      expect(data.choferes).not.toHaveBeenCalled();
    });

    it('404 si el chofer o el vehículo no son de la distribuidora; 409 con más pedidos que el máximo', async () => {
      const { svc } = armar({ hojas: [], paradas: {} });
      await expect(
        svc.crear(DIST, { planDate: DIA, deliveryId: 'chofer-x' }),
      ).rejects.toMatchObject(conCodigo('DRIVER_NOT_FOUND'));
      await expect(
        svc.crear(DIST, { planDate: DIA, carId: 'auto-x' }),
      ).rejects.toMatchObject(conCodigo('CAR_NOT_FOUND'));
      const muchos = Array.from({ length: 21 }, (_, i) => `o${i}`);
      await expect(
        svc.crear(DIST, { planDate: DIA, orderIds: muchos }),
      ).rejects.toMatchObject(conCodigo('ROUTE_STOP_NOT_FEASIBLE'));
    });

    it('404 pedido ajeno, 409 pedido ya en otra hoja y 409 pedido de otro día', async () => {
      const { svc } = armar({
        hojas: [],
        paradas: {},
        pedidos: [
          pedido('o1', { activeBatchId: 'otra' }),
          pedido('o2', { scheduledDate: '2026-11-20' }),
        ],
      });
      await expect(
        svc.crear(DIST, { planDate: DIA, orderIds: ['o9'] }),
      ).rejects.toMatchObject(conCodigo('ORDER_NOT_FOUND'));
      await expect(
        svc.crear(DIST, { planDate: DIA, orderIds: ['o1'] }),
      ).rejects.toMatchObject(conCodigo('ORDER_ALREADY_IN_ROUTE'));
      await expect(
        svc.crear(DIST, { planDate: DIA, orderIds: ['o2'] }),
      ).rejects.toMatchObject({
        response: {
          code: 'ORDER_NOT_PLANNABLE',
          message:
            'El pedido no se puede planificar: está programado para otro día',
        },
      });
    });
  });

  describe('editar', () => {
    it('cambia chofer, vehículo, depósito y salida, marca la edición y recalcula', async () => {
      const { svc, hojas, writer } = armar();
      await svc.editar(DIST, 'hoja-1', {
        version: 3,
        deliveryId: 'd2',
        carId: 'c2',
        originWarehouseId: 'dep-2',
        plannedStartAt: '2026-11-14T10:00:00Z',
      });
      const h = hojas.get('hoja-1') as RouteBatch;
      expect(h).toMatchObject({
        deliveryId: 'd2',
        carId: 'c2',
        originWarehouseId: 'dep-2',
      });
      expect(h.plannedStartAt?.toISOString()).toBe('2026-11-14T10:00:00.000Z');
      expect(h.editedAt).toBeInstanceOf(Date);
      expect(writer.recalcular).toHaveBeenCalled();
    });

    it('sólo la versión: no toca los datos', async () => {
      const { svc, hojas } = armar();
      await svc.editar(DIST, 'hoja-1', { version: 3 });
      expect(hojas.get('hoja-1')).toMatchObject({
        deliveryId: 'chofer-1',
        carId: 'auto-1',
        plannedStartAt: null,
      });
    });

    it('404 depósito/chofer/vehículo ajeno; 409 chofer o vehículo con otra hoja ese día; 409 no editable', async () => {
      const { svc } = armar();
      await expect(
        svc.editar(DIST, 'hoja-1', { version: 3, originWarehouseId: 'dep-x' }),
      ).rejects.toMatchObject(conCodigo('WAREHOUSE_NOT_FOUND'));
      await expect(
        svc.editar(DIST, 'hoja-1', { version: 3, deliveryId: 'chofer-x' }),
      ).rejects.toMatchObject(conCodigo('DRIVER_NOT_FOUND'));
      await expect(
        svc.editar(DIST, 'hoja-1', { version: 3, carId: 'auto-x' }),
      ).rejects.toMatchObject(conCodigo('CAR_NOT_FOUND'));
      await expect(
        svc.editar(DIST, 'hoja-1', {
          version: 3,
          deliveryId: 'chofer-ocupado',
        }),
      ).rejects.toMatchObject(conCodigo('ROUTE_SHEET_DRIVER_TAKEN'));
      await expect(
        svc.editar(DIST, 'hoja-1', { version: 3, carId: 'auto-ocupado' }),
      ).rejects.toMatchObject(conCodigo('ROUTE_SHEET_CAR_TAKEN'));
      const confirmada = armar({
        hojas: [hoja({ status: RouteBatchStatus.CONFIRMED })],
      });
      await expect(
        confirmada.svc.editar(DIST, 'hoja-1', { version: 3 }),
      ).rejects.toMatchObject(conCodigo('ROUTE_SHEET_NOT_EDITABLE'));
    });
  });

  describe('agregar', () => {
    it('en la posición pedida (acotada a la hoja) y fijada', async () => {
      const { svc, orden, fijadas } = armar();
      await svc.agregar(DIST, 'hoja-1', {
        version: 3,
        orderId: 'o3',
        position: 1,
        lock: true,
      });
      expect(orden.get('hoja-1')).toEqual(['o3', 'o1', 'o2']);
      expect(fijadas.has('o3')).toBe(true);
      await svc.agregar(DIST, 'hoja-1', {
        version: 3,
        orderId: 'o4',
        position: 99,
      });
      expect(orden.get('hoja-1')).toEqual(['o3', 'o1', 'o2', 'o4']);
      await svc.agregar(DIST, 'hoja-1', {
        version: 3,
        orderId: 'o5',
        position: 0,
      });
      expect(orden.get('hoja-1')?.[0]).toBe('o5');
    });

    it('sin posición, en la inserción más barata (respeta la capacidad del vehículo)', async () => {
      const { svc, orden, data } = armar();
      await svc.agregar(DIST, 'hoja-1', { version: 3, orderId: 'o3' });
      expect(orden.get('hoja-1')).toHaveLength(3);
      expect(orden.get('hoja-1')).toContain('o3');
      expect(data.vehiculos).toHaveBeenCalledWith(DIST, ['auto-1']);
    });

    it('sin vehículo no controla la capacidad', async () => {
      const { svc, orden, data } = armar({ hojas: [hoja({ carId: null })] });
      await svc.agregar(DIST, 'hoja-1', { version: 3, orderId: 'o3' });
      expect(orden.get('hoja-1')).toContain('o3');
      expect(data.vehiculos).not.toHaveBeenCalled();
    });

    it('409 si no llega en su franja en ninguna posición, salvo que se acepte tarde', async () => {
      const tarde = pedido('o3', {
        slotStartMs: instanteDelDia(DIA, '07:00'),
        slotEndMs: instanteDelDia(DIA, '07:31'),
      });
      const { svc, orden } = armar({
        pedidos: [pedido('o1'), pedido('o2'), tarde],
      });
      await expect(
        svc.agregar(DIST, 'hoja-1', { version: 3, orderId: 'o3' }),
      ).rejects.toMatchObject({
        response: {
          code: 'ROUTE_STOP_NOT_FEASIBLE',
          message:
            'El pedido no entra en la hoja: no llega dentro de su franja en ninguna posición',
        },
      });
      await svc.agregar(DIST, 'hoja-1', {
        version: 3,
        orderId: 'o3',
        acceptLateStops: true,
      });
      expect(orden.get('hoja-1')).toContain('o3');
    });

    it('en la posición pedida también se controlan franja y capacidad', async () => {
      const tarde = pedido('o3', {
        slotStartMs: instanteDelDia(DIA, '07:00'),
        slotEndMs: instanteDelDia(DIA, '07:40'),
      });
      const pesado = pedido('o4', { weightKg: 5000 });
      const { svc, orden } = armar({
        pedidos: [pedido('o1'), pedido('o2'), tarde, pesado],
      });
      await expect(
        svc.agregar(DIST, 'hoja-1', { version: 3, orderId: 'o3', position: 3 }),
      ).rejects.toMatchObject({
        response: { code: 'ROUTE_STOP_NOT_FEASIBLE' },
      });
      await expect(
        svc.agregar(DIST, 'hoja-1', {
          version: 3,
          orderId: 'o4',
          position: 1,
          acceptLateStops: true,
        }),
      ).rejects.toMatchObject({
        response: {
          message:
            'El pedido no entra en la hoja: supera la capacidad del vehículo',
        },
      });
      await svc.agregar(DIST, 'hoja-1', {
        version: 3,
        orderId: 'o3',
        position: 3,
        acceptLateStops: true,
      });
      expect(orden.get('hoja-1')).toEqual(['o1', 'o2', 'o3']);
    });

    it('409 si supera la capacidad del vehículo', async () => {
      const pesado = pedido('o3', { weightKg: 5000 });
      const { svc } = armar({ pedidos: [pedido('o1'), pedido('o2'), pesado] });
      await expect(
        svc.agregar(DIST, 'hoja-1', { version: 3, orderId: 'o3' }),
      ).rejects.toMatchObject({
        response: {
          message:
            'El pedido no entra en la hoja: supera la capacidad del vehículo',
        },
      });
    });

    it('409 si la hoja llegó al máximo de paradas', async () => {
      const ids = Array.from({ length: 21 }, (_, i) => `o${i + 1}`);
      const { svc } = armar({
        paradas: { 'hoja-1': ids.slice(0, 20) },
        pedidos: ids.map((id) => pedido(id)),
      });
      await expect(
        svc.agregar(DIST, 'hoja-1', { version: 3, orderId: 'o21' }),
      ).rejects.toMatchObject({
        response: {
          message:
            'El pedido no entra en la hoja: la hoja llegó al máximo de paradas',
        },
      });
    });
  });

  describe('quitar', () => {
    it('apaga la parada (admin), renumera las demás y recalcula', async () => {
      const { svc, orden, writer } = armar();
      await svc.quitar(DIST, 'hoja-1', 'o1', 3);
      expect(writer.apagarParada).toHaveBeenCalledWith(
        expect.anything(),
        'hoja-1',
        'o1',
        'admin',
      );
      expect(orden.get('hoja-1')).toEqual(['o2']);
    });

    it('404 si el pedido no es parada de la hoja', async () => {
      const { svc } = armar();
      await expect(svc.quitar(DIST, 'hoja-1', 'o9', 3)).rejects.toMatchObject(
        conCodigo('ROUTE_STOP_NOT_FOUND'),
      );
    });
  });

  describe('mover', () => {
    const dos = () =>
      armar({
        hojas: [
          hoja(),
          hoja({ batchId: 'hoja-2', deliveryId: 'chofer-2', carId: 'auto-2' }),
        ],
        paradas: { 'hoja-1': ['o1', 'o2'], 'hoja-2': ['o3'] },
      });

    it('saca la parada de una hoja (moved) y la pone en la otra, conservando si estaba fijada', async () => {
      const { svc, orden, writer, hojas } = dos();
      await svc.mover(DIST, 'hoja-1', 'o2', {
        version: 3,
        targetSheetId: 'hoja-2',
        targetVersion: 3,
        position: 1,
      });
      expect(orden.get('hoja-1')).toEqual(['o1']);
      expect(orden.get('hoja-2')).toEqual(['o2', 'o3']);
      expect(writer.apagarParada).toHaveBeenCalledWith(
        expect.anything(),
        'hoja-1',
        'o2',
        'moved',
      );
      expect(writer.activarParada).toHaveBeenCalledWith(
        expect.anything(),
        'hoja-2',
        'o2',
        false,
      );
      expect(hojas.get('hoja-1')?.editedAt).toEqual(
        hojas.get('hoja-2')?.editedAt,
      );
      expect(writer.recalcular).toHaveBeenCalledTimes(2);
    });

    it('a una posición donde queda fuera de franja: 409, salvo acceptLateStops', async () => {
      const tarde = pedido('o2', {
        slotStartMs: instanteDelDia(DIA, '07:00'),
        slotEndMs: instanteDelDia(DIA, '07:40'),
      });
      const { svc, orden } = armar({
        hojas: [
          hoja(),
          hoja({ batchId: 'hoja-2', deliveryId: 'chofer-2', carId: 'auto-2' }),
        ],
        paradas: { 'hoja-1': ['o2'], 'hoja-2': ['o3', 'o4', 'o5'] },
        pedidos: [tarde, pedido('o3'), pedido('o4'), pedido('o5')],
      });
      const mover = (acceptLateStops?: boolean) =>
        svc.mover(DIST, 'hoja-1', 'o2', {
          version: 3,
          targetSheetId: 'hoja-2',
          targetVersion: 3,
          position: 3,
          acceptLateStops,
        });
      await expect(mover()).rejects.toMatchObject({
        response: {
          code: 'ROUTE_STOP_NOT_FEASIBLE',
          message:
            'El pedido no entra en la hoja: no llega dentro de su franja en ninguna posición',
        },
      });
      // El writer en memoria no hace rollback (la base sí): se repone la parada.
      orden.set('hoja-1', ['o2']);
      await mover(true);
      expect(orden.get('hoja-2')).toEqual(['o3', 'o4', 'o2', 'o5']);
    });

    it('sin posición, la inserción más barata', async () => {
      const { svc, orden } = dos();
      await svc.mover(DIST, 'hoja-1', 'o1', {
        version: 3,
        targetSheetId: 'hoja-2',
        targetVersion: 3,
      });
      expect(orden.get('hoja-2')?.sort()).toEqual(['o1', 'o3']);
    });

    it('400 a la misma hoja, 409 a otro día, 404 parada ajena, 409 si alguna no es borrador', async () => {
      const { svc, hojas } = dos();
      await expect(
        svc.mover(DIST, 'hoja-1', 'o1', {
          version: 3,
          targetSheetId: 'hoja-1',
          targetVersion: 3,
        }),
      ).rejects.toMatchObject(conCodigo('ROUTE_SHEET_SAME_TARGET'));
      await expect(
        svc.mover(DIST, 'hoja-1', 'o3', {
          version: 3,
          targetSheetId: 'hoja-2',
          targetVersion: 3,
        }),
      ).rejects.toMatchObject(conCodigo('ROUTE_STOP_NOT_FOUND'));
      (hojas.get('hoja-2') as RouteBatch).planDate = '2026-11-15';
      await expect(
        svc.mover(DIST, 'hoja-1', 'o1', {
          version: 3,
          targetSheetId: 'hoja-2',
          targetVersion: 3,
        }),
      ).rejects.toMatchObject(conCodigo('ROUTE_SHEET_OTHER_DAY'));
      (hojas.get('hoja-2') as RouteBatch).status = RouteBatchStatus.CONFIRMED;
      await expect(
        svc.mover(DIST, 'hoja-1', 'o1', {
          version: 3,
          targetSheetId: 'hoja-2',
          targetVersion: 3,
        }),
      ).rejects.toMatchObject(conCodigo('ROUTE_SHEET_NOT_EDITABLE'));
    });
  });

  describe('ordenar', () => {
    it('escribe el orden del admin, marca las fijadas y queda como manual', async () => {
      const { svc, orden, manager, hojas } = armar();
      await svc.ordenar(DIST, 'hoja-1', {
        version: 3,
        orderIds: ['o2', 'o1'],
        locked: ['o2'],
      });
      expect(orden.get('hoja-1')).toEqual(['o2', 'o1']);
      expect(manager.update).toHaveBeenCalledWith(
        'route_batch_stop',
        { stopId: 's-o2' },
        { sequenceLocked: true },
      );
      expect(manager.update).toHaveBeenCalledWith(
        'route_batch_stop',
        { stopId: 's-o1' },
        { sequenceLocked: false },
      );
      expect(hojas.get('hoja-1')?.optimizationMethod).toBe('manual');
    });

    it('sin locked no toca las fijadas', async () => {
      const { svc, manager } = armar();
      await svc.ordenar(DIST, 'hoja-1', { version: 3, orderIds: ['o2', 'o1'] });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('400 si no son exactamente las paradas o si fija una que no está', async () => {
      const { svc } = armar();
      await expect(
        svc.ordenar(DIST, 'hoja-1', { version: 3, orderIds: ['o1'] }),
      ).rejects.toMatchObject(conCodigo('ROUTE_SHEET_SEQUENCE_INVALID'));
      await expect(
        svc.ordenar(DIST, 'hoja-1', {
          version: 3,
          orderIds: ['o2', 'o1'],
          locked: ['o9'],
        }),
      ).rejects.toMatchObject(conCodigo('ROUTE_SHEET_SEQUENCE_INVALID'));
    });
  });

  describe('optimizar', () => {
    it('devuelve antes y después; el orden óptimo no es peor que el que había', async () => {
      const lejos = pedido('o3', {
        lat: DEPOSITO.lat + 0.2,
        lng: DEPOSITO.lng + 0.2,
      });
      const { svc, orden, hojas } = armar({
        paradas: { 'hoja-1': ['o3', 'o1', 'o2'] },
        pedidos: [pedido('o1'), pedido('o2'), lejos],
      });
      const r = await svc.optimizar(DIST, 'hoja-1', 3);
      expect(r.after.distanceKm).toBeLessThanOrEqual(r.before.distanceKm);
      expect(r.before.durationMin).toBeGreaterThan(0);
      expect(orden.get('hoja-1')?.sort()).toEqual(['o1', 'o2', 'o3']);
      expect(hojas.get('hoja-1')?.optimizationMethod).toBe('nn_2opt');
    });

    it('una hoja vacía da cero antes y después', async () => {
      const { svc } = armar({ paradas: { 'hoja-1': [] } });
      const r = await svc.optimizar(DIST, 'hoja-1', 3);
      expect(r).toEqual({
        before: { durationMin: 0, distanceKm: 0, lateStops: 0 },
        after: { durationMin: 0, distanceKm: 0, lateStops: 0 },
      });
    });
  });
});
