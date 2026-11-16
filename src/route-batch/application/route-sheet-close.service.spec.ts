import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import { RouteStopRemovedReason } from '../../order/entities/route-batch-stop.entity';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { StopProgress } from '../domain/route-sheet-execution';
import { RouteSheetCloseService } from './route-sheet-close.service';
import { RouteSheetEtaService } from './route-sheet-eta.service';
import { RouteSheetInProgress } from './route-sheet-in-progress.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import {
  ParadaEnCurso,
  RouteSheetProgress,
} from './route-sheet-progress.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import { hojaNoEncontrada, hojaOcupada } from './route-sheet.exceptions';
import { DIST, hoja, parada, pedido } from './route-sheet.fixtures';

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
    avance?: Array<[string, StopProgress]>;
    usuario?: string | null;
  } = {},
) {
  const sheet =
    o.sheet === undefined
      ? hoja({ status: RouteBatchStatus.ASSIGNED })
      : o.sheet;
  const save = jest.fn().mockResolvedValue(undefined);
  const ds = {
    manager: { findOne: jest.fn().mockResolvedValue(sheet) },
    query: jest
      .fn()
      .mockResolvedValue([
        { userId: o.usuario === undefined ? 'u-chofer' : o.usuario },
      ]),
  };
  const locks = {
    conCerrojo: jest.fn((_ids: string[], fn: () => unknown) => fn()),
    enTransaccion: jest.fn(
      (
        _d: string,
        _p: unknown,
        fn: (m: EntityManager, h: RouteBatch[]) => unknown,
      ) => fn({ save } as unknown as EntityManager, [sheet as RouteBatch]),
    ),
  };
  const progress = {
    paradas: jest.fn().mockResolvedValue(
      (
        o.avance ?? [
          ['o1', 'delivered'],
          ['o2', 'on_the_way'],
          ['o3', 'pending'],
        ]
      ).map(
        ([id, progress], i): ParadaEnCurso => ({
          stop: parada(id, i + 1),
          pedido: pedido(id),
          progress,
        }),
      ),
    ),
  };
  const writer = { apagarTodas: jest.fn().mockResolvedValue(undefined) };
  const eta = { olvidarChofer: jest.fn().mockResolvedValue(undefined) };
  const notifier = { alChofer: jest.fn(), alPanel: jest.fn() };
  const enCurso = {
    choferDeLaHoja: jest.fn().mockResolvedValue({}),
    sacarYLiberar: jest.fn().mockResolvedValue(undefined),
    reprogramar: jest.fn().mockResolvedValue('2026-11-16'),
  };
  const svc = new RouteSheetCloseService(
    ds as unknown as DataSource,
    locks as unknown as RouteSheetLocks,
    progress as unknown as RouteSheetProgress,
    writer as unknown as RouteSheetWriter,
    eta as unknown as RouteSheetEtaService,
    notifier as unknown as RouteSheetNotifier,
    enCurso as unknown as RouteSheetInProgress,
  );
  return { svc, sheet, save, locks, writer, eta, notifier, enCurso, progress };
}

describe('RouteSheetCloseService', () => {
  describe('cerrar (a mano)', () => {
    it('el chofer: libera la en camino y las pendientes (sheet_closed, con el motivo), cierra y avisa', async () => {
      const t = armar();
      const r = await t.svc.cerrar(
        DIST,
        'hoja-1',
        { userId: 'u-chofer', esChofer: true },
        'Se rompió la camioneta',
      );
      expect(t.enCurso.choferDeLaHoja).toHaveBeenCalledWith(
        DIST,
        'hoja-1',
        'u-chofer',
      );
      expect(
        (t.enCurso.sacarYLiberar.mock.calls as Array<[unknown, string]>).map(
          (c) => c[1],
        ),
      ).toEqual(['o2', 'o3']);
      expect(t.enCurso.sacarYLiberar).toHaveBeenCalledWith(
        t.sheet,
        'o2',
        { userId: 'u-chofer', esChofer: true },
        {
          motivo: RouteStopRemovedReason.SHEET_CLOSED,
          nota: 'Se rompió la camioneta',
        },
      );
      expect(r).toEqual({
        sheetId: 'hoja-1',
        alreadyClosed: false,
        releasedOrderIds: ['o2', 'o3'],
        rescheduled: [
          { orderId: 'o2', scheduledDate: '2026-11-16' },
          { orderId: 'o3', scheduledDate: '2026-11-16' },
        ],
      });
      // Lo pendiente se reprograma solo: no vuelve al despacho común.
      expect(t.enCurso.reprogramar).toHaveBeenCalledWith(t.sheet, 'o2');
      const h = t.sheet as RouteBatch;
      expect(h.status).toBe(RouteBatchStatus.COMPLETED);
      expect(h.closedAt).toBeInstanceOf(Date);
      expect(h.closeNote).toBe('Se rompió la camioneta');
      expect(t.writer.apagarTodas).toHaveBeenCalledWith(
        expect.anything(),
        'hoja-1',
        null,
      );
      expect(t.eta.olvidarChofer).toHaveBeenCalledWith('u-chofer');
      expect(t.notifier.alChofer).toHaveBeenCalledWith(
        'u-chofer',
        'route-sheet:closed',
        {
          sheetId: 'hoja-1',
          reason: 'manual',
          releasedOrderIds: ['o2', 'o3'],
        },
      );
      expect(t.notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:closed',
        expect.anything(),
      );
    });

    it('una parada que se entregó justo ahora (la liberación falla) queda como esté y el cierre sigue', async () => {
      const t = armar();
      t.enCurso.sacarYLiberar
        .mockRejectedValueOnce(new ConflictException('ya entregado'))
        .mockResolvedValueOnce(undefined);
      const r = await t.svc.cerrar(
        DIST,
        'hoja-1',
        { userId: 'u-admin', esChofer: false },
        'Fin del día',
      );
      expect(r.releasedOrderIds).toEqual(['o3']);
      expect(t.enCurso.reprogramar).toHaveBeenCalledTimes(1);
      expect(t.enCurso.choferDeLaHoja).not.toHaveBeenCalled();
    });

    it('ya cerrada: idempotente; sin iniciar: 409; no existe: 404', async () => {
      const cerrada = armar({
        sheet: hoja({ status: RouteBatchStatus.COMPLETED }),
      });
      expect(
        await cerrada.svc.cerrar(
          DIST,
          'hoja-1',
          { userId: 'u', esChofer: false },
          'motivo',
        ),
      ).toEqual({
        sheetId: 'hoja-1',
        alreadyClosed: true,
        releasedOrderIds: [],
        rescheduled: [],
      });
      expect(
        await codigo(
          armar({
            sheet: hoja({ status: RouteBatchStatus.CONFIRMED }),
          }).svc.cerrar(
            DIST,
            'hoja-1',
            { userId: 'u', esChofer: false },
            'motivo',
          ),
        ),
      ).toBe('ROUTE_SHEET_NOT_IN_PROGRESS');
      expect(
        await codigo(
          armar({ sheet: null }).svc.cerrar(
            DIST,
            'x',
            { userId: 'u', esChofer: false },
            'motivo',
          ),
        ),
      ).toBe('ROUTE_SHEET_NOT_FOUND');
    });

    it('el chofer de otra hoja: 404 antes de tocar nada', async () => {
      const t = armar();
      t.enCurso.choferDeLaHoja.mockRejectedValue(hojaNoEncontrada());
      expect(
        await codigo(
          t.svc.cerrar(
            DIST,
            'hoja-1',
            { userId: 'u', esChofer: true },
            'motivo',
          ),
        ),
      ).toBe('ROUTE_SHEET_NOT_FOUND');
      expect(t.locks.conCerrojo).not.toHaveBeenCalled();
    });

    it('si mientras liberaba alguien la cerró, no la vuelve a cerrar; sin chofer, sólo avisa al panel', async () => {
      const t = armar({ usuario: null });
      t.locks.enTransaccion.mockImplementationOnce(
        (
          _d: string,
          _p: unknown,
          fn: (m: EntityManager, h: RouteBatch[]) => unknown,
        ) =>
          fn({ save: t.save } as unknown as EntityManager, [
            hoja({ status: RouteBatchStatus.COMPLETED }),
          ]),
      );
      await t.svc.cerrar(
        DIST,
        'hoja-1',
        { userId: 'u', esChofer: false },
        'motivo',
      );
      expect(t.save).not.toHaveBeenCalled();
      expect(t.notifier.alChofer).not.toHaveBeenCalled();
      expect(t.notifier.alPanel).toHaveBeenCalled();
    });
  });

  describe('completarSiTermino', () => {
    it('cierra sola la hoja sin nada pendiente (sin motivo) y avisa', async () => {
      const t = armar({ avance: [['o1', 'delivered']] });
      expect(await t.svc.completarSiTermino(DIST, 'hoja-1')).toBe(true);
      expect((t.sheet as RouteBatch).status).toBe(RouteBatchStatus.COMPLETED);
      expect((t.sheet as RouteBatch).closeNote).toBeNull();
      expect(t.notifier.alChofer).toHaveBeenCalledWith(
        'u-chofer',
        'route-sheet:closed',
        {
          sheetId: 'hoja-1',
          reason: 'finished',
          releasedOrderIds: [],
        },
      );
    });

    it('con algo pendiente o ya cerrada no hace nada', async () => {
      const t = armar();
      expect(await t.svc.completarSiTermino(DIST, 'hoja-1')).toBe(false);
      expect(t.save).not.toHaveBeenCalled();
      const cerrada = armar({
        sheet: hoja({ status: RouteBatchStatus.COMPLETED }),
      });
      expect(await cerrada.svc.completarSiTermino(DIST, 'hoja-1')).toBe(false);
    });

    it('si la hoja está tomada o falla, no cierra y no lanza', async () => {
      const t = armar({ avance: [['o1', 'delivered']] });
      t.locks.conCerrojo.mockImplementation(() =>
        Promise.reject(hojaOcupada()),
      );
      expect(await t.svc.completarSiTermino(DIST, 'hoja-1')).toBe(false);
    });
  });
});
