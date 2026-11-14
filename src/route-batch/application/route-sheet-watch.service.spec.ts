import { DataSource } from 'typeorm';
import { EVENTO_NOTIFICAR_ADMIN } from '../../common/events/notificar-admin.event';
import { RouteSheetAssignmentService } from './route-sheet-assignment.service';
import { RouteSheetCloseService } from './route-sheet-close.service';
import { RouteSheetEtaService } from './route-sheet-eta.service';
import { RouteSheetInProgress } from './route-sheet-in-progress.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import { RouteSheetWatchService } from './route-sheet-watch.service';
import { DIST } from './route-sheet.fixtures';

const CHOFER = { userId: 'u-chofer', deliveryId: 'chofer-1' };

function armar(
  o: {
    distribuidora?: string | null;
    sacadas?: Array<{ batchId: string; orderId: string; cause: string }>;
    terminadas?: Array<{ batchId: string; distributorId: string }>;
    sinIniciar?: Array<Record<string, unknown>>;
    deliveryId?: string | null;
    vencidas?: Array<Record<string, unknown>>;
  } = {},
) {
  const query = jest.fn((sql: string, params?: unknown[]) => {
    void params;
    if (sql.startsWith(`SELECT "distributor_id"`)) {
      return Promise.resolve(
        o.distribuidora === null
          ? []
          : [{ distributorId: o.distribuidora ?? DIST }],
      );
    }
    if (sql.includes('"wait_alerted_at" = $1')) {
      return Promise.resolve(o.vencidas ?? []);
    }
    if (sql.includes('UPDATE "route_batch_stop"')) {
      return Promise.resolve(o.sacadas ?? []);
    }
    if (sql.includes('NOT EXISTS')) return Promise.resolve(o.terminadas ?? []);
    if (sql.includes(`"status" = 'confirmed'`)) {
      return Promise.resolve(o.sinIniciar ?? []);
    }
    if (sql.includes('SELECT "delivery_id"')) {
      return Promise.resolve([
        { deliveryId: o.deliveryId === undefined ? 'chofer-1' : o.deliveryId },
      ]);
    }
    return Promise.resolve([]);
  });
  const close = { completarSiTermino: jest.fn().mockResolvedValue(false) };
  const eta = {
    recalcular: jest.fn().mockResolvedValue(null),
    recienRecalculada: jest.fn().mockResolvedValue(false),
    porReloj: jest.fn().mockResolvedValue(3),
  };
  const hoja = {
    choferDe: jest.fn().mockResolvedValue(CHOFER),
    avisarCambio: jest.fn(),
  };
  const events = { emit: jest.fn() };
  const asignacion = { asignarLasDeHoy: jest.fn().mockResolvedValue(2) };
  const notifier = {
    alChofer: jest.fn(),
    pushAlChofer: jest.fn().mockResolvedValue(undefined),
    alPanel: jest.fn(),
    aLaBandeja: jest.fn((d: string, a: Record<string, unknown>) => {
      events.emit(EVENTO_NOTIFICAR_ADMIN, { d, ...a });
    }),
  };
  const svc = new RouteSheetWatchService(
    { query } as unknown as DataSource,
    close as unknown as RouteSheetCloseService,
    eta as unknown as RouteSheetEtaService,
    hoja as unknown as RouteSheetInProgress,
    notifier as unknown as RouteSheetNotifier,
    asignacion as unknown as RouteSheetAssignmentService,
  );
  return { svc, query, close, eta, hoja, notifier, asignacion };
}

describe('RouteSheetWatchService', () => {
  describe('onParada (aviso después del commit)', () => {
    it.each(['cancelled', 'released', 'reassigned'] as const)(
      '%s: si no terminó, reordena, avisa al chofer y al panel',
      async (cause) => {
        const t = armar();
        await t.svc.onParada({ batchId: 'hoja-1', orderId: 'o1', cause });
        expect(t.close.completarSiTermino).toHaveBeenCalledWith(DIST, 'hoja-1');
        expect(t.eta.recalcular).toHaveBeenCalledWith(DIST, 'hoja-1', {
          reordenar: true,
        });
        expect(t.hoja.avisarCambio).toHaveBeenCalledWith(
          CHOFER,
          'hoja-1',
          'stop_removed',
          { orderId: 'o1', cause },
        );
        expect(t.notifier.alPanel).toHaveBeenCalledWith(
          DIST,
          'route-sheet:updated',
          {
            sheetId: 'hoja-1',
            orderId: 'o1',
            cause,
          },
        );
      },
    );

    it('entregado: cierra la hoja si era la última (y nada más)', async () => {
      const t = armar();
      t.close.completarSiTermino.mockResolvedValue(true);
      await t.svc.onParada({
        batchId: 'hoja-1',
        orderId: 'o1',
        cause: 'delivered',
      });
      expect(t.eta.recalcular).not.toHaveBeenCalled();
      expect(t.notifier.alPanel).not.toHaveBeenCalled();
    });

    it('entregado o en camino sin terminar: avisa el avance y recalcula sin reordenar, salvo que se acabe de recalcular', async () => {
      const t = armar();
      await t.svc.onParada({
        batchId: 'hoja-1',
        orderId: 'o1',
        cause: 'on_the_way',
      });
      expect(t.notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:stop-progress',
        {
          sheetId: 'hoja-1',
          orderId: 'o1',
          progress: 'on_the_way',
        },
      );
      expect(t.eta.recalcular).toHaveBeenCalledWith(DIST, 'hoja-1', {
        reordenar: false,
      });
      t.eta.recienRecalculada.mockResolvedValue(true);
      await t.svc.onParada({
        batchId: 'hoja-1',
        orderId: 'o1',
        cause: 'delivered',
      });
      expect(t.eta.recalcular).toHaveBeenCalledTimes(1);
    });

    it('una hoja que no existe, sin chofer, o un error: no lanza', async () => {
      const nada = armar({ distribuidora: null });
      await nada.svc.onParada({
        batchId: 'x',
        orderId: 'o1',
        cause: 'cancelled',
      });
      expect(nada.close.completarSiTermino).not.toHaveBeenCalled();
      const sinChofer = armar({ deliveryId: null });
      await sinChofer.svc.onParada({
        batchId: 'hoja-1',
        orderId: 'o1',
        cause: 'cancelled',
      });
      expect(sinChofer.hoja.avisarCambio).not.toHaveBeenCalled();
      const sinPerfil = armar();
      sinPerfil.hoja.choferDe.mockResolvedValue(null);
      await sinPerfil.svc.onParada({
        batchId: 'hoja-1',
        orderId: 'o1',
        cause: 'released',
      });
      expect(sinPerfil.hoja.avisarCambio).not.toHaveBeenCalled();
      const rota = armar();
      rota.eta.recalcular.mockRejectedValue(new Error('osrm'));
      await expect(
        rota.svc.onParada({
          batchId: 'hoja-1',
          orderId: 'o1',
          cause: 'cancelled',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('vigilar (cada minuto)', () => {
    it('saca las paradas cuyo pedido ya no es del chofer, cierra las terminadas, recalcula por reloj y avisa las sin iniciar', async () => {
      const t = armar({
        sacadas: [{ batchId: 'hoja-1', orderId: 'o1', cause: 'released' }],
        terminadas: [
          { batchId: 'hoja-2', distributorId: DIST },
          { batchId: 'hoja-3', distributorId: DIST },
        ],
        sinIniciar: [
          {
            batchId: 'hoja-4',
            distributorId: DIST,
            number: 12,
            driverName: 'Juan',
          },
          {
            batchId: 'hoja-5',
            distributorId: DIST,
            number: null,
            driverName: null,
          },
        ],
      });
      t.close.completarSiTermino.mockImplementation((_d: string, id: string) =>
        Promise.resolve(id === 'hoja-2'),
      );
      const r = await t.svc.vigilar(Date.parse('2026-11-14T13:00:00Z'));
      expect(r).toEqual({
        assigned: 2,
        waitExpired: 0,
        reconciled: 1,
        completed: 1,
        etaRecalculated: 3,
        notStartedAlerts: 2,
      });
      const [sql] = t.query.mock.calls.find(
        (c) =>
          String(c[0]).includes('UPDATE "route_batch_stop"') &&
          !String(c[0]).includes('wait_alerted_at'),
      ) as [string];
      // Liberado por fuera de la hoja: espera al admin, no vuelve al despacho.
      expect(sql).toContain(`THEN 'needs_reschedule'`);
      expect(sql).not.toContain('failed_delivery');
      expect(sql).toContain(`b."status" = 'assigned'`);
      expect(sql).toContain(`o."status"::text <> 'delivered'`);
      expect(sql).toContain('IS DISTINCT FROM b."delivery_id"');
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(DIST, {
        kind: 'route_sheet_not_started',
        title: 'Hoja de ruta sin iniciar',
        body: 'La hoja N° 12 de Juan ya debería haber salido y todavía no se inició.',
        dedupeKey: 'route-sheet-not-started:hoja-4',
      });
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(
        DIST,
        expect.objectContaining({
          body: 'La hoja de un chofer ya debería haber salido y todavía no se inició.',
        }),
      );
      const conHora = t.query.mock.calls.find((c) =>
        String(c[0]).includes(`"status" = 'confirmed'`),
      ) as [string, unknown[]];
      expect(conHora[1]).toEqual(['2026-11-14T13:00:00.000Z']);
    });
  });

  describe('espera en la puerta vencida', () => {
    it('le sugiere al chofer «No pude entregar» (socket y push) y avisa al panel, una vez por llegada', async () => {
      const llegada = new Date('2026-11-14T13:00:00Z');
      const t = armar({
        vencidas: [
          {
            batchId: 'hoja-1',
            orderId: 'o1',
            distributorId: DIST,
            driverUserId: 'u-chofer',
            token: 'tok',
            arrivedAt: llegada,
            waitMinutes: 10,
          },
          {
            batchId: 'hoja-2',
            orderId: 'o9',
            distributorId: DIST,
            driverUserId: null,
            token: null,
            arrivedAt: llegada,
            waitMinutes: 5,
          },
        ],
      });
      const r = await t.svc.vigilar(Date.parse('2026-11-14T13:11:00Z'));
      expect(r.waitExpired).toBe(2);
      const payload = {
        sheetId: 'hoja-1',
        orderId: 'o1',
        arrivedAt: llegada.toISOString(),
        waitMinutes: 10,
      };
      expect(t.notifier.alChofer).toHaveBeenCalledWith(
        'u-chofer',
        'route-sheet:wait-expired',
        payload,
      );
      expect(t.notifier.alChofer).toHaveBeenCalledTimes(1);
      expect(t.notifier.pushAlChofer).toHaveBeenCalledWith(
        'tok',
        'hoja-1',
        expect.stringContaining('Pasaron 10 minutos'),
        'Venció la espera',
        'ROUTE_SHEET_WAIT_EXPIRED',
      );
      expect(t.notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:wait-expired',
        payload,
      );
      const [sql, params] = t.query.mock.calls.find((c) =>
        String(c[0]).includes('"wait_alerted_at" = $1'),
      ) as [string, unknown[]];
      expect(sql).toContain('"wait_alerted_at" IS NULL');
      expect(sql).toContain(`o."status"::text = 'on_the_way'`);
      expect(sql).toContain(`'arrivalWaitMinutes')::int, 10)`);
      expect(params).toEqual(['2026-11-14T13:11:00.000Z']);
    });
  });
});
