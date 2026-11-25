import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { OrderStatus } from '../../order/entities/order.entity';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import { RouteStopRemovedReason } from '../../order/entities/route-batch-stop.entity';
import { OrderService } from '../../order/order.service';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { StopProgress } from '../domain/route-sheet-execution';
import { RouteSheetDataService } from './route-sheet-data.service';
import { RouteSheetInProgressEditingService } from './route-sheet-in-progress-editing.service';
import { RouteSheetInProgress } from './route-sheet-in-progress.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import {
  ParadaEnCurso,
  RouteSheetProgress,
} from './route-sheet-progress.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import { paradaNoEncontrada, versionVieja } from './route-sheet.exceptions';
import { DIA, DIST, hoja, parada, pedido } from './route-sheet.fixtures';

const CHOFER = { deliveryId: 'chofer-1', userId: 'u-chofer' } as Delivery;
const CALCULO = {
  recorrido: { hechas: [], enCamino: null, pendientes: ['o1', 'o9'] },
  cola: ['o1', 'o9'],
  etas: [],
  origen: 'gps' as const,
};

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
    pedido?: ReturnType<typeof pedido> | null;
    avance?: Array<[string, StopProgress]>;
    chofer?: Delivery | null;
  } = {},
) {
  const sheet = hoja({ status: RouteBatchStatus.ASSIGNED, planDate: DIA });
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
  const progress = {
    rehacer: jest.fn().mockResolvedValue(CALCULO),
    posicionDelChofer: jest.fn().mockResolvedValue(null),
    paradas: jest.fn().mockResolvedValue(
      (o.avance ?? [['o1', 'pending']]).map(
        ([id, progress], i): ParadaEnCurso => ({
          stop: parada(id, i + 1),
          pedido: pedido(id),
          progress,
        }),
      ),
    ),
  };
  const writer = { activarParada: jest.fn().mockResolvedValue(undefined) };
  const data = {
    pedidos: jest
      .fn()
      .mockResolvedValue(o.pedido === null ? [] : [o.pedido ?? pedido('o9')]),
  };
  const orders = {
    assignDelivery: jest.fn().mockResolvedValue({}),
    updateStatus: jest.fn().mockResolvedValue({}),
  };
  const enCurso = {
    enCurso: jest.fn().mockResolvedValue(sheet),
    choferDe: jest
      .fn()
      .mockResolvedValue(o.chofer === undefined ? CHOFER : o.chofer),
    trasCambio: jest.fn().mockResolvedValue(undefined),
    avisarCambio: jest.fn(),
    parada: jest.fn((ps: ParadaEnCurso[], id: string) => {
      const p = ps.find((x) => x.stop.orderId === id);
      if (!p) throw paradaNoEncontrada();
      return p;
    }),
    sacarYLiberar: jest.fn().mockResolvedValue(undefined),
    rehacer: jest.fn().mockResolvedValue(CALCULO),
  };
  const svc = new RouteSheetInProgressEditingService(
    { manager: {} } as unknown as DataSource,
    locks as unknown as RouteSheetLocks,
    progress as unknown as RouteSheetProgress,
    writer as unknown as RouteSheetWriter,
    data as unknown as RouteSheetDataService,
    orders as unknown as OrderService,
    enCurso as unknown as RouteSheetInProgress,
  );
  return { svc, sheet, save, locks, progress, writer, orders, enCurso };
}

describe('RouteSheetInProgressEditingService', () => {
  describe('agregarEnCurso', () => {
    it('asigna el pedido al chofer, activa la parada, la inserta en la cola, sube la versión y avisa (D-05)', async () => {
      const t = armar();
      await t.svc.agregarEnCurso(
        DIST,
        'hoja-1',
        { version: 3, orderId: 'o9', position: 2 },
        'u-admin',
      );
      expect(t.orders.assignDelivery).toHaveBeenCalledWith(
        'o9',
        'chofer-1',
        DIST,
        {
          soloSiLibre: true,
          metodo: 'route_sheet',
        },
      );
      expect(t.writer.activarParada).toHaveBeenCalledWith(
        expect.anything(),
        'hoja-1',
        'o9',
        false,
      );
      expect(t.sheet.editedAt).toBeInstanceOf(Date);
      expect(t.save).toHaveBeenCalledWith(t.sheet);
      expect(t.progress.rehacer).toHaveBeenCalledWith(
        expect.anything(),
        t.sheet,
        expect.objectContaining({ insertar: { orderId: 'o9', en: 2 } }),
      );
      expect(t.enCurso.trasCambio).toHaveBeenCalledWith(
        DIST,
        'hoja-1',
        CALCULO,
        CHOFER,
      );
      expect(t.enCurso.avisarCambio).toHaveBeenCalledWith(
        CHOFER,
        'hoja-1',
        'stop_added',
        {
          orderId: 'o9',
        },
      );
    });

    it('el pedido tiene que existir, estar libre y ser de ese día (404/409) antes de asignarlo', async () => {
      expect(
        await codigo(
          armar({ pedido: null }).svc.agregarEnCurso(
            DIST,
            'hoja-1',
            { version: 3, orderId: 'x' },
            'u',
          ),
        ),
      ).toBe('ORDER_NOT_FOUND');
      expect(
        await codigo(
          armar({
            pedido: pedido('o9', { activeBatchId: 'otra' }),
          }).svc.agregarEnCurso(
            DIST,
            'hoja-1',
            { version: 3, orderId: 'o9' },
            'u',
          ),
        ),
      ).toBe('ORDER_ALREADY_IN_ROUTE');
      const otroDia = armar({
        pedido: pedido('o9', { scheduledDate: '2026-12-01' }),
      });
      expect(
        await codigo(
          otroDia.svc.agregarEnCurso(
            DIST,
            'hoja-1',
            { version: 3, orderId: 'o9' },
            'u',
          ),
        ),
      ).toBe('ORDER_NOT_PLANNABLE');
      expect(otroDia.orders.assignDelivery).not.toHaveBeenCalled();
    });

    it('si el pedido ya no está libre (409 de la asignación), no se toca la hoja', async () => {
      const t = armar();
      t.orders.assignDelivery.mockRejectedValue(new ConflictException('ya no'));
      await expect(
        t.svc.agregarEnCurso(
          DIST,
          'hoja-1',
          { version: 3, orderId: 'o9' },
          'u',
        ),
      ).rejects.toThrow('ya no');
      expect(t.writer.activarParada).not.toHaveBeenCalled();
    });

    it('si la parada no entra (versión vieja en el medio), el pedido se libera y el error sube', async () => {
      const t = armar();
      t.locks.enTransaccion.mockImplementation(() =>
        Promise.reject(versionVieja()),
      );
      expect(
        await codigo(
          t.svc.agregarEnCurso(
            DIST,
            'hoja-1',
            { version: 3, orderId: 'o9' },
            'u-admin',
          ),
        ),
      ).toBe('ROUTE_SHEET_VERSION_CONFLICT');
      expect(t.orders.updateStatus).toHaveBeenCalledWith(
        'o9',
        OrderStatus.PENDING,
        undefined,
        RoleType.ADMIN,
        'u-admin',
      );
      t.orders.updateStatus.mockRejectedValue(new Error('no se pudo'));
      expect(
        await codigo(
          t.svc.agregarEnCurso(
            DIST,
            'hoja-1',
            { version: 3, orderId: 'o9' },
            'u-admin',
          ),
        ),
      ).toBe('ROUTE_SHEET_VERSION_CONFLICT');
    });

    it('con posición del chofer, sin chofer no avisa', async () => {
      const con = armar();
      con.progress.posicionDelChofer.mockResolvedValue({ lat: 1, lng: 2 });
      await con.svc.agregarEnCurso(
        DIST,
        'hoja-1',
        { version: 3, orderId: 'o9' },
        'u',
      );
      expect(con.progress.rehacer).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ posicion: { lat: 1, lng: 2 } }),
      );
      const sin = armar({ chofer: null });
      await sin.svc.agregarEnCurso(
        DIST,
        'hoja-1',
        { version: 3, orderId: 'o9' },
        'u',
      );
      expect(sin.enCurso.avisarCambio).not.toHaveBeenCalled();
      expect(sin.progress.posicionDelChofer).not.toHaveBeenCalled();
    });
  });

  describe('quitarEnCurso', () => {
    it('saca una pendiente (motivo admin, sube la versión), libera el pedido, reordena y avisa', async () => {
      const t = armar();
      await t.svc.quitarEnCurso(DIST, 'hoja-1', 'o1', 3, 'u-admin');
      expect(t.enCurso.enCurso).toHaveBeenCalledWith(DIST, 'hoja-1', 3);
      expect(t.enCurso.sacarYLiberar).toHaveBeenCalledWith(
        t.sheet,
        'o1',
        { userId: 'u-admin', esChofer: false },
        { motivo: RouteStopRemovedReason.ADMIN, nota: null },
        true,
      );
      expect(t.enCurso.rehacer).toHaveBeenCalledWith(
        DIST,
        'hoja-1',
        'u-chofer',
        {
          reordenar: true,
        },
      );
      expect(t.enCurso.avisarCambio).toHaveBeenCalledWith(
        CHOFER,
        'hoja-1',
        'stop_removed',
        {
          orderId: 'o1',
        },
      );
    });

    it('409 si está en camino o entregada; 404 si no es de la hoja; sin chofer no avisa', async () => {
      expect(
        await codigo(
          armar({ avance: [['o1', 'on_the_way']] }).svc.quitarEnCurso(
            DIST,
            'hoja-1',
            'o1',
            3,
            'u',
          ),
        ),
      ).toBe('ROUTE_STOP_NOT_PENDING');
      expect(
        await codigo(armar().svc.quitarEnCurso(DIST, 'hoja-1', 'o9', 3, 'u')),
      ).toBe('ROUTE_STOP_NOT_FOUND');
      const sin = armar({ chofer: null });
      await sin.svc.quitarEnCurso(DIST, 'hoja-1', 'o1', 3, 'u');
      expect(sin.enCurso.rehacer).toHaveBeenCalledWith(DIST, 'hoja-1', null, {
        reordenar: true,
      });
      expect(sin.enCurso.avisarCambio).not.toHaveBeenCalled();
    });
  });
});
