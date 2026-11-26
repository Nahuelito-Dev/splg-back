import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { DeliveryService } from '../../delivery/delivery.service';
import { OrderStatus } from '../../order/entities/order.entity';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import { RouteStopRemovedReason } from '../../order/entities/route-batch-stop.entity';
import { OrderService } from '../../order/order.service';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { RouteSheetAssignmentService } from './route-sheet-assignment.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import { DIST, hoja, parada } from './route-sheet.fixtures';

const HOY = diaArgentino();

function armar(
  o: {
    sheet?: RouteBatch;
    paradas?: string[];
    estados?: Record<
      string,
      { status: OrderStatus; deliveryId: string | null }
    >;
    asignar?: (orderId: string) => Promise<unknown>;
    chofer?: boolean;
    deHoy?: Array<{ batchId: string; distributorId: string }>;
  } = {},
) {
  const sheet =
    o.sheet ?? hoja({ status: RouteBatchStatus.CONFIRMED, planDate: HOY });
  const ids = o.paradas ?? ['o1', 'o2'];
  const query = jest.fn((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM "car"')) {
      return Promise.resolve([
        { carId: 'auto-1', patent: 'AB123CD', brand: 'Ford', model: 'F-100' },
      ]);
    }
    if (sql.includes('"assigned_at" IS NULL')) {
      return Promise.resolve(o.deHoy ?? []);
    }
    if (sql.includes('FROM "order"')) {
      const pedidos = (params?.[0] ?? []) as string[];
      return Promise.resolve(
        pedidos.map((orderId) => ({
          orderId,
          ...(o.estados?.[orderId] ?? {
            status: OrderStatus.PENDING,
            deliveryId: null,
          }),
        })),
      );
    }
    return Promise.resolve([]);
  });
  const save = jest.fn().mockResolvedValue(undefined);
  const locks = {
    conCerrojo: jest.fn((_ids: string[], fn: () => unknown) => fn()),
    enTransaccion: jest.fn(
      (
        _d: string,
        _p: unknown,
        fn: (m: EntityManager, h: RouteBatch[]) => unknown,
      ) => fn({ save } as unknown as EntityManager, [sheet]),
    ),
  };
  const writer = {
    paradasActivas: jest
      .fn()
      .mockResolvedValue(ids.map((id, i) => parada(id, i + 1))),
    apagarParada: jest.fn().mockResolvedValue(undefined),
  };
  const orders = {
    assignDelivery: jest.fn((orderId: string) =>
      o.asignar ? o.asignar(orderId) : Promise.resolve({}),
    ),
    updateStatus: jest.fn().mockResolvedValue({}),
  };
  const deliveries = {
    findById: jest.fn().mockResolvedValue(
      o.chofer === false
        ? null
        : {
            deliveryId: 'chofer-1',
            userId: 'u-chofer',
            notificationToken: 'tok',
          },
    ),
  };
  const notifier = {
    alChofer: jest.fn(),
    alPanel: jest.fn(),
    pushAlChofer: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new RouteSheetAssignmentService(
    { query, manager: {} } as unknown as DataSource,
    locks as unknown as RouteSheetLocks,
    writer as unknown as RouteSheetWriter,
    orders as unknown as OrderService,
    deliveries as unknown as DeliveryService,
    notifier as unknown as RouteSheetNotifier,
  );
  return { svc, sheet, save, locks, writer, orders, notifier };
}

describe('RouteSheetAssignmentService', () => {
  it('la hoja confirmada de hoy: cada pedido se le asigna al chofer con el vehículo de la hoja y sin aviso por pedido; avisa una vez', async () => {
    const t = armar();
    const r = await t.svc.asignarHoja(DIST, 'hoja-1', 'u-admin');
    expect(r).toEqual({
      sheetId: 'hoja-1',
      assignedOrderIds: ['o1', 'o2'],
      droppedOrderIds: [],
      skipped: false,
    });
    expect(t.locks.conCerrojo).toHaveBeenCalledWith(
      ['hoja-1'],
      expect.any(Function),
    );
    expect(t.orders.assignDelivery).toHaveBeenCalledWith(
      'o1',
      'chofer-1',
      DIST,
      {
        soloSiLibre: true,
        metodo: 'route_sheet',
        hojaDeRuta: 'hoja-1',
        vehiculoDeLaHoja: {
          carId: 'auto-1',
          patent: 'AB123CD',
          brand: 'Ford',
          model: 'F-100',
        },
      },
    );
    expect(t.sheet.assignedAt).toBeInstanceOf(Date);
    expect(t.notifier.alChofer).toHaveBeenCalledWith(
      'u-chofer',
      'route-sheet:assigned',
      {
        sheetId: 'hoja-1',
        orderIds: ['o1', 'o2'],
        droppedOrderIds: [],
      },
    );
    expect(t.notifier.pushAlChofer).toHaveBeenCalledWith(
      { distributorId: DIST, driverUserId: 'u-chofer' },
      'tok',
      'hoja-1',
      expect.stringContaining('2 entrega(s)'),
      'Tu hoja de ruta de hoy',
      'ROUTE_SHEET_ASSIGNED',
    );
  });

  it('idempotente: lo que ya es del chofer no se vuelve a asignar ni se avisa de nuevo', async () => {
    const t = armar({
      sheet: hoja({
        status: RouteBatchStatus.CONFIRMED,
        planDate: HOY,
        assignedAt: new Date(),
      }),
      estados: {
        o1: { status: OrderStatus.ACCEPTED, deliveryId: 'chofer-1' },
        o2: { status: OrderStatus.ON_THE_WAY, deliveryId: 'chofer-1' },
      },
    });
    const r = await t.svc.asignarConCerrojoTomado(DIST, 'hoja-1', null);
    expect(r.assignedOrderIds).toEqual(['o1', 'o2']);
    expect(t.orders.assignDelivery).not.toHaveBeenCalled();
    expect(t.save).not.toHaveBeenCalled();
    expect(t.notifier.alChofer).not.toHaveBeenCalled();
    expect(t.notifier.pushAlChofer).not.toHaveBeenCalled();
  });

  it('un pedido que ya no está libre sale de la hoja (unavailable) y no frena a los demás; se avisa aunque ya estuviera asignada', async () => {
    const t = armar({
      sheet: hoja({
        status: RouteBatchStatus.CONFIRMED,
        planDate: HOY,
        assignedAt: new Date(),
      }),
      paradas: ['o1', 'o2', 'o3'],
      asignar: (id) =>
        id === 'o2'
          ? Promise.reject(new ConflictException('ya no'))
          : id === 'o3'
            ? Promise.reject(new BadRequestException('otro'))
            : Promise.resolve({}),
    });
    const r = await t.svc.asignarHoja(DIST, 'hoja-1', null);
    expect(r.assignedOrderIds).toEqual(['o1']);
    expect(r.droppedOrderIds).toEqual(['o2', 'o3']);
    expect(t.writer.apagarParada).toHaveBeenCalledWith(
      expect.anything(),
      'hoja-1',
      'o2',
      RouteStopRemovedReason.UNAVAILABLE,
    );
    expect(t.notifier.alPanel).toHaveBeenCalled();
    expect(t.notifier.pushAlChofer).not.toHaveBeenCalled();
  });

  it('una reserva del día se activa por el camino de siempre antes de asignarla', async () => {
    const t = armar({
      estados: { o1: { status: OrderStatus.RESERVED, deliveryId: null } },
    });
    await t.svc.asignarHoja(DIST, 'hoja-1', null);
    expect(t.orders.updateStatus).toHaveBeenCalledWith(
      'o1',
      OrderStatus.PENDING,
      undefined,
      RoleType.ADMIN,
      undefined,
    );
  });

  it.each([
    ['en borrador', { status: RouteBatchStatus.DRAFT, planDate: HOY }],
    [
      'de otro día',
      { status: RouteBatchStatus.CONFIRMED, planDate: '2099-01-01' },
    ],
    [
      'sin chofer',
      { status: RouteBatchStatus.CONFIRMED, planDate: HOY, deliveryId: null },
    ],
  ] as const)('una hoja %s no se asigna', async (_c, over) => {
    const t = armar({ sheet: hoja(over) });
    expect((await t.svc.asignarHoja(DIST, 'hoja-1', null)).skipped).toBe(true);
    expect(t.orders.assignDelivery).not.toHaveBeenCalled();
  });

  it('sin el perfil del chofer no se asigna', async () => {
    const t = armar({ chofer: false });
    expect((await t.svc.asignarHoja(DIST, 'hoja-1', null)).skipped).toBe(true);
  });

  describe('liberar', () => {
    it('sólo los pedidos todavía aceptados por ese chofer vuelven a pendientes', async () => {
      const t = armar({
        estados: {
          o1: { status: OrderStatus.ACCEPTED, deliveryId: 'chofer-1' },
          o2: { status: OrderStatus.ACCEPTED, deliveryId: 'chofer-9' },
          o3: { status: OrderStatus.DELIVERED, deliveryId: 'chofer-1' },
          o4: { status: OrderStatus.ACCEPTED, deliveryId: 'chofer-1' },
        },
      });
      t.orders.updateStatus
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('no'));
      const r = await t.svc.liberar(
        'chofer-1',
        ['o1', 'o2', 'o3', 'o4'],
        'u-admin',
      );
      expect(r).toEqual(['o1']);
      expect(t.orders.updateStatus).toHaveBeenCalledWith(
        'o1',
        OrderStatus.PENDING,
        undefined,
        RoleType.ADMIN,
        'u-admin',
      );
      expect(t.orders.updateStatus).toHaveBeenCalledTimes(2);
    });

    it('sin chofer o sin pedidos no hace nada', async () => {
      const t = armar();
      expect(await t.svc.liberar(null, ['o1'], 'u')).toEqual([]);
      expect(await t.svc.liberar('chofer-1', [], 'u')).toEqual([]);
      expect(t.orders.updateStatus).not.toHaveBeenCalled();
    });
  });

  it('asignarLasDeHoy: las confirmadas de hoy sin asignar; una que falla no frena a las demás', async () => {
    const t = armar({
      deHoy: [
        { batchId: 'hoja-1', distributorId: DIST },
        { batchId: 'hoja-2', distributorId: DIST },
      ],
    });
    t.locks.conCerrojo
      .mockImplementationOnce(() => Promise.reject(new Error('ocupada')))
      .mockImplementationOnce((_ids: string[], fn: () => unknown) => fn());
    expect(await t.svc.asignarLasDeHoy()).toBe(1);
  });
});
