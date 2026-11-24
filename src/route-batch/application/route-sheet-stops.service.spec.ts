import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { ReleaseOrderUseCase } from '../../order/application/release-order.use-case';
import { Order, OrderStatus } from '../../order/entities/order.entity';
import {
  RouteBatchStop,
  RouteStopRemovedReason,
} from '../../order/entities/route-batch-stop.entity';
import { OrderService } from '../../order/order.service';
import { FailedVisitReason } from '../../failed-visit/domain/nueva-visita';
import { FailedVisitNotifier } from '../../failed-visit/failed-visit.notifier';
import { FailedVisitService } from '../../failed-visit/failed-visit.service';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { StopProgress } from '../domain/route-sheet-execution';
import {
  PlanDeReprogramacion,
  RouteSheetInProgress,
} from './route-sheet-in-progress.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import {
  ParadaEnCurso,
  RouteSheetProgress,
} from './route-sheet-progress.service';
import {
  FailedDeliveryReason,
  RouteSheetStopsService,
  resultadoParaLaHoja,
} from './route-sheet-stops.service';
import {
  hojaNoEnCurso,
  hojaNoEncontrada,
  paradaNoEncontrada,
} from './route-sheet.exceptions';
import { DIST, hoja, parada, pedido } from './route-sheet.fixtures';

const CHOFER = {
  deliveryId: 'chofer-1',
  userId: 'u-chofer',
  notificationToken: 'tok',
} as Delivery;

const codigo = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'sin error';
  } catch (e) {
    return (e as { getResponse: () => { code?: string } }).getResponse().code;
  }
};

/** La parada y el pedido como quedan en la base: sólo cambian si la transacción confirma. */
interface Estado {
  parada: { active: boolean; failedAttempts: number; removedReason?: string };
  pedido: { status: string; deliveryId: string | null };
}

const PLAN: PlanDeReprogramacion = {
  fecha: '2026-11-16',
  dias: ['2026-11-16', '2026-11-17'],
  esperaAlAdmin: false,
  causa: 'planificacion',
};

/**
 * El `EntityManager` de la transacción de la hoja: lo que se escribe queda
 * pendiente y se aplica al `estado` sólo si la operación termina sin error
 * (como el commit; si falla, el rollback lo descarta).
 */
function managerDeTransaccion(estado: Estado, pendientes: Array<() => void>) {
  interface Qb {
    setLock: jest.Mock;
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  }
  const qb: Qb = {
    setLock: jest.fn((): Qb => qb),
    leftJoinAndSelect: jest.fn((): Qb => qb),
    where: jest.fn((): Qb => qb),
    getOne: jest.fn(() =>
      Promise.resolve({
        orderId: 'o2',
        distributorId: DIST,
        customerId: 'c1',
        status: estado.pedido.status,
        deliveryId: estado.pedido.deliveryId,
      }),
    ),
  };
  return {
    update: jest.fn(
      (entidad: unknown, _where: unknown, valores: Record<string, unknown>) => {
        pendientes.push(() => {
          if (entidad === RouteBatchStop) Object.assign(estado.parada, valores);
          else Object.assign(estado.pedido, valores);
        });
        return Promise.resolve(undefined);
      },
    ),
    createQueryBuilder: jest.fn((): Qb => qb),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn((o: { status: string; deliveryId: string | null }) => {
      pendientes.push(() =>
        Object.assign(estado.pedido, {
          status: o.status,
          deliveryId: o.deliveryId,
        }),
      );
      return Promise.resolve(o);
    }),
  };
}

function armar(
  o: {
    avance?: Array<[string, StopProgress]>;
    otroEnCamino?: boolean;
    intentos?: Record<string, number>;
    stop?: RouteBatchStop | null;
    alTope?: boolean;
    plan?: PlanDeReprogramacion;
    hojaEnTransaccion?: RouteBatchStatus;
  } = {},
) {
  const avance = o.avance ?? [
    ['o1', 'delivered'],
    ['o2', 'pending'],
    ['o3', 'pending'],
  ];
  const sheet = hoja({ status: RouteBatchStatus.ASSIGNED });
  const paradas: ParadaEnCurso[] = avance.map(([id, progress], i) => ({
    stop: parada(id, i + 1, {
      failedAttempts: o.intentos?.[id] ?? 0,
      lastFailedAt: o.intentos?.[id] ? new Date() : null,
    }),
    pedido: pedido(id),
    progress,
  }));
  const o2 = avance.find(([id]) => id === 'o2');
  const estado: Estado = {
    parada: { active: true, failedAttempts: o.intentos?.o2 ?? 0 },
    pedido: {
      status: o2?.[1] === 'on_the_way' ? 'on_the_way' : 'accepted',
      deliveryId: 'chofer-1',
    },
  };
  const ds = {
    manager: {
      findOne: jest
        .fn()
        .mockResolvedValue(o.stop === undefined ? parada('o2', 2) : o.stop),
      update: jest.fn().mockResolvedValue(undefined),
    },
    query: jest
      .fn()
      .mockResolvedValue([{ customerId: 'c1', distributorId: DIST }]),
  };
  const visitas = {
    prepararDeHoja: jest.fn().mockResolvedValue({ alAdmin: o.alTope ?? false }),
    registrarDeHoja: jest.fn(
      (v: {
        salida: string;
        rescheduledTo?: string | null;
      }): Promise<Record<string, unknown> | null> =>
        Promise.resolve({
          visit: { failedVisitId: 'v1' },
          failedVisitCount: v.salida === 'requeued' ? 0 : 1,
          outcome:
            v.salida === 'requeued'
              ? 'requeued'
              : v.rescheduledTo
                ? 'proposed'
                : 'awaiting_admin',
          revisitStatus:
            v.salida === 'requeued'
              ? null
              : v.rescheduledTo
                ? 'proposed'
                : 'awaiting_admin',
          scheduledDate: v.rescheduledTo ?? null,
          timeSlotId: v.salida === 'requeued' ? null : 'franja-1',
        }),
    ),
  };
  const avisosDeVisita = {
    visitaFallida: jest.fn().mockResolvedValue(undefined),
  };
  let manager: ReturnType<typeof managerDeTransaccion> | null = null;
  const locks = {
    conCerrojo: jest.fn((_ids: string[], fn: () => unknown) => fn()),
    enTransaccion: jest.fn(
      async (
        _dist: string,
        _hojas: unknown,
        fn: (m: unknown, hojas: unknown[]) => Promise<unknown>,
      ) => {
        const pendientes: Array<() => void> = [];
        manager = managerDeTransaccion(estado, pendientes);
        const r = await fn(manager, [
          hoja({
            status: o.hojaEnTransaccion ?? RouteBatchStatus.ASSIGNED,
          }),
        ]);
        for (const aplicar of pendientes) aplicar();
        return r;
      },
    ),
  };
  const progress = { paradas: jest.fn().mockResolvedValue(paradas) };
  const orders = {
    updateStatus: jest.fn().mockResolvedValue({}),
    notifyDriverArrivedWithDistance: jest
      .fn()
      .mockResolvedValue({ message: 'Cliente notificado' }),
    postergarEntregaEn: jest.fn(
      async (m: ReturnType<typeof managerDeTransaccion>) => {
        await m.update(Order, { orderId: 'o2' }, { status: 'accepted' });
        return { orderId: 'o2', status: 'accepted' };
      },
    ),
    avisarPostergada: jest.fn().mockResolvedValue(undefined),
  };
  const release = {
    releaseWithin: jest.fn(
      (_m: unknown, p: { status: string; deliveryId: string | null }) => {
        p.status = 'pending';
        p.deliveryId = null;
        return Promise.resolve('u-chofer');
      },
    ),
    notifyReleased: jest.fn().mockResolvedValue(undefined),
  };
  const notifier = {
    alPanel: jest.fn(),
    aLaBandeja: jest.fn(),
    noEntregadoAlCliente: jest.fn().mockResolvedValue(undefined),
  };
  const hojaEnCurso = {
    choferDeLaHoja: jest.fn().mockResolvedValue(CHOFER),
    enCurso: jest.fn().mockResolvedValue(sheet),
    parada: jest.fn((ps: ParadaEnCurso[], id: string) => {
      const p = ps.find((x) => x.stop.orderId === id);
      if (!p) throw paradaNoEncontrada();
      return p;
    }),
    otroEnCaminoDelChofer: jest.fn().mockResolvedValue(o.otroEnCamino ?? false),
    rehacer: jest.fn().mockResolvedValue({
      recorrido: { hechas: ['o1'], enCamino: null, pendientes: ['o3'] },
      cola: ['o3'],
      etas: [],
      origen: 'gps',
    }),
    avisarCambio: jest.fn(),
    choferDe: jest.fn().mockResolvedValue(CHOFER),
    planDeReprogramacion: jest.fn().mockResolvedValue(o.plan ?? PLAN),
    aplicarReprogramacion: jest.fn(
      (_m: unknown, _s: unknown, _o: string, p: PlanDeReprogramacion) =>
        Promise.resolve(p),
    ),
    avisarReprogramacion: jest.fn(),
  };
  const svc = new RouteSheetStopsService(
    ds as unknown as DataSource,
    locks as unknown as RouteSheetLocks,
    progress as unknown as RouteSheetProgress,
    orders as unknown as OrderService,
    notifier as unknown as RouteSheetNotifier,
    hojaEnCurso as unknown as RouteSheetInProgress,
    visitas as unknown as FailedVisitService,
    avisosDeVisita as unknown as FailedVisitNotifier,
    release as unknown as ReleaseOrderUseCase,
  );
  return {
    svc,
    ds,
    locks,
    orders,
    release,
    notifier,
    hoja: hojaEnCurso,
    sheet,
    visitas,
    avisosDeVisita,
    estado,
    /** El manager de la última transacción. */
    tx: () => manager as ReturnType<typeof managerDeTransaccion>,
  };
}

describe('RouteSheetStopsService', () => {
  describe('enCamino', () => {
    it('la siguiente: pasa el pedido a en camino por el caso de uso, recalcula sin reordenar y avisa al panel', async () => {
      const t = armar();
      const r = await t.svc.enCamino(DIST, 'hoja-1', 'o2', 'u-chofer');
      expect(r).toEqual({
        sheetId: 'hoja-1',
        orderId: 'o2',
        nextOrderId: 'o2',
        detour: false,
      });
      expect(t.locks.conCerrojo).toHaveBeenCalledWith(
        ['hoja-1'],
        expect.any(Function),
      );
      expect(t.orders.updateStatus).toHaveBeenCalledWith(
        'o2',
        OrderStatus.ON_THE_WAY,
        'u-chofer',
        RoleType.DELIVERY,
        'u-chofer',
      );
      expect(t.hoja.rehacer).toHaveBeenCalledWith(DIST, 'hoja-1', 'u-chofer', {
        reordenar: false,
      });
      expect(t.notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:stop-progress',
        {
          sheetId: 'hoja-1',
          orderId: 'o2',
          progress: 'on_the_way',
          detour: false,
        },
      );
      expect(t.hoja.avisarCambio).not.toHaveBeenCalled();
    });

    it('otra que no es la siguiente: desvío, se reordena la cola y se le avisa al chofer', async () => {
      const t = armar();
      const r = await t.svc.enCamino(DIST, 'hoja-1', 'o3', 'u-chofer');
      expect(r.detour).toBe(true);
      expect(t.hoja.rehacer).toHaveBeenCalledWith(DIST, 'hoja-1', 'u-chofer', {
        reordenar: true,
      });
      expect(t.hoja.avisarCambio).toHaveBeenCalledWith(
        CHOFER,
        'hoja-1',
        'reordered',
        {
          orderId: 'o3',
        },
      );
    });

    it('repetirla sobre la misma parada en camino es idempotente', async () => {
      const t = armar({ avance: [['o2', 'on_the_way']] });
      expect(await t.svc.enCamino(DIST, 'hoja-1', 'o2', 'u')).toMatchObject({
        detour: false,
      });
      expect(t.orders.updateStatus).not.toHaveBeenCalled();
    });

    it('409: ya va a otra (de la hoja o suelta), la parada ya se entregó; 404 si no es de la hoja', async () => {
      expect(
        await codigo(
          armar({
            avance: [
              ['o1', 'on_the_way'],
              ['o2', 'pending'],
            ],
          }).svc.enCamino(DIST, 'hoja-1', 'o2', 'u'),
        ),
      ).toBe('ROUTE_SHEET_STOP_IN_PROGRESS');
      expect(
        await codigo(
          armar({ otroEnCamino: true }).svc.enCamino(DIST, 'hoja-1', 'o2', 'u'),
        ),
      ).toBe('ROUTE_SHEET_STOP_IN_PROGRESS');
      expect(
        await codigo(armar().svc.enCamino(DIST, 'hoja-1', 'o1', 'u')),
      ).toBe('ROUTE_STOP_NOT_PENDING');
      expect(
        await codigo(armar().svc.enCamino(DIST, 'hoja-1', 'o9', 'u')),
      ).toBe('ROUTE_STOP_NOT_FOUND');
    });

    it('la hoja de otro chofer (404) o que no está en curso (409) corta antes de tocar el pedido', async () => {
      const otro = armar();
      otro.hoja.choferDeLaHoja.mockRejectedValue(hojaNoEncontrada());
      expect(await codigo(otro.svc.enCamino(DIST, 'hoja-1', 'o2', 'u'))).toBe(
        'ROUTE_SHEET_NOT_FOUND',
      );
      const noEnCurso = armar();
      noEnCurso.hoja.enCurso.mockRejectedValue(hojaNoEnCurso());
      expect(
        await codigo(noEnCurso.svc.enCamino(DIST, 'hoja-1', 'o2', 'u')),
      ).toBe('ROUTE_SHEET_NOT_IN_PROGRESS');
      expect(otro.orders.updateStatus).not.toHaveBeenCalled();
      expect(noEnCurso.orders.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('llegue', () => {
    it('avisa con el radio de la v2 y anota la llegada (la primera vez)', async () => {
      const t = armar();
      const r = await t.svc.llegue(DIST, 'hoja-1', 'o2', 'u-chofer', {
        latitude: -27.4,
        longitude: -55.9,
      });
      expect(t.orders.notifyDriverArrivedWithDistance).toHaveBeenCalledWith(
        'o2',
        'u-chofer',
        RoleType.DELIVERY,
        -27.4,
        -55.9,
      );
      expect(r.message).toBe('Cliente notificado');
      expect(t.ds.manager.update).toHaveBeenCalledWith(
        RouteBatchStop,
        { stopId: 's-o2' },
        { arrivedAt: expect.any(Date) as Date },
      );
      expect(t.notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:stop-progress',
        expect.objectContaining({ progress: 'arrived' }),
      );
    });

    it('un segundo «Llegué» conserva la hora de la primera', async () => {
      const antes = new Date('2026-11-14T13:00:00Z');
      const t = armar({ stop: parada('o2', 2, { arrivedAt: antes }) });
      const r = await t.svc.llegue(DIST, 'hoja-1', 'o2', 'u', {
        latitude: 0,
        longitude: 0,
      });
      expect(r.arrivedAt).toBe(antes.toISOString());
      expect(t.ds.manager.update).not.toHaveBeenCalled();
    });

    it('404 si no es parada activa; el 409 del pedido (lejos, no en camino) sube tal cual', async () => {
      expect(
        await codigo(
          armar({ stop: null }).svc.llegue(DIST, 'hoja-1', 'o9', 'u', {
            latitude: 0,
            longitude: 0,
          }),
        ),
      ).toBe('ROUTE_STOP_NOT_FOUND');
      const lejos = armar();
      lejos.orders.notifyDriverArrivedWithDistance.mockRejectedValue(
        new ConflictException({ code: 'ARRIVAL_TOO_FAR' }),
      );
      expect(
        await codigo(
          lejos.svc.llegue(DIST, 'hoja-1', 'o2', 'u', {
            latitude: 0,
            longitude: 0,
          }),
        ),
      ).toBe('ARRIVAL_TOO_FAR');
      expect(lejos.ds.manager.update).not.toHaveBeenCalled();
    });
  });

  describe('noEntregada («No pude entregar»)', () => {
    const CHOFER_OPERA = { userId: 'u-chofer', esChofer: true };

    it('primer intento, en camino: vuelve a aceptado con el mismo chofer, la parada pasa al final de la cola y se avisa al cliente y al admin', async () => {
      const t = armar({
        avance: [
          ['o1', 'delivered'],
          ['o2', 'on_the_way'],
          ['o3', 'pending'],
        ],
      });
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.CUSTOMER_ABSENT,
        note: '  tocó timbre  ',
      });
      expect(resultadoParaLaHoja(r)).toEqual({
        sheetId: 'hoja-1',
        orderId: 'o2',
        nextOrderId: 'o3',
        attempt: 1,
        outcome: 'requeued',
        // Sin hora estimada (el recálculo no la dio): sin franja nueva.
        newWindowStart: null,
        newWindowEnd: null,
      });
      // Todo en la transacción de la hoja: el pedido, la parada y la visita.
      expect(t.orders.postergarEntregaEn).toHaveBeenCalledWith(
        t.tx(),
        'o2',
        'chofer-1',
      );
      expect(t.tx().update).toHaveBeenCalledWith(
        RouteBatchStop,
        { stopId: 's-o2' },
        expect.objectContaining({
          failedAttempts: 1,
          lastFailureNote: 'El cliente no estaba: tocó timbre',
          arrivedAt: null,
          waitAlertedAt: null,
        }),
      );
      expect(t.visitas.registrarDeHoja).toHaveBeenCalledWith(
        expect.objectContaining({ salida: 'requeued' }),
        expect.any(Date),
        t.tx(),
      );
      expect(t.estado).toMatchObject({
        parada: { active: true, failedAttempts: 1 },
        pedido: { status: 'accepted', deliveryId: 'chofer-1' },
      });
      // Los avisos de la postergación, después del commit.
      expect(t.orders.avisarPostergada).toHaveBeenCalledWith(
        { orderId: 'o2', status: 'accepted' },
        'chofer-1',
      );
      expect(t.orders.updateStatus).not.toHaveBeenCalled();
      expect(t.release.releaseWithin).not.toHaveBeenCalled();
      expect(t.hoja.planDeReprogramacion).not.toHaveBeenCalled();
      expect(t.hoja.rehacer).toHaveBeenCalledWith(DIST, 'hoja-1', 'u-chofer', {
        reordenar: true,
        postergado: 'o2',
      });
      // Sin franja nueva, el aviso de siempre al cliente.
      expect(t.notifier.noEntregadoAlCliente).toHaveBeenCalledWith(
        'c1',
        'o2',
        1,
      );
      expect(t.notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:stop-failed',
        expect.objectContaining({ attempt: 1, outcome: 'requeued' }),
      );
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(
        DIST,
        expect.objectContaining({ kind: 'route_sheet_stop_requeued' }),
      );
      expect(t.hoja.avisarCambio).not.toHaveBeenCalled();
    });

    it('primer intento con hora estimada: la ruta se recalcula y al admin y al panel les llega «más tarde» con la franja nueva (el push al cliente ya salió con el recálculo)', async () => {
      const t = armar();
      const franja = {
        windowStartMs: Date.parse('2026-11-14T16:00:00Z'),
        windowEndMs: Date.parse('2026-11-14T17:00:00Z'),
        etaMs: Date.parse('2026-11-14T16:30:00Z'),
      };
      t.hoja.rehacer.mockResolvedValue({
        recorrido: { hechas: [], enCamino: null, pendientes: ['o3', 'o2'] },
        cola: ['o3', 'o2'],
        etas: [],
        origen: 'gps',
        postergado: franja,
      });
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.CUSTOMER_ABSENT,
      });
      expect(r).toMatchObject({
        outcome: 'requeued',
        nextOrderId: 'o3',
        newWindowStart: '2026-11-14T16:00:00.000Z',
        newWindowEnd: '2026-11-14T17:00:00.000Z',
      });
      expect(t.notifier.noEntregadoAlCliente).not.toHaveBeenCalled();
      expect(t.notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:stop-failed',
        expect.objectContaining({
          attempt: 1,
          windowStart: '2026-11-14T16:00:00.000Z',
          windowEnd: '2026-11-14T17:00:00.000Z',
        }),
      );
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(
        DIST,
        expect.objectContaining({
          kind: 'route_sheet_stop_requeued',
          title: 'Pedido reprogramado para más tarde',
          body: expect.stringContaining(
            'Nueva hora estimada: entre las 13:00 y las 14:00',
          ) as string,
        }),
      );
    });

    it('segundo intento: el recálculo no lleva postergado ni la respuesta franja nueva', async () => {
      const t = armar({ intentos: { o2: 1 } });
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.REJECTED,
      });
      expect(t.hoja.rehacer).toHaveBeenCalledWith(DIST, 'hoja-1', 'u-chofer', {
        reordenar: true,
      });
      expect(r).not.toHaveProperty('newWindowStart');
    });

    it('o2 en camino falla: nextOrderId (respuesta y aviso al chofer) sale del recorrido ya reordenado → o3', async () => {
      const t = armar({
        avance: [
          ['o1', 'delivered'],
          ['o2', 'on_the_way'],
          ['o3', 'pending'],
        ],
      });
      t.hoja.rehacer.mockResolvedValue({
        recorrido: { hechas: ['o1'], enCamino: null, pendientes: ['o3', 'o2'] },
        cola: ['o3', 'o2'],
        etas: [],
        origen: 'gps',
        postergado: null,
      });
      const r = await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        { userId: 'u-admin', esChofer: false },
        { reason: FailedDeliveryReason.CUSTOMER_ABSENT },
      );
      expect(r.nextOrderId).toBe('o3');
      expect(t.hoja.avisarCambio).toHaveBeenCalledWith(
        CHOFER,
        'hoja-1',
        'stop_failed',
        expect.objectContaining({ nextOrderId: 'o3' }),
      );
    });

    it('primer intento sobre una pendiente (no en camino): no cambia el estado del pedido', async () => {
      const t = armar();
      await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.NO_ACCESS,
      });
      expect(t.orders.postergarEntregaEn).not.toHaveBeenCalled();
      expect(t.orders.avisarPostergada).not.toHaveBeenCalled();
      expect(t.estado.pedido.status).toBe('accepted');
    });

    it('segundo intento: en una sola transacción sale de la hoja, se libera al chofer, se reprograma y se asienta la visita; los avisos, después', async () => {
      const t = armar({ intentos: { o2: 1 }, avance: [['o2', 'on_the_way']] });
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.REJECTED,
      });
      expect(r).toMatchObject({
        attempt: 2,
        outcome: 'rescheduled',
        rescheduledTo: '2026-11-16',
      });
      expect(t.visitas.prepararDeHoja).toHaveBeenCalledWith(
        'o2',
        'rescheduled',
        undefined,
        expect.any(Date),
        t.tx(),
      );
      expect(t.tx().update).toHaveBeenCalledWith(
        RouteBatchStop,
        { stopId: 's-o2' },
        expect.objectContaining({
          active: false,
          removedReason: RouteStopRemovedReason.RESCHEDULED,
          removedNote: 'El cliente rechazó el pedido',
          failedAttempts: 2,
        }),
      );
      expect(t.release.releaseWithin).toHaveBeenCalledWith(
        t.tx(),
        expect.objectContaining({ orderId: 'o2' }),
      );
      expect(t.hoja.aplicarReprogramacion).toHaveBeenCalledWith(
        t.tx(),
        t.sheet,
        'o2',
        PLAN,
      );
      expect(t.visitas.registrarDeHoja).toHaveBeenCalledWith(
        expect.objectContaining({
          salida: 'rescheduled',
          rescheduledTo: '2026-11-16',
          dias: ['2026-11-16', '2026-11-17'],
        }),
        expect.any(Date),
        t.tx(),
      );
      expect(t.estado).toMatchObject({
        parada: { active: false, failedAttempts: 2 },
        pedido: { status: 'pending', deliveryId: null },
      });
      // Después del commit: la liberación por entrega fallida (sin «order:pending»
      // ni «buscando chofer»), la bandeja y un solo aviso al cliente.
      expect(t.release.notifyReleased).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'o2', status: 'pending' }),
        'u-chofer',
        { porEntregaFallida: true },
      );
      expect(t.hoja.avisarReprogramacion).toHaveBeenCalledWith(
        t.sheet,
        'o2',
        PLAN,
        '2026-11-16',
      );
      expect(t.avisosDeVisita.visitaFallida).toHaveBeenCalledTimes(1);
      expect(t.avisosDeVisita.visitaFallida).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'o2', customerId: 'c1' }),
        'El cliente rechazó el pedido',
        { deHoja: true, adminYaAvisado: false },
      );
      expect(t.orders.updateStatus).not.toHaveBeenCalled();
      expect(t.orders.postergarEntregaEn).not.toHaveBeenCalled();
      expect(t.notifier.noEntregadoAlCliente).not.toHaveBeenCalled();
      expect(t.notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:stop-failed',
        expect.objectContaining({ attempt: 2, outcome: 'rescheduled' }),
      );
      expect(t.notifier.aLaBandeja).not.toHaveBeenCalled();
    });

    it('C5: si la visita no se puede asentar en el primer intento, no cambia nada: la parada sigue igual, el pedido sigue en camino y el error sube', async () => {
      const t = armar({ avance: [['o2', 'on_the_way']] });
      t.visitas.registrarDeHoja.mockRejectedValue(new Error('base caída'));
      await expect(
        t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
          reason: FailedDeliveryReason.CUSTOMER_ABSENT,
        }),
      ).rejects.toThrow('base caída');
      expect(t.estado).toEqual({
        parada: { active: true, failedAttempts: 0 },
        pedido: { status: 'on_the_way', deliveryId: 'chofer-1' },
      });
      expect(t.orders.avisarPostergada).not.toHaveBeenCalled();
      expect(t.hoja.rehacer).not.toHaveBeenCalled();
      expect(t.notifier.alPanel).not.toHaveBeenCalled();
    });

    it('C5: si la visita no se puede asentar en el segundo intento, la parada sigue en la hoja, el pedido sigue en camino con su chofer y no se avisa nada', async () => {
      const t = armar({ intentos: { o2: 1 }, avance: [['o2', 'on_the_way']] });
      t.visitas.registrarDeHoja.mockRejectedValue(new Error('base caída'));
      await expect(
        t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
          reason: FailedDeliveryReason.CUSTOMER_ABSENT,
        }),
      ).rejects.toThrow('base caída');
      // Se intentó todo en la transacción, pero el rollback lo descarta.
      expect(t.release.releaseWithin).toHaveBeenCalled();
      expect(t.hoja.aplicarReprogramacion).toHaveBeenCalled();
      expect(t.estado).toEqual({
        parada: { active: true, failedAttempts: 1 },
        pedido: { status: 'on_the_way', deliveryId: 'chofer-1' },
      });
      expect(t.release.notifyReleased).not.toHaveBeenCalled();
      expect(t.hoja.avisarReprogramacion).not.toHaveBeenCalled();
      expect(t.avisosDeVisita.visitaFallida).not.toHaveBeenCalled();
      expect(t.hoja.rehacer).not.toHaveBeenCalled();
      expect(t.notifier.alPanel).not.toHaveBeenCalled();
    });

    it('C5: si el pedido cambió de manos y la visita no se asienta, 409 y no se escribe nada', async () => {
      const t = armar({ intentos: { o2: 1 }, avance: [['o2', 'on_the_way']] });
      t.visitas.registrarDeHoja.mockResolvedValue(null);
      expect(
        await codigo(
          t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
            reason: FailedDeliveryReason.CUSTOMER_ABSENT,
          }),
        ),
      ).toBe('ROUTE_STOP_NOT_PENDING');
      expect(t.estado.parada.active).toBe(true);
      expect(t.estado.pedido.status).toBe('on_the_way');
      const primero = armar();
      primero.visitas.registrarDeHoja.mockResolvedValue(null);
      expect(
        await codigo(
          primero.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
            reason: FailedDeliveryReason.CUSTOMER_ABSENT,
          }),
        ),
      ).toBe('ROUTE_STOP_NOT_PENDING');
      expect(primero.estado.parada.failedAttempts).toBe(0);
    });

    it('C5: el día acordado que no vale corta antes de tocar la parada (el error del servicio sube)', async () => {
      const t = armar({ intentos: { o2: 1 }, avance: [['o2', 'on_the_way']] });
      t.visitas.prepararDeHoja.mockRejectedValue(
        new ConflictException('sin cupo'),
      );
      await expect(
        t.svc.noEntregada(
          DIST,
          'hoja-1',
          'o2',
          CHOFER_OPERA,
          { reason: FailedDeliveryReason.CUSTOMER_ABSENT },
          {
            reason: FailedVisitReason.CUSTOMER_ABSENT,
            agreed: { date: '2026-11-17', timeSlotId: 'franja-1' },
          },
        ),
      ).rejects.toThrow('sin cupo');
      expect(t.release.releaseWithin).not.toHaveBeenCalled();
      expect(t.estado.parada.active).toBe(true);
    });

    it('la hoja que dejó de estar en curso mientras tanto: 409 sin escribir', async () => {
      const t = armar({ hojaEnTransaccion: RouteBatchStatus.COMPLETED });
      expect(
        await codigo(
          t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
            reason: FailedDeliveryReason.CUSTOMER_ABSENT,
          }),
        ),
      ).toBe('ROUTE_SHEET_NOT_IN_PROGRESS');
      expect(t.visitas.registrarDeHoja).not.toHaveBeenCalled();
    });

    it('segundo intento con un pedido que ya no es del chofer de la hoja: 409 sin escribir', async () => {
      const t = armar({ intentos: { o2: 1 }, avance: [['o2', 'on_the_way']] });
      t.estado.pedido.deliveryId = 'otro-chofer';
      await expect(
        t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
          reason: FailedDeliveryReason.CUSTOMER_ABSENT,
        }),
      ).rejects.toThrow('El pedido ya no es del chofer de esta hoja de ruta');
      expect(t.estado.parada.active).toBe(true);
      expect(t.release.releaseWithin).not.toHaveBeenCalled();
    });

    it('C5: el primer intento queda en el historial de visitas sin contar ni avisar una nueva visita, con la ubicación del chofer', async () => {
      const t = armar({ avance: [['o2', 'on_the_way']] });
      const r = await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        CHOFER_OPERA,
        { reason: FailedDeliveryReason.CUSTOMER_ABSENT },
        {
          reason: FailedVisitReason.CUSTOMER_ABSENT,
          latitude: -27.36,
          longitude: -55.89,
          accuracyMeters: 8,
        },
      );
      expect(t.visitas.prepararDeHoja).not.toHaveBeenCalled();
      expect(t.visitas.registrarDeHoja).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'o2',
          salida: 'requeued',
          reason: FailedVisitReason.CUSTOMER_ABSENT,
          latitude: -27.36,
          longitude: -55.89,
          accuracyMeters: 8,
          userId: 'u-chofer',
          role: RoleType.DELIVERY,
        }),
        expect.any(Date),
        t.tx(),
      );
      expect(t.avisosDeVisita.visitaFallida).not.toHaveBeenCalled();
      expect(r.visita).toMatchObject({ outcome: 'requeued' });
    });

    it('C5: el segundo intento cuenta como visita fallida, queda propuesta con el día de la hoja y se le avisa al cliente una sola vez', async () => {
      const t = armar({ intentos: { o2: 1 } });
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.WRONG_ADDRESS,
        note: 'no existe el 123',
      });
      // Un motivo de la hoja sin equivalente va como «otro» con su texto.
      expect(t.visitas.registrarDeHoja).toHaveBeenCalledWith(
        expect.objectContaining({
          salida: 'rescheduled',
          rescheduledTo: '2026-11-16',
          reason: FailedVisitReason.OTHER,
          note: 'La dirección no es correcta: no existe el 123',
        }),
        expect.any(Date),
        t.tx(),
      );
      expect(t.avisosDeVisita.visitaFallida).toHaveBeenCalledTimes(1);
      expect(t.avisosDeVisita.visitaFallida).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'o2',
          customerId: 'c1',
          revisitStatus: 'proposed',
          scheduledDate: '2026-11-16',
          timeSlotId: 'franja-1',
        }),
        'Otro motivo: La dirección no es correcta: no existe el 123',
        { deHoja: true, adminYaAvisado: false },
      );
      expect(r.visita).toMatchObject({ outcome: 'proposed' });
    });

    it('C5: «otro motivo» sin nota lleva la etiqueta de la hoja', async () => {
      const t = armar({ intentos: { o2: 1 } });
      await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        CHOFER_OPERA,
        { reason: FailedDeliveryReason.OTHER },
        { reason: FailedVisitReason.OTHER },
      );
      expect(t.visitas.registrarDeHoja).toHaveBeenCalledWith(
        expect.objectContaining({ note: 'Otro motivo' }),
        expect.any(Date),
        t.tx(),
      );
    });

    it('C5: si la nueva visita quedó en otro día de la hoja (el primero sin cupo), ese día es el de la respuesta y la bandeja', async () => {
      const t = armar({ intentos: { o2: 1 } });
      t.visitas.registrarDeHoja.mockResolvedValue({
        visit: { failedVisitId: 'v1' },
        failedVisitCount: 1,
        outcome: 'proposed',
        revisitStatus: 'proposed',
        scheduledDate: '2026-11-17',
        timeSlotId: 'franja-2',
      });
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.CUSTOMER_ABSENT,
      });
      expect(r.rescheduledTo).toBe('2026-11-17');
      expect(t.hoja.avisarReprogramacion).toHaveBeenCalledWith(
        t.sheet,
        'o2',
        PLAN,
        '2026-11-17',
      );
    });

    it('C5: sin cupo en ningún día de la hoja, la parada queda esperando al admin y se lo pide el aviso de la visita (no la bandeja de la hoja)', async () => {
      const t = armar({ intentos: { o2: 1 } });
      t.visitas.registrarDeHoja.mockResolvedValue({
        visit: { failedVisitId: 'v1' },
        failedVisitCount: 1,
        outcome: 'awaiting_admin',
        revisitStatus: 'awaiting_admin',
        scheduledDate: null,
        timeSlotId: null,
      });
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.CUSTOMER_ABSENT,
      });
      expect(r).toMatchObject({ outcome: 'rescheduled', rescheduledTo: null });
      expect(t.estado.parada.removedReason).toBe(
        RouteStopRemovedReason.NEEDS_RESCHEDULE,
      );
      expect(t.hoja.avisarReprogramacion).not.toHaveBeenCalled();
      expect(t.avisosDeVisita.visitaFallida).toHaveBeenCalledWith(
        expect.objectContaining({ revisitStatus: 'awaiting_admin' }),
        expect.any(String),
        { deHoja: true, adminYaAvisado: false },
      );
    });

    it('C5: si con esta visita el pedido llega al tope, sale de la hoja esperando al admin y no se reprograma solo', async () => {
      const t = armar({ intentos: { o2: 1 }, alTope: true });
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.CUSTOMER_ABSENT,
      });
      expect(t.tx().update).toHaveBeenCalledWith(
        RouteBatchStop,
        { stopId: 's-o2' },
        expect.objectContaining({
          active: false,
          removedReason: RouteStopRemovedReason.NEEDS_RESCHEDULE,
        }),
      );
      expect(t.hoja.aplicarReprogramacion).not.toHaveBeenCalled();
      expect(t.visitas.registrarDeHoja).toHaveBeenCalledWith(
        expect.objectContaining({
          salida: 'rescheduled',
          rescheduledTo: null,
          dias: [],
        }),
        expect.any(Date),
        t.tx(),
      );
      expect(r).toMatchObject({ outcome: 'rescheduled', rescheduledTo: null });
      expect(t.hoja.avisarReprogramacion).not.toHaveBeenCalled();
      expect(t.avisosDeVisita.visitaFallida).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        { deHoja: true, adminYaAvisado: false },
      );
    });

    it('segundo intento sin día con la hoja abierta: rescheduledTo null, la bandeja de la hoja le pide al admin y la visita no lo repite', async () => {
      const sinDia: PlanDeReprogramacion = {
        fecha: null,
        dias: [],
        esperaAlAdmin: true,
        causa: 'sin_dia',
      };
      const t = armar({ intentos: { o2: 1 }, plan: sinDia });
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.NO_ACCESS,
      });
      expect(r).toMatchObject({ outcome: 'rescheduled', rescheduledTo: null });
      expect(t.hoja.aplicarReprogramacion).toHaveBeenCalledWith(
        t.tx(),
        t.sheet,
        'o2',
        sinDia,
      );
      expect(t.hoja.avisarReprogramacion).toHaveBeenCalledWith(
        t.sheet,
        'o2',
        sinDia,
        null,
      );
      expect(t.avisosDeVisita.visitaFallida).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        { deHoja: true, adminYaAvisado: true },
      );
    });

    it('C5: si al aplicar la planificación del día ya cerró, la visita y los avisos usan el plan revalidado', async () => {
      const t = armar({ intentos: { o2: 1 } });
      const otroDia: PlanDeReprogramacion = {
        ...PLAN,
        fecha: '2026-11-17',
        dias: ['2026-11-17'],
      };
      t.hoja.aplicarReprogramacion.mockResolvedValue(otroDia);
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.CUSTOMER_ABSENT,
      });
      expect(t.visitas.registrarDeHoja).toHaveBeenCalledWith(
        expect.objectContaining({
          rescheduledTo: '2026-11-17',
          dias: ['2026-11-17'],
        }),
        expect.any(Date),
        t.tx(),
      );
      expect(r.rescheduledTo).toBe('2026-11-17');
      expect(t.hoja.avisarReprogramacion).toHaveBeenCalledWith(
        t.sheet,
        'o2',
        otroDia,
        '2026-11-17',
      );

      const cerrado: PlanDeReprogramacion = {
        fecha: null,
        dias: [],
        esperaAlAdmin: true,
        causa: 'sin_dia',
      };
      const t2 = armar({ intentos: { o2: 1 } });
      t2.hoja.aplicarReprogramacion.mockResolvedValue(cerrado);
      const r2 = await t2.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.CUSTOMER_ABSENT,
      });
      expect(r2.rescheduledTo).toBeNull();
      expect(t2.visitas.registrarDeHoja).toHaveBeenCalledWith(
        expect.objectContaining({ rescheduledTo: null, dias: [] }),
        expect.any(Date),
        t2.tx(),
      );
      expect(t2.avisosDeVisita.visitaFallida).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        { deHoja: true, adminYaAvisado: true },
      );
    });

    it('un aviso que falla después del commit no deshace el intento', async () => {
      const t = armar({ intentos: { o2: 1 } });
      t.release.notifyReleased.mockRejectedValue(new Error('socket caído'));
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.CUSTOMER_ABSENT,
      });
      expect(r).toMatchObject({ outcome: 'rescheduled' });
      expect(t.estado.pedido.status).toBe('pending');
      expect(t.hoja.rehacer).toHaveBeenCalled();
    });

    it('el primer intento no trae rescheduledTo', async () => {
      const t = armar();
      const r = await t.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
        reason: FailedDeliveryReason.NO_ACCESS,
      });
      expect(r).not.toHaveProperty('rescheduledTo');
    });

    it('el admin en nombre del chofer: al chofer se le avisa; sin calculo, sin siguiente', async () => {
      const t = armar({ avance: [['o2', 'pending']] });
      t.hoja.rehacer.mockResolvedValue(null);
      const r = await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        { userId: 'u-admin', esChofer: false },
        { reason: FailedDeliveryReason.OTHER, note: 'portón cerrado' },
      );
      expect(t.hoja.choferDeLaHoja).not.toHaveBeenCalled();
      expect(t.hoja.choferDe).toHaveBeenCalledWith(t.sheet);
      expect(t.visitas.registrarDeHoja).toHaveBeenCalledWith(
        expect.objectContaining({
          role: RoleType.ADMIN,
          note: 'portón cerrado',
        }),
        expect.any(Date),
        t.tx(),
      );
      expect(t.hoja.avisarCambio).toHaveBeenCalledWith(
        CHOFER,
        'hoja-1',
        'stop_failed',
        {
          orderId: 'o2',
          attempt: 1,
          outcome: 'requeued',
          nextOrderId: null,
        },
      );
      expect(r.nextOrderId).toBeNull();
    });

    it('409 si la parada ya se entregó; si la liberación del segundo intento falla, sube sin escribir ni avisar', async () => {
      expect(
        await codigo(
          armar().svc.noEntregada(DIST, 'hoja-1', 'o1', CHOFER_OPERA, {
            reason: FailedDeliveryReason.NO_ACCESS,
          }),
        ),
      ).toBe('ROUTE_STOP_NOT_PENDING');
      const falla = armar({ intentos: { o2: 1 } });
      falla.release.releaseWithin.mockRejectedValue(
        new ConflictException('ya entregado'),
      );
      await expect(
        falla.svc.noEntregada(DIST, 'hoja-1', 'o2', CHOFER_OPERA, {
          reason: FailedDeliveryReason.WRONG_ADDRESS,
        }),
      ).rejects.toThrow('ya entregado');
      expect(falla.estado.parada.active).toBe(true);
      expect(falla.notifier.alPanel).not.toHaveBeenCalled();
      expect(falla.release.notifyReleased).not.toHaveBeenCalled();
    });

    it('sin chofer en la hoja ni cliente visible: el resto sigue igual', async () => {
      const t = armar();
      t.hoja.choferDe.mockResolvedValue(null);
      t.ds.query.mockResolvedValue([]);
      await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        { userId: 'u-admin', esChofer: false },
        {
          reason: FailedDeliveryReason.CUSTOMER_ABSENT,
        },
      );
      expect(t.hoja.rehacer).toHaveBeenCalledWith(DIST, 'hoja-1', null, {
        reordenar: true,
        postergado: 'o2',
      });
      expect(t.notifier.noEntregadoAlCliente).not.toHaveBeenCalled();
      expect(t.hoja.avisarCambio).not.toHaveBeenCalled();
    });
  });
});
