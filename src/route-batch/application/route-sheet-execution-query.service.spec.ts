import { DataSource } from 'typeorm';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import {
  RouteBatchStop,
  RouteStopRemovedReason,
} from '../../order/entities/route-batch-stop.entity';
import { RedisService } from '../../redis/redis.service';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { instanteDelDia } from '../domain/route-sheet-rules';
import { RouteSheetDataService } from './route-sheet-data.service';
import { RouteSheetExecutionQueryService } from './route-sheet-execution-query.service';
import { DIA, DIST, hoja, parada, pedido } from './route-sheet.fixtures';

const INICIO = new Date('2026-11-14T12:00:00Z');

const codigo = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'sin error';
  } catch (e) {
    return (e as { getResponse: () => { code?: string } }).getResponse().code;
  }
};

function armar(
  o: {
    sheet?: RouteBatch | null;
    stops?: RouteBatchStop[];
    estados?: Record<string, string>;
    filas?: Record<string, unknown[]>;
    gps?: unknown;
  } = {},
) {
  const sheet =
    o.sheet === undefined
      ? hoja({
          status: RouteBatchStatus.ASSIGNED,
          startedAt: INICIO,
          number: 7,
        })
      : o.sheet;
  const query = jest.fn((sql: string, params?: unknown[]) => {
    void params;
    for (const [clave, filas] of Object.entries(o.filas ?? {})) {
      if (sql.includes(clave)) return Promise.resolve(filas);
    }
    if (sql.includes('u."full_name" AS "driverName"')) {
      return Promise.resolve([
        { driverName: 'Juan', driverUserId: 'u-chofer', carPatent: 'AB123CD' },
      ]);
    }
    if (sql.includes('FROM "order_item" oi JOIN')) {
      return Promise.resolve([
        { orderId: 'o2', gasCylinderId: 'g10', type: '10 kg', quantity: 2 },
        { orderId: 'o2', gasCylinderId: 'g15', type: '15 kg', quantity: 1 },
      ]);
    }
    return Promise.resolve([]);
  });
  const ds = {
    query,
    manager: {
      findOne: jest.fn().mockResolvedValue(sheet),
      find: jest.fn().mockResolvedValue(o.stops ?? []),
    },
  };
  const data = {
    pedidos: jest.fn((_d: string, ids: string[]) =>
      Promise.resolve(
        ids.map((id) => pedido(id, { status: o.estados?.[id] ?? 'accepted' })),
      ),
    ),
  };
  const processConfig = {
    obtener: jest
      .fn()
      .mockResolvedValue({ etaWindowMinutes: 30, arrivalWaitMinutes: 10 }),
  };
  const redis = {
    getDriverLastLocation: jest.fn(() =>
      o.gps instanceof Error
        ? Promise.reject(o.gps)
        : Promise.resolve(o.gps ?? null),
    ),
  };
  const svc = new RouteSheetExecutionQueryService(
    ds as unknown as DataSource,
    data as unknown as RouteSheetDataService,
    processConfig as unknown as ProcessConfigService,
    redis as unknown as RedisService,
  );
  return { svc, query, ds, data, redis };
}

describe('RouteSheetExecutionQueryService', () => {
  describe('seguimiento / hoja del chofer', () => {
    const stops = () => [
      parada('o1', 1, { active: false, removedReason: null, removedAt: null }),
      parada('o2', 2, {
        etaAt: new Date(instanteDelDia(DIA, '21:00')),
        arrivedAt: new Date(INICIO),
      }),
      parada('o3', 3),
      parada('o4', 4, {
        active: false,
        removedReason: RouteStopRemovedReason.FAILED_DELIVERY,
        removedAt: new Date(INICIO.getTime() + 60_000),
        removedNote: 'El cliente no estaba',
      }),
      // Salió mientras se planificaba (antes de iniciar): no se muestra.
      parada('o5', 5, {
        active: false,
        removedReason: RouteStopRemovedReason.MOVED,
        removedAt: new Date(INICIO.getTime() - 60_000),
      }),
      parada('o6', 6, {
        active: false,
        removedReason: RouteStopRemovedReason.SHEET_CLOSED,
        removedAt: null,
      }),
    ];

    it('activas en orden y después las que salieron en la calle, con avance, motivos, renglones y la siguiente', async () => {
      const t = armar({
        stops: stops(),
        estados: { o1: 'delivered', o2: 'on_the_way', o4: 'pending' },
        gps: { lat: 1, lng: 2, at: '2026-11-14T13:00:00.000Z' },
      });
      const r = await t.svc.seguimiento(DIST, 'hoja-1');
      expect(r.stops.map((s) => [s.orderId, s.sequence, s.progress])).toEqual([
        ['o2', 2, 'on_the_way'],
        ['o3', 3, 'pending'],
        ['o1', null, 'delivered'],
        ['o4', null, 'failed'],
      ]);
      expect(r).toMatchObject({
        id: 'hoja-1',
        number: 7,
        status: RouteBatchStatus.ASSIGNED,
        driverName: 'Juan',
        carPatent: 'AB123CD',
        startedAt: INICIO.toISOString(),
        currentOrderId: 'o2',
        nextOrderId: 'o2',
        progress: { total: 4, delivered: 1, failed: 1, removed: 0, pending: 2 },
        driverLocation: { lat: 1, lng: 2, at: '2026-11-14T13:00:00.000Z' },
      });
      const o2 = r.stops[0];
      expect(o2.waitExpiresAt).toBe(
        new Date(INICIO.getTime() + 10 * 60_000).toISOString(),
      );
      expect(r.assignedAt).toBeNull();
      expect(o2.late).toBe(true);
      expect(o2.arrivedAt).toBe(INICIO.toISOString());
      expect(o2.items).toEqual([
        { gasCylinderId: 'g10', type: '10 kg', quantity: 2 },
        { gasCylinderId: 'g15', type: '15 kg', quantity: 1 },
      ]);
      expect(r.stops[3]).toMatchObject({
        removedReason: RouteStopRemovedReason.FAILED_DELIVERY,
        removedNote: 'El cliente no estaba',
        late: false,
        items: [],
      });
    });

    it('antes de iniciar sólo las activas y sin siguiente; sin posición fuera del seguimiento', async () => {
      const t = armar({
        sheet: hoja({ status: RouteBatchStatus.CONFIRMED }),
        stops: stops(),
      });
      const r = await t.svc.seguimiento(DIST, 'hoja-1');
      expect(r.stops.map((s) => s.orderId)).toEqual(['o2', 'o3']);
      expect(r.nextOrderId).toBeNull();
      expect(r.driverLocation).toBeNull();
    });

    it('404 si la hoja no existe; Redis caído no corta el seguimiento', async () => {
      expect(
        await codigo(armar({ sheet: null }).svc.seguimiento(DIST, 'x')),
      ).toBe('ROUTE_SHEET_NOT_FOUND');
      const sinRedis = armar({ stops: [], gps: new Error('redis') });
      expect(
        (await sinRedis.svc.seguimiento(DIST, 'hoja-1')).driverLocation,
      ).toBeNull();
    });

    it('sin chofer ni datos extra, la hoja sale igual', async () => {
      const t = armar({
        stops: [],
        filas: { 'u."full_name" AS "driverName"': [] },
      });
      const r = await t.svc.seguimiento(DIST, 'hoja-1');
      expect(r.driverName).toBeNull();
      expect(r.driverLocation).toBeNull();
    });

    it('actualDelChofer: la en curso o la próxima confirmada; null si no hay', async () => {
      const t = armar({
        stops: [],
        filas: {
          'ORDER BY (b."status" = \'assigned\') DESC': [{ batchId: 'hoja-1' }],
        },
      });
      const r = await t.svc.actualDelChofer(DIST, 'u-chofer');
      expect(r?.id).toBe('hoja-1');
      expect(r?.driverLocation).toBeNull();
      expect(await armar().svc.actualDelChofer(DIST, 'u-chofer')).toBeNull();
    });

    it('delChofer: la suya; la de otro o en borrador es 404', async () => {
      const t = armar({
        stops: [],
        filas: { 'd."user_id" = $3': [{ '?column?': 1 }] },
      });
      expect((await t.svc.delChofer(DIST, 'u-chofer', 'hoja-1')).id).toBe(
        'hoja-1',
      );
      const [, params] = t.query.mock.calls.find((c) =>
        String(c[0]).includes('d."user_id" = $3'),
      ) as [string, unknown[]];
      expect(params[3]).toEqual(['confirmed', 'assigned', 'completed']);
      expect(
        await codigo(armar().svc.delChofer(DIST, 'u-otro', 'hoja-1')),
      ).toBe('ROUTE_SHEET_NOT_FOUND');
    });
  });

  describe('etaDelPedido (cliente)', () => {
    const SUYO = { 'AND "customer_id" = $2': [{ '?column?': 1 }] };

    it('de otro cliente o inexistente: 404', async () => {
      expect(await codigo(armar().svc.etaDelPedido('c1', 'o1'))).toBe(
        'ORDER_NOT_FOUND',
      );
    });

    it('sin hoja (o ya entregado): null', async () => {
      expect(
        await armar({ filas: SUYO }).svc.etaDelPedido('c1', 'o1'),
      ).toBeNull();
    });

    it('con la franja avisada, la devuelve tal cual', async () => {
      const t = armar({
        filas: {
          ...SUYO,
          's."notified_window_start" AS "ws"': [
            {
              distributorId: DIST,
              status: 'assigned',
              etaAt: new Date('2026-11-14T13:30:00Z'),
              ws: new Date('2026-11-14T13:00:00Z'),
              we: new Date('2026-11-14T14:00:00Z'),
              notifiedAt: new Date('2026-11-14T12:10:00Z'),
              startedAt: INICIO,
            },
          ],
        },
      });
      expect(await t.svc.etaDelPedido('c1', 'o1')).toEqual({
        orderId: 'o1',
        etaAt: '2026-11-14T13:30:00.000Z',
        windowStart: '2026-11-14T13:00:00.000Z',
        windowEnd: '2026-11-14T14:00:00.000Z',
        source: 'route_sheet',
        inProgress: true,
        updatedAt: '2026-11-14T12:10:00.000Z',
      });
    });

    it('confirmada y sin aviso todavía: la calcula con la franja comprada y el parámetro', async () => {
      const eta = new Date(instanteDelDia(DIA, '10:00'));
      const t = armar({
        filas: {
          ...SUYO,
          's."notified_window_start" AS "ws"': [
            {
              distributorId: DIST,
              status: 'confirmed',
              etaAt: eta,
              ws: null,
              we: null,
              notifiedAt: null,
              startedAt: null,
            },
          ],
        },
      });
      const r = await t.svc.etaDelPedido('c1', 'o1');
      expect(r).toMatchObject({
        inProgress: false,
        windowStart: new Date(eta.getTime() - 30 * 60_000).toISOString(),
        windowEnd: new Date(eta.getTime() + 30 * 60_000).toISOString(),
        updatedAt: eta.toISOString(),
      });
    });

    it('sin franja o sin hora estimada: null', async () => {
      const fila = {
        distributorId: DIST,
        status: 'confirmed',
        etaAt: new Date(),
        ws: null,
        we: null,
        notifiedAt: null,
        startedAt: null,
      };
      const sinFranja = armar({
        filas: { ...SUYO, 's."notified_window_start" AS "ws"': [fila] },
      });
      sinFranja.data.pedidos.mockResolvedValue([
        pedido('o1', { slotStartMs: null, slotEndMs: null }),
      ]);
      expect(await sinFranja.svc.etaDelPedido('c1', 'o1')).toBeNull();
      const sinEta = armar({
        filas: {
          ...SUYO,
          's."notified_window_start" AS "ws"': [{ ...fila, etaAt: null }],
        },
      });
      expect(await sinEta.svc.etaDelPedido('c1', 'o1')).toBeNull();
    });
  });

  describe('intentos, reprogramación y espera del admin', () => {
    it('un reintento muestra sus intentos; uno reprogramado trae la fecha nueva; uno sin resolver espera al admin', async () => {
      const t = armar({
        stops: [
          parada('o1', 1, {
            failedAttempts: 1,
            lastFailedAt: new Date(INICIO.getTime() + 1000),
            lastFailureNote: 'El cliente no estaba',
          }),
          parada('o2', 2, {
            active: false,
            removedReason: RouteStopRemovedReason.RESCHEDULED,
            removedAt: new Date(INICIO.getTime() + 5000),
            failedAttempts: 2,
            lastFailedAt: new Date(INICIO.getTime() + 5000),
          }),
          parada('o3', 3, {
            active: false,
            removedReason: RouteStopRemovedReason.ADMIN,
            removedAt: new Date(INICIO.getTime() + 5000),
          }),
          // Reprogramado con la hoja de ruta apagada: otra fecha, pero espera al admin.
          parada('o4', 4, {
            active: false,
            removedReason: RouteStopRemovedReason.NEEDS_RESCHEDULE,
            removedAt: new Date(INICIO.getTime() + 5000),
          }),
        ],
        estados: {
          o1: 'accepted',
          o2: 'pending',
          o3: 'pending',
          o4: 'pending',
        },
      });
      t.data.pedidos.mockImplementation((_d: string, ids: string[]) =>
        Promise.resolve(
          ids.map((id) =>
            pedido(id, {
              status: id === 'o1' ? 'accepted' : 'pending',
              scheduledDate: id === 'o2' || id === 'o4' ? '2026-11-16' : DIA,
            }),
          ),
        ),
      );
      const r = await t.svc.seguimiento(DIST, 'hoja-1');
      const por = new Map(r.stops.map((s) => [s.orderId, s]));
      expect(por.get('o1')).toMatchObject({
        progress: 'pending',
        failedAttempts: 1,
        lastFailureNote: 'El cliente no estaba',
        awaitingAdmin: false,
        rescheduledTo: null,
      });
      expect(por.get('o2')).toMatchObject({
        progress: 'failed',
        awaitingAdmin: false,
        rescheduledTo: '2026-11-16',
      });
      expect(por.get('o3')).toMatchObject({
        progress: 'removed',
        awaitingAdmin: true,
        rescheduledTo: null,
      });
      expect(por.get('o4')).toMatchObject({
        awaitingAdmin: true,
        rescheduledTo: '2026-11-16',
      });
    });
  });
});
