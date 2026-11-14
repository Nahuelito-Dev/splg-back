import { DataSource, QueryFailedError } from 'typeorm';
import {
  dentroDeCorrida,
  nuevaCorrida,
} from '../../process-run/process-run.context';
import { resolverCierre } from '../../process-run/process-run.recorder';
import { ProcessRunStatus } from '../../process-run/domain/process-catalog';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { RoutePlanAutoConfirmService } from './route-plan-auto-confirm.service';
import { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import { RouteSheetLifecycleService } from './route-sheet-lifecycle.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import {
  hojaNoEditable,
  hojaOcupada,
  noConfirmable,
  versionVieja,
} from './route-sheet.exceptions';

const DIST = 'dist-1';
const MIN = 60_000;
// 13/11 a las 18:00 de Argentina: la propuesta de mañana (14/11).
const PROPUESTA = new Date('2026-11-13T21:00:00Z');
const MANANA = '2026-11-14';

type Fila = {
  batchId: string;
  distributorId: string;
  planDate: string;
  version: number;
  number: number | null;
  driverName: string | null;
  proposedAt: Date;
  editedAt: Date | null;
};

const fila = (over: Partial<Fila> = {}): Fila => ({
  batchId: 'hoja-1',
  distributorId: DIST,
  planDate: MANANA,
  version: 4,
  number: null,
  driverName: 'Juan Pérez',
  proposedAt: PROPUESTA,
  editedAt: null,
  ...over,
});

function armar(
  filas: Fila[],
  params: Record<string, number> = {
    enabled: 1,
    autoConfirm: 1,
    reviewMinutes: 60,
  },
  sinHoja: ReadonlySet<string> = new Set(),
) {
  const ds = { query: jest.fn().mockResolvedValue(filas) };
  const processConfig = { obtener: jest.fn().mockResolvedValue(params) };
  const lifecycle = { confirmar: jest.fn().mockResolvedValue(undefined) };
  const notifier = { aLaBandeja: jest.fn() };
  const svc = new RoutePlanAutoConfirmService(
    ds as unknown as DataSource,
    processConfig as unknown as ProcessConfigService,
    lifecycle as unknown as RouteSheetLifecycleService,
    notifier as unknown as RouteSheetNotifier,
    {
      calcular: (id: string) =>
        Promise.resolve({
          modulos: new Set(sinHoja.has(id) ? [] : ['route_planning']),
        }),
    } as unknown as AccesoDeLaEmpresa,
  );
  return { svc, ds, processConfig, lifecycle, notifier };
}

const despues = (min: number) => new Date(PROPUESTA.getTime() + min * MIN);

describe('RoutePlanAutoConfirmService', () => {
  describe('confirmarLasVencidas', () => {
    it('a los reviewMinutes de la propuesta la confirma con la misma operación que el admin, como sistema', async () => {
      const t = armar([fila()]);
      await expect(t.svc.confirmarLasVencidas(despues(60))).resolves.toEqual({
        autoConfirmed: 1,
        autoConfirmFailed: 0,
        autoConfirmRetry: 0,
      });
      // La misma operación que POST …/confirm: validación, avisos al cliente
      // y al chofer; con la versión leída y sin usuario (actor de sistema).
      expect(t.lifecycle.confirmar).toHaveBeenCalledWith(
        DIST,
        'hoja-1',
        { version: 4 },
        null,
      );
      expect(t.notifier.aLaBandeja).not.toHaveBeenCalled();
    });

    it('antes de los reviewMinutes no la confirma', async () => {
      const t = armar([fila()]);
      await expect(
        t.svc.confirmarLasVencidas(despues(59)),
      ).resolves.toMatchObject({ autoConfirmed: 0 });
      expect(t.lifecycle.confirmar).not.toHaveBeenCalled();
    });

    it('con reviewMinutes = 0 la confirma al proponer', async () => {
      const t = armar([fila()], {
        enabled: 1,
        autoConfirm: 1,
        reviewMinutes: 0,
      });
      await t.svc.confirmarLasVencidas(PROPUESTA);
      expect(t.lifecycle.confirmar).toHaveBeenCalledTimes(1);
    });

    it('con la hoja de ruta deshabilitada por la plataforma no confirma los borradores de esa empresa; los de otra sí', async () => {
      const t = armar(
        [fila(), fila({ batchId: 'hoja-otra', distributorId: 'dist-2' })],
        { enabled: 1, autoConfirm: 1, reviewMinutes: 0 },
        new Set([DIST]),
      );
      const r = await t.svc.confirmarLasVencidas(PROPUESTA);
      expect(t.lifecycle.confirmar).toHaveBeenCalledTimes(1);
      expect(t.processConfig.obtener).not.toHaveBeenCalledWith(
        DIST,
        expect.anything(),
      );
      expect(r).toEqual({
        autoConfirmed: 1,
        autoConfirmFailed: 0,
        autoConfirmRetry: 0,
      });
    });

    it('con autoConfirm 0 o la hoja apagada no confirma nada', async () => {
      for (const params of [
        { enabled: 1, autoConfirm: 0, reviewMinutes: 0 },
        { enabled: 0, autoConfirm: 1, reviewMinutes: 0 },
      ]) {
        const t = armar([fila()], params);
        await t.svc.confirmarLasVencidas(despues(600));
        expect(t.lifecycle.confirmar).not.toHaveBeenCalled();
      }
    });

    it('la que el admin editó también se confirma sola a la hora de la propuesta', async () => {
      const t = armar([fila({ editedAt: despues(55) })]);
      await t.svc.confirmarLasVencidas(despues(60));
      expect(t.lifecycle.confirmar).toHaveBeenCalledTimes(1);
    });

    it('la que el admin reabrió cuenta la ventana desde su última edición', async () => {
      const t = armar([fila({ number: 7, editedAt: despues(120) })]);
      await t.svc.confirmarLasVencidas(despues(150));
      expect(t.lifecycle.confirmar).not.toHaveBeenCalled();
      await t.svc.confirmarLasVencidas(despues(180));
      expect(t.lifecycle.confirmar).toHaveBeenCalledTimes(1);
    });

    it('con una violación queda en borrador y el admin recibe el aviso con el motivo', async () => {
      const t = armar([fila()]);
      t.lifecycle.confirmar.mockRejectedValueOnce(
        noConfirmable([
          { code: 'car_missing', message: 'La hoja no tiene vehículo' },
          {
            code: 'capacity_units',
            message: 'La carga llega a 30 garrafas y el vehículo admite 20',
          },
        ]),
      );
      await expect(
        t.svc.confirmarLasVencidas(despues(60)),
      ).resolves.toMatchObject({ autoConfirmed: 0, autoConfirmFailed: 1 });
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(DIST, {
        kind: 'route_sheet_auto_confirm_failed',
        title: 'Hoja de ruta sin confirmar',
        body: 'La hoja de Juan Pérez de mañana no se confirmó sola: La hoja no tiene vehículo; La carga llega a 30 garrafas y el vehículo admite 20. Corregila y confirmala desde la hoja de ruta.',
        dedupeKey: 'route-sheet-auto-confirm-failed:hoja-1:4',
      });
    });

    it('el aviso nombra la hoja por su número si ya tenía uno', async () => {
      const t = armar([fila({ number: 12, editedAt: PROPUESTA })]);
      t.lifecycle.confirmar.mockRejectedValueOnce(
        noConfirmable([
          { code: 'no_stops', message: 'La hoja no tiene paradas' },
        ]),
      );
      await t.svc.confirmarLasVencidas(despues(60));
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(
        DIST,
        expect.objectContaining({
          body: expect.stringMatching(
            /^La hoja N° 12 de mañana no se confirmó sola: La hoja no tiene paradas\./,
          ) as string,
        }),
      );
    });

    it('si el admin la está editando (otra versión o el cerrojo de la hoja) no la pisa: va en la pasada siguiente, sin aviso', async () => {
      const t = armar([fila({ batchId: 'a' }), fila({ batchId: 'b' })]);
      t.lifecycle.confirmar
        .mockRejectedValueOnce(versionVieja())
        .mockRejectedValueOnce(hojaOcupada());
      await expect(t.svc.confirmarLasVencidas(despues(60))).resolves.toEqual({
        autoConfirmed: 0,
        autoConfirmFailed: 0,
        autoConfirmRetry: 2,
      });
      expect(t.notifier.aLaBandeja).not.toHaveBeenCalled();
      // En la pasada siguiente lo vuelve a intentar con la versión nueva.
      t.ds.query.mockResolvedValueOnce([fila({ batchId: 'a', version: 5 })]);
      await expect(
        t.svc.confirmarLasVencidas(despues(61)),
      ).resolves.toMatchObject({ autoConfirmed: 1 });
      expect(t.lifecycle.confirmar).toHaveBeenLastCalledWith(
        DIST,
        'a',
        { version: 5 },
        null,
      );
    });

    it('un deadlock (40P01) con otra operación se reintenta en la pasada siguiente: sin abortar la pasada, sin aviso y sin falla en la corrida', async () => {
      const t = armar([fila({ batchId: 'a' }), fila({ batchId: 'b' })]);
      const deadlock = new QueryFailedError(
        'UPDATE "route_batch_stop" …',
        [],
        Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      );
      t.lifecycle.confirmar
        .mockRejectedValueOnce(deadlock)
        .mockResolvedValueOnce(undefined);
      const estado = nuevaCorrida();
      const r = await dentroDeCorrida(estado, () =>
        t.svc.confirmarLasVencidas(despues(60)),
      );
      expect(r).toEqual({
        autoConfirmed: 1,
        autoConfirmFailed: 0,
        autoConfirmRetry: 1,
      });
      expect(t.notifier.aLaBandeja).not.toHaveBeenCalled();
      expect(estado.errors).toBe(0);
      // La pasada siguiente la vuelve a intentar.
      t.ds.query.mockResolvedValueOnce([fila({ batchId: 'a' })]);
      await expect(
        t.svc.confirmarLasVencidas(despues(61)),
      ).resolves.toMatchObject({ autoConfirmed: 1 });
      expect(t.lifecycle.confirmar).toHaveBeenLastCalledWith(
        DIST,
        'a',
        { version: 4 },
        null,
      );
    });

    it('una que dejó de ser borrador en el medio se saltea; un error inesperado no frena a las demás', async () => {
      const t = armar([
        fila({ batchId: 'a' }),
        fila({ batchId: 'b' }),
        fila({ batchId: 'c' }),
      ]);
      t.lifecycle.confirmar
        .mockRejectedValueOnce(hojaNoEditable())
        .mockRejectedValueOnce(new Error('sin conexión'))
        .mockResolvedValueOnce(undefined);
      await expect(t.svc.confirmarLasVencidas(despues(60))).resolves.toEqual({
        autoConfirmed: 1,
        autoConfirmFailed: 0,
        autoConfirmRetry: 0,
      });
      expect(t.notifier.aLaBandeja).not.toHaveBeenCalled();
    });

    it('si fallan los parámetros de una distribuidora, la otra igual se confirma y la corrida queda parcial', async () => {
      const t = armar([
        fila({ batchId: 'a', distributorId: 'rota' }),
        fila({ batchId: 'a2', distributorId: 'rota' }),
        fila({ batchId: 'b', distributorId: DIST }),
      ]);
      t.processConfig.obtener.mockImplementation((d: string) =>
        d === 'rota'
          ? Promise.reject(new Error('sin conexión'))
          : Promise.resolve({ enabled: 1, autoConfirm: 1, reviewMinutes: 60 }),
      );
      const estado = nuevaCorrida();
      const r = await dentroDeCorrida(estado, () =>
        t.svc.confirmarLasVencidas(despues(60)),
      );
      expect(r).toEqual({
        autoConfirmed: 1,
        autoConfirmFailed: 0,
        autoConfirmRetry: 0,
      });
      expect(t.lifecycle.confirmar).toHaveBeenCalledTimes(1);
      expect(t.lifecycle.confirmar).toHaveBeenCalledWith(
        DIST,
        'b',
        { version: 4 },
        null,
      );
      // Una sola lectura fallida por distribuidora, no una por hoja.
      expect(t.processConfig.obtener).toHaveBeenCalledTimes(2);
      expect(resolverCierre(r, estado)).toMatchObject({
        status: ProcessRunStatus.PARTIAL,
        counters: expect.objectContaining({ errors: 1 }) as unknown,
      });
    });

    it('lee los parámetros una vez por distribuidora y busca borradores de días propuestos de hoy en adelante', async () => {
      const t = armar([fila({ batchId: 'a' }), fila({ batchId: 'b' })]);
      await t.svc.confirmarLasVencidas(despues(60));
      expect(t.processConfig.obtener).toHaveBeenCalledTimes(1);
      const [sql, params] = t.ds.query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['2026-11-13']);
      expect(sql).toContain(`b."status" = 'draft'`);
      expect(sql).toContain(`p."status" = 'proposed'`);
      expect(sql).toContain(`b."plan_date" >= $1::date`);
      expect(sql).toContain(`d."status"::text = 'active'`);
    });
  });

  describe('avisarSinHojaPosible', () => {
    it('avisa en la bandeja los pedidos que quedaron sin hoja por falta de choferes y vehículos', () => {
      const t = armar([]);
      expect(
        t.svc.avisarSinHojaPosible(
          DIST,
          MANANA,
          [
            { orderId: 'o1', reason: 'no_vehicles' },
            { orderId: 'o2', reason: 'no_vehicles' },
            { orderId: 'o3', reason: 'window' },
          ],
          PROPUESTA,
        ),
      ).toBe(true);
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(DIST, {
        kind: 'route_plan_no_vehicles',
        title: 'Pedidos sin hoja de ruta',
        body: 'Para mañana (sábado 14/11), 2 pedidos quedaron sin hoja de ruta porque no hay choferes y vehículos disponibles ese día. Si no armás una hoja, pasan al despacho común cuando empiece el día.',
        dedupeKey: `route-plan-no-vehicles:${DIST}:${MANANA}`,
      });
    });

    it('sin pedidos sin flota no avisa', () => {
      const t = armar([]);
      expect(
        t.svc.avisarSinHojaPosible(
          DIST,
          MANANA,
          [{ orderId: 'o3', reason: 'capacity' }],
          PROPUESTA,
        ),
      ).toBe(false);
      expect(t.notifier.aLaBandeja).not.toHaveBeenCalled();
    });
  });
});
