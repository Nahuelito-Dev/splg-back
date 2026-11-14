import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { OrderStatus } from '../../order/entities/order.entity';
import {
  RouteBatchStop,
  RouteStopRemovedReason,
} from '../../order/entities/route-batch-stop.entity';
import { OrderService } from '../../order/order.service';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { StopProgress } from '../domain/route-sheet-execution';
import { RouteSheetInProgress } from './route-sheet-in-progress.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import {
  ParadaEnCurso,
  RouteSheetProgress,
} from './route-sheet-progress.service';
import {
  FailedDeliveryReason,
  RouteSheetStopsService,
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

function armar(
  o: {
    avance?: Array<[string, StopProgress]>;
    otroEnCamino?: boolean;
    intentos?: Record<string, number>;
    stop?: RouteBatchStop | null;
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
  const ds = {
    manager: {
      findOne: jest
        .fn()
        .mockResolvedValue(o.stop === undefined ? parada('o2', 2) : o.stop),
      update: jest.fn().mockResolvedValue(undefined),
    },
    query: jest.fn().mockResolvedValue([{ customerId: 'c1' }]),
  };
  const locks = {
    conCerrojo: jest.fn((_ids: string[], fn: () => unknown) => fn()),
  };
  const progress = { paradas: jest.fn().mockResolvedValue(paradas) };
  const orders = {
    updateStatus: jest.fn().mockResolvedValue({}),
    notifyDriverArrivedWithDistance: jest
      .fn()
      .mockResolvedValue({ message: 'Cliente notificado' }),
    postergarEntrega: jest.fn().mockResolvedValue({}),
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
    sacarYLiberar: jest.fn().mockResolvedValue(undefined),
    choferDe: jest.fn().mockResolvedValue(CHOFER),
    reprogramar: jest.fn().mockResolvedValue('2026-11-16'),
  };
  const svc = new RouteSheetStopsService(
    ds as unknown as DataSource,
    locks as unknown as RouteSheetLocks,
    progress as unknown as RouteSheetProgress,
    orders as unknown as OrderService,
    notifier as unknown as RouteSheetNotifier,
    hojaEnCurso as unknown as RouteSheetInProgress,
  );
  return { svc, ds, locks, orders, notifier, hoja: hojaEnCurso, sheet };
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
    it('primer intento, en camino: vuelve a aceptado con el mismo chofer, la parada pasa al final de la cola y se avisa al cliente y al admin', async () => {
      const t = armar({
        avance: [
          ['o1', 'delivered'],
          ['o2', 'on_the_way'],
          ['o3', 'pending'],
        ],
      });
      const r = await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        { userId: 'u-chofer', esChofer: true },
        {
          reason: FailedDeliveryReason.CUSTOMER_ABSENT,
          note: '  tocó timbre  ',
        },
      );
      expect(r).toEqual({
        sheetId: 'hoja-1',
        orderId: 'o2',
        nextOrderId: 'o3',
        attempt: 1,
        outcome: 'requeued',
        // Sin hora estimada (el recálculo no la dio): sin franja nueva.
        newWindowStart: null,
        newWindowEnd: null,
      });
      expect(t.orders.postergarEntrega).toHaveBeenCalledWith('o2', 'chofer-1');
      expect(t.orders.updateStatus).not.toHaveBeenCalled();
      expect(t.hoja.sacarYLiberar).not.toHaveBeenCalled();
      expect(t.ds.manager.update).toHaveBeenCalledWith(
        RouteBatchStop,
        { stopId: 's-o2' },
        expect.objectContaining({
          failedAttempts: 1,
          lastFailureNote: 'El cliente no estaba: tocó timbre',
          arrivedAt: null,
          waitAlertedAt: null,
        }),
      );
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
      const r = await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        { userId: 'u-chofer', esChofer: true },
        { reason: FailedDeliveryReason.CUSTOMER_ABSENT },
      );
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
      const r = await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        { userId: 'u-chofer', esChofer: true },
        { reason: FailedDeliveryReason.REJECTED },
      );
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
      await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        { userId: 'u', esChofer: true },
        {
          reason: FailedDeliveryReason.NO_ACCESS,
        },
      );
      expect(t.orders.postergarEntrega).not.toHaveBeenCalled();
    });

    it('segundo intento: sale de la hoja (rescheduled), se le libera al chofer y el sistema lo reprograma solo para el día hábil siguiente', async () => {
      const t = armar({ intentos: { o2: 1 }, avance: [['o2', 'on_the_way']] });
      const r = await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        { userId: 'u-chofer', esChofer: true },
        { reason: FailedDeliveryReason.REJECTED },
      );
      expect(r).toMatchObject({
        attempt: 2,
        outcome: 'rescheduled',
        rescheduledTo: '2026-11-16',
      });
      expect(t.hoja.sacarYLiberar).toHaveBeenCalledWith(
        t.sheet,
        'o2',
        { userId: 'u-chofer', esChofer: true },
        {
          motivo: RouteStopRemovedReason.RESCHEDULED,
          nota: 'El cliente rechazó el pedido',
        },
      );
      expect(t.hoja.reprogramar).toHaveBeenCalledWith(t.sheet, 'o2');
      expect(t.orders.postergarEntrega).not.toHaveBeenCalled();
      expect(t.ds.manager.update).toHaveBeenCalledWith(
        RouteBatchStop,
        { stopId: 's-o2' },
        expect.objectContaining({ failedAttempts: 2 }),
      );
      // El cliente se entera por el aviso de la reprogramación; el panel, por el evento.
      expect(t.notifier.noEntregadoAlCliente).not.toHaveBeenCalled();
      expect(t.notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:stop-failed',
        expect.objectContaining({ attempt: 2, outcome: 'rescheduled' }),
      );
      expect(t.notifier.aLaBandeja).not.toHaveBeenCalled();
    });

    it('segundo intento que no se pudo reprogramar: rescheduledTo null (espera al admin)', async () => {
      const t = armar({ intentos: { o2: 1 } });
      t.hoja.reprogramar.mockResolvedValue(null);
      const r = await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        { userId: 'u', esChofer: true },
        {
          reason: FailedDeliveryReason.NO_ACCESS,
        },
      );
      expect(r).toMatchObject({ outcome: 'rescheduled', rescheduledTo: null });
    });

    it('el primer intento no trae rescheduledTo', async () => {
      const t = armar();
      const r = await t.svc.noEntregada(
        DIST,
        'hoja-1',
        'o2',
        { userId: 'u', esChofer: true },
        {
          reason: FailedDeliveryReason.NO_ACCESS,
        },
      );
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

    it('409 si la parada ya se entregó; si la liberación del segundo intento falla, sube sin avisos', async () => {
      expect(
        await codigo(
          armar().svc.noEntregada(
            DIST,
            'hoja-1',
            'o1',
            { userId: 'u', esChofer: true },
            {
              reason: FailedDeliveryReason.NO_ACCESS,
            },
          ),
        ),
      ).toBe('ROUTE_STOP_NOT_PENDING');
      const falla = armar({ intentos: { o2: 1 } });
      falla.hoja.sacarYLiberar.mockRejectedValue(
        new ConflictException('ya entregado'),
      );
      await expect(
        falla.svc.noEntregada(
          DIST,
          'hoja-1',
          'o2',
          { userId: 'u', esChofer: true },
          {
            reason: FailedDeliveryReason.WRONG_ADDRESS,
          },
        ),
      ).rejects.toThrow('ya entregado');
      expect(falla.notifier.alPanel).not.toHaveBeenCalled();
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
