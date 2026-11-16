import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import { RedisService } from '../../redis/redis.service';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { instanteDelDia } from '../domain/route-sheet-rules';
import {
  RECALCULO_POR_RELOJ_MS,
  RouteSheetEtaService,
} from './route-sheet-eta.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import {
  CalculoEnCurso,
  RouteSheetProgress,
} from './route-sheet-progress.service';
import { hojaOcupada } from './route-sheet.exceptions';
import { DIA, DIST, hoja } from './route-sheet.fixtures';

const AHORA = instanteDelDia(DIA, '10:00');
const SLOT = {
  slotStartMs: instanteDelDia(DIA, '08:00'),
  slotEndMs: instanteDelDia(DIA, '12:00'),
};
const PARAMS = {
  etaWindowMinutes: 30,
  etaNotifyShiftMinutes: 15,
  etaRecalcMinSeconds: 120,
  etaRecalcMinMeters: 300,
};

const calculo = (
  etas: CalculoEnCurso['etas'] = [
    { orderId: 'o1', etaMs: AHORA + 30 * 60_000, late: false, ...SLOT },
  ],
): CalculoEnCurso => ({
  recorrido: { hechas: [], enCamino: null, pendientes: ['o1'] },
  cola: ['o1'],
  etas,
  origen: 'gps',
});

function armar(
  o: {
    sheet?: RouteBatch;
    redis?: Record<string, string>;
    notificados?: Array<Record<string, unknown>>;
    hojaDelChofer?: Array<{ sheetId: string; distributorId: string }>;
    enCurso?: Array<{ batchId: string; distributorId: string }>;
    conHojas?: jest.Mock;
    horarios?: Array<Record<string, unknown>>;
    /** Pedidos cuya franja de horario ya se avisó (o que ya no están vigentes): el UPDATE no los reclama. */
    yaAvisados?: string[];
  } = {},
) {
  const sheet = o.sheet ?? hoja({ status: RouteBatchStatus.ASSIGNED });
  const kv: Record<string, string> = { ...(o.redis ?? {}) };
  const redis = {
    get: jest.fn((k: string) => Promise.resolve(kv[k] ?? null)),
    setex: jest.fn((k: string, _t: number, v: string) => {
      kv[k] = v;
      return Promise.resolve();
    }),
    del: jest.fn((k: string) => {
      delete kv[k];
      return Promise.resolve();
    }),
  };
  let avisoReclamado = false;
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.includes('"planned_eta_at" AS "eta"')) {
      return Promise.resolve(o.horarios ?? []);
    }
    if (sql.includes('IS DISTINCT FROM $3')) {
      const id = params[1] as string;
      return Promise.resolve(
        (o.yaAvisados ?? []).includes(id) ? [] : [{ orderId: id }],
      );
    }
    if (sql.includes('FROM "delivery" WHERE')) {
      return Promise.resolve([{ userId: 'u-chofer' }]);
    }
    if (sql.includes('notified_window_start')) {
      if (sql.startsWith('UPDATE')) {
        if (avisoReclamado) return Promise.resolve([]);
        avisoReclamado = true;
        return Promise.resolve([{ orderId: 'o1' }]);
      }
      return Promise.resolve(
        o.notificados ?? [
          { orderId: 'o1', customerId: 'c1', ws: null, we: null, at: null },
        ],
      );
    }
    if (sql.includes('SELECT "order_id" AS "orderId", "customer_id"')) {
      return Promise.resolve([{ orderId: 'o1', customerId: 'c1' }]);
    }
    if (sql.includes('ORDER BY b."started_at"')) {
      return Promise.resolve(o.hojaDelChofer ?? []);
    }
    if (sql.includes(`"status" = 'assigned'`)) {
      return Promise.resolve(o.enCurso ?? []);
    }
    return Promise.resolve([]);
  });
  const ds = { query, manager: {} };
  const locks = {
    conHojas:
      o.conHojas ??
      jest.fn(
        (
          _d: string,
          _p: unknown,
          fn: (m: EntityManager, h: RouteBatch[]) => unknown,
        ) => fn({} as EntityManager, [sheet]),
      ),
  };
  const progress = {
    posicionDelChofer: jest.fn().mockResolvedValue({ lat: -27.4, lng: -55.9 }),
    rehacer: jest.fn().mockResolvedValue(calculo()),
  };
  const processConfig = { obtener: jest.fn().mockResolvedValue(PARAMS) };
  const notifier = {
    alPanel: jest.fn(),
    salidaAlCliente: jest.fn().mockResolvedValue(undefined),
    franjaAlCliente: jest.fn().mockResolvedValue(undefined),
    postergadoAlCliente: jest.fn().mockResolvedValue(undefined),
    horarioAlCliente: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new RouteSheetEtaService(
    ds as unknown as DataSource,
    locks as unknown as RouteSheetLocks,
    progress as unknown as RouteSheetProgress,
    processConfig as unknown as ProcessConfigService,
    redis as unknown as RedisService,
    notifier as unknown as RouteSheetNotifier,
  );
  return { svc, redis, kv, query, locks, progress, notifier };
}

describe('RouteSheetEtaService', () => {
  describe('recalcular', () => {
    it('recalcula con la posición del chofer, avisa al panel y anota el recálculo', async () => {
      const { svc, progress, notifier, kv } = armar();
      const r = await svc.recalcular(DIST, 'hoja-1', {
        reordenar: true,
        nowMs: AHORA,
      });
      expect(r?.cola).toEqual(['o1']);
      expect(progress.posicionDelChofer).toHaveBeenCalledWith(
        'u-chofer',
        AHORA,
      );
      expect(progress.rehacer).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { reordenar: true, nowMs: AHORA, posicion: { lat: -27.4, lng: -55.9 } },
      );
      expect(notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:eta-updated',
        expect.objectContaining({ sheetId: 'hoja-1', source: 'gps' }),
      );
      expect(JSON.parse(kv['route-sheet:eta:last:hoja-1'])).toMatchObject({
        atMs: AHORA,
      });
    });

    it('una hoja que ya no está en curso no se toca', async () => {
      const { svc, progress } = armar({
        sheet: hoja({ status: RouteBatchStatus.COMPLETED }),
      });
      expect(
        await svc.recalcular(DIST, 'hoja-1', { reordenar: false }),
      ).toBeNull();
      expect(progress.rehacer).not.toHaveBeenCalled();
    });

    it('sin chofer en la hoja, sin posición', async () => {
      const { svc, progress } = armar({
        sheet: hoja({ status: RouteBatchStatus.ASSIGNED, deliveryId: null }),
      });
      await svc.recalcular(DIST, 'hoja-1', { reordenar: false, nowMs: AHORA });
      expect(progress.posicionDelChofer).not.toHaveBeenCalled();
      expect(progress.rehacer).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ posicion: null }),
      );
    });

    it('la hoja tomada por otra operación: null (la próxima posición la recalcula); otro error se propaga', async () => {
      const ocupada = armar({
        conHojas: jest.fn().mockRejectedValue(hojaOcupada()),
      });
      expect(
        await ocupada.svc.recalcular(DIST, 'hoja-1', { reordenar: false }),
      ).toBeNull();
      const rota = armar({
        conHojas: jest.fn().mockRejectedValue(new ConflictException('otra')),
      });
      await expect(
        rota.svc.recalcular(DIST, 'hoja-1', { reordenar: false }),
      ).rejects.toThrow('otra');
    });
  });

  describe('avisar', () => {
    it('el primer aviso sale siempre: guarda la franja avisada y le avisa al cliente', async () => {
      const { svc, query, notifier } = armar();
      await svc.avisar(DIST, 'hoja-1', calculo(), AHORA, 'u-chofer');
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('IS NOT DISTINCT FROM'),
        expect.arrayContaining(['hoja-1', 'o1', new Date(AHORA)]),
      );
      expect(notifier.franjaAlCliente).toHaveBeenCalledWith(
        'c1',
        'o1',
        expect.objectContaining({ etaMs: AHORA + 30 * 60_000 }),
        true,
      );
    });

    it('el postergado (primer intento fallido): siempre «más tarde» con su franja nueva, que queda como la avisada; no el aviso de corrimiento', async () => {
      // Ya se le había avisado hace 2 minutos (el corrimiento no avisaría).
      const { svc, query, notifier } = armar({
        notificados: [
          {
            orderId: 'o1',
            customerId: 'c1',
            ws: new Date(AHORA),
            we: new Date(AHORA + 60 * 60_000),
            at: new Date(AHORA - 2 * 60_000),
          },
        ],
      });
      const r = await svc.avisar(DIST, 'hoja-1', calculo(), AHORA, null, {
        postergado: 'o1',
      });
      const franja = {
        windowStartMs: AHORA,
        windowEndMs: AHORA + 60 * 60_000,
        etaMs: AHORA + 30 * 60_000,
      };
      expect(r).toEqual(franja);
      expect(notifier.postergadoAlCliente).toHaveBeenCalledWith(
        'c1',
        'o1',
        franja,
      );
      expect(notifier.franjaAlCliente).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('SET "notified_window_start" = $3'),
        [
          'hoja-1',
          'o1',
          new Date(franja.windowStartMs),
          new Date(franja.windowEndMs),
          new Date(AHORA),
        ],
      );
    });

    it('sin postergado (o sin hora estimada) no devuelve franja; un push del postergado que falla no corta', async () => {
      const { svc, notifier } = armar();
      expect(
        await svc.avisar(DIST, 'hoja-1', calculo(), AHORA, null),
      ).toBeNull();
      expect(
        await svc.avisar(DIST, 'hoja-1', calculo([]), AHORA, null, {
          postergado: 'o1',
        }),
      ).toBeNull();
      notifier.postergadoAlCliente.mockRejectedValue(new Error('fcm'));
      const t = armar();
      t.notifier.postergadoAlCliente.mockRejectedValue(new Error('fcm'));
      await expect(
        t.svc.avisar(DIST, 'hoja-1', calculo(), AHORA, null, {
          postergado: 'o1',
        }),
      ).resolves.toMatchObject({ etaMs: AHORA + 30 * 60_000 });
    });

    it('dos recálculos concurrentes reclaman la misma franja una sola vez y mandan un único push', async () => {
      const { svc, notifier } = armar();
      await Promise.all([
        svc.avisar(DIST, 'hoja-1', calculo(), AHORA, null),
        svc.avisar(DIST, 'hoja-1', calculo(), AHORA, null),
      ]);
      expect(notifier.franjaAlCliente).toHaveBeenCalledTimes(1);
    });

    it('si la franja apenas se movió o se avisó hace poco, no avisa', async () => {
      const ventana = {
        ws: new Date(AHORA + 0),
        we: new Date(AHORA + 60 * 60_000),
      };
      const { svc, notifier } = armar({
        notificados: [
          {
            orderId: 'o1',
            customerId: 'c1',
            ...ventana,
            at: new Date(AHORA - 2 * 60_000),
          },
        ],
      });
      await svc.avisar(DIST, 'hoja-1', calculo(), AHORA, null);
      expect(notifier.franjaAlCliente).not.toHaveBeenCalled();
    });

    it('si la hora se fue de la franja comprada, avisa al cliente y al panel (stop-late)', async () => {
      const { svc, notifier } = armar({
        notificados: [
          {
            orderId: 'o1',
            customerId: 'c1',
            ws: new Date(SLOT.slotStartMs),
            we: new Date(SLOT.slotStartMs + 60 * 60_000),
            at: new Date(AHORA - 60 * 60_000),
          },
        ],
      });
      const tarde = calculo([
        {
          orderId: 'o1',
          etaMs: SLOT.slotEndMs + 20 * 60_000,
          late: true,
          ...SLOT,
        },
      ]);
      await svc.avisar(DIST, 'hoja-1', tarde, AHORA, null);
      expect(notifier.franjaAlCliente).toHaveBeenCalled();
      expect(notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:stop-late',
        expect.objectContaining({ orderId: 'o1' }),
      );
    });

    it('sin paradas pendientes sólo avisa al panel; una parada que ya no está, se saltea', async () => {
      const vacia = armar();
      await vacia.svc.avisar(DIST, 'hoja-1', calculo([]), AHORA, null);
      expect(vacia.notifier.alPanel).toHaveBeenCalledTimes(1);
      expect(vacia.notifier.franjaAlCliente).not.toHaveBeenCalled();
      const sinFila = armar({ notificados: [] });
      await sinFila.svc.avisar(DIST, 'hoja-1', calculo(), AHORA, null);
      expect(sinFila.notifier.franjaAlCliente).not.toHaveBeenCalled();
    });
  });

  describe('onPosition', () => {
    const pos = { userId: 'u-chofer', lat: -27.4, lng: -55.9 };

    it('sin hoja en curso no hace nada (y lo recuerda un rato)', async () => {
      const { svc, kv, progress, query } = armar();
      await svc.onPosition(pos);
      expect(kv['route-sheet:eta:driver:u-chofer']).toBe('-');
      await svc.onPosition(pos);
      expect(
        query.mock.calls.filter((c) =>
          String(c[0]).includes('ORDER BY b."started_at"'),
        ),
      ).toHaveLength(1);
      expect(progress.rehacer).not.toHaveBeenCalled();
    });

    it('con hoja en curso: recalcula la primera vez y no de nuevo dentro del mínimo', async () => {
      const { svc, progress } = armar({
        hojaDelChofer: [{ sheetId: 'hoja-1', distributorId: DIST }],
      });
      await svc.onPosition(pos);
      expect(progress.rehacer).toHaveBeenCalledTimes(1);
      await svc.onPosition(pos);
      expect(progress.rehacer).toHaveBeenCalledTimes(1);
    });

    it('usa la hoja recordada sin ir a la base', async () => {
      const { svc, query, progress } = armar({
        redis: {
          'route-sheet:eta:driver:u-chofer': JSON.stringify({
            sheetId: 'hoja-1',
            distributorId: DIST,
          }),
        },
      });
      await svc.onPosition(pos);
      expect(
        query.mock.calls.some((c) =>
          String(c[0]).includes('ORDER BY b."started_at"'),
        ),
      ).toBe(false);
      expect(progress.rehacer).toHaveBeenCalled();
    });

    it('nunca lanza (Redis o la base caídos degradan sin cortar el seguimiento)', async () => {
      const { svc, redis, query } = armar();
      redis.get.mockRejectedValue(new Error('redis'));
      redis.setex.mockRejectedValue(new Error('redis'));
      query.mockRejectedValue(new Error('base'));
      await expect(svc.onPosition(pos)).resolves.toBeUndefined();
    });
  });

  describe('porReloj', () => {
    it('recalcula las hojas en curso que hace rato no se recalculan', async () => {
      const { svc, progress } = armar({
        enCurso: [
          { batchId: 'hoja-1', distributorId: DIST },
          { batchId: 'hoja-2', distributorId: DIST },
        ],
        redis: {
          'route-sheet:eta:last:hoja-2': JSON.stringify({
            atMs: AHORA - 1000,
            lat: 0,
            lng: 0,
          }),
        },
      });
      expect(await svc.porReloj(AHORA)).toBe(1);
      expect(progress.rehacer).toHaveBeenCalledTimes(1);
      expect(await svc.porReloj(AHORA + RECALCULO_POR_RELOJ_MS + 1)).toBe(2);
    });

    it('una hoja que falla no frena a las demás; una que ya no está en curso no cuenta', async () => {
      const { svc, progress } = armar({
        enCurso: [
          { batchId: 'hoja-1', distributorId: DIST },
          { batchId: 'hoja-2', distributorId: DIST },
        ],
      });
      progress.rehacer
        .mockRejectedValueOnce(new Error('osrm'))
        .mockResolvedValueOnce(calculo());
      expect(await svc.porReloj(AHORA)).toBe(1);
      const cerrada = armar({
        sheet: hoja({ status: RouteBatchStatus.COMPLETED }),
        enCurso: [{ batchId: 'hoja-1', distributorId: DIST }],
      });
      expect(await cerrada.svc.porReloj(AHORA)).toBe(0);
    });
  });

  it('olvidarChofer borra lo recordado; sin usuario no hace nada', async () => {
    const { svc, redis } = armar({
      redis: { 'route-sheet:eta:driver:u1': '-' },
    });
    await svc.olvidarChofer(null);
    expect(redis.del).not.toHaveBeenCalled();
    await svc.olvidarChofer('u1');
    expect(redis.del).toHaveBeenCalledWith('route-sheet:eta:driver:u1');
    redis.del.mockRejectedValueOnce(new Error('redis'));
    await expect(svc.olvidarChofer('u1')).resolves.toBeUndefined();
  });

  it('Redis caído: no se recuerda nada pero el recálculo y los avisos siguen', async () => {
    const { svc, redis, notifier } = armar({
      hojaDelChofer: [{ sheetId: 'hoja-1', distributorId: DIST }],
    });
    redis.get.mockRejectedValue(new Error('redis'));
    redis.setex.mockRejectedValue(new Error('redis'));
    expect(await svc.recienRecalculada('hoja-1', AHORA)).toBe(false);
    await svc.onPosition({ userId: 'u-chofer', lat: 1, lng: 2 });
    expect(notifier.alPanel).toHaveBeenCalledWith(
      DIST,
      'route-sheet:eta-updated',
      expect.anything(),
    );
  });

  it('recienRecalculada mira el último recálculo', async () => {
    const { svc } = armar({
      redis: {
        'route-sheet:eta:last:hoja-1': JSON.stringify({
          atMs: AHORA,
          lat: 0,
          lng: 0,
        }),
      },
    });
    expect(await svc.recienRecalculada('hoja-1', AHORA + 1000)).toBe(true);
    expect(await svc.recienRecalculada('hoja-1', AHORA + 6000)).toBe(false);
    expect(await svc.recienRecalculada('otra', AHORA)).toBe(false);
  });

  describe('avisarHorarioSinFranja (al confirmar)', () => {
    it('a los pedidos sin franja fija: la hora prometida ± etaWindowMinutes, con el día', async () => {
      const eta = new Date(instanteDelDia('2026-11-16', '11:00'));
      const { svc, query, notifier } = armar({
        horarios: [
          { orderId: 'o1', customerId: 'c1', fecha: '2026-11-16', eta },
        ],
      });
      expect(await svc.avisarHorarioSinFranja(DIST, 'hoja-1')).toBe(1);
      const [sql, params] = query.mock.calls[0] as unknown as [
        string,
        unknown[],
      ];
      expect(sql).toContain('o."time_slot_id" IS NULL');
      expect(sql).toContain(
        `o."status"::text NOT IN ('cancelled', 'delivered')`,
      );
      expect(sql).toContain('b."distributor_id" = $2');
      expect(params).toEqual(['hoja-1', DIST]);
      expect(notifier.horarioAlCliente).toHaveBeenCalledWith(
        'c1',
        'o1',
        '2026-11-16',
        {
          windowStartMs: eta.getTime() - 30 * 60_000,
          windowEndMs: eta.getTime() + 30 * 60_000,
          etaMs: eta.getTime(),
        },
      );
    });

    it('una franja ya avisada (reconfirmación con la misma hora) o un pedido que dejó de estar vigente no se avisa: el reclamo persistente lo filtra', async () => {
      const eta = new Date(AHORA);
      const t = armar({
        horarios: [
          { orderId: 'o1', customerId: 'c1', fecha: DIA, eta },
          { orderId: 'o2', customerId: 'c2', fecha: DIA, eta },
        ],
        yaAvisados: ['o1'],
      });
      expect(await t.svc.avisarHorarioSinFranja(DIST, 'hoja-1')).toBe(1);
      expect(t.notifier.horarioAlCliente).toHaveBeenCalledTimes(1);
      expect(t.notifier.horarioAlCliente).toHaveBeenCalledWith(
        'c2',
        'o2',
        DIA,
        expect.anything(),
      );
      const reclamo = (t.query.mock.calls as unknown[][]).find((c) =>
        String(c[0]).includes('IS DISTINCT FROM $3'),
      ) as [string, unknown[]];
      expect(reclamo[0]).toContain(
        `o."status"::text NOT IN ('cancelled', 'delivered')`,
      );
      expect(reclamo[1].slice(0, 4)).toEqual([
        'hoja-1',
        'o1',
        new Date(AHORA - 30 * 60_000),
        new Date(AHORA + 30 * 60_000),
      ]);
    });

    it('sin pedidos sin franja no avisa; un push que falla no corta a los demás', async () => {
      const vacio = armar();
      expect(await vacio.svc.avisarHorarioSinFranja(DIST, 'hoja-1')).toBe(0);
      expect(vacio.notifier.horarioAlCliente).not.toHaveBeenCalled();
      const eta = new Date(AHORA);
      const t = armar({
        horarios: [
          { orderId: 'o1', customerId: 'c1', fecha: DIA, eta },
          { orderId: 'o2', customerId: 'c2', fecha: DIA, eta },
        ],
      });
      t.notifier.horarioAlCliente.mockRejectedValueOnce(new Error('fcm'));
      expect(await t.svc.avisarHorarioSinFranja(DIST, 'hoja-1')).toBe(1);
      expect(t.notifier.horarioAlCliente).toHaveBeenCalledTimes(2);
    });
  });

  describe('avisarSalida (Iniciar viaje)', () => {
    it('a todos los clientes: franja estimada guardada como avisada y push de «en camino», aunque ya se hubiera avisado antes', async () => {
      const t = armar({
        redis: {
          'route-sheet:eta:last:hoja-1': JSON.stringify({
            atMs: AHORA,
            lat: 0,
            lng: 0,
          }),
        },
      });
      const n = await t.svc.avisarSalida(
        DIST,
        'hoja-1',
        calculo(),
        AHORA,
        'u-chofer',
      );
      expect(n).toBe(1);
      const [sql, params] = t.query.mock.calls.find((c) =>
        String(c[0]).includes('SET "notified_window_start" = $3'),
      ) as unknown as [string, unknown[]];
      expect(sql).toContain('"active"');
      expect(params[0]).toBe('hoja-1');
      expect(params[1]).toBe('o1');
      expect(params[4]).toEqual(new Date(AHORA));
      expect(t.notifier.salidaAlCliente).toHaveBeenCalledWith(
        'c1',
        'o1',
        expect.objectContaining({ etaMs: AHORA + 30 * 60_000 }),
      );
      expect(t.notifier.alPanel).toHaveBeenCalledWith(
        DIST,
        'route-sheet:eta-updated',
        expect.objectContaining({ sheetId: 'hoja-1' }),
      );
    });

    it('sin paradas, o un pedido sin cliente visible, no avisa', async () => {
      const t = armar();
      expect(
        await t.svc.avisarSalida(DIST, 'hoja-1', calculo([]), AHORA, null),
      ).toBe(0);
      const otro = calculo([
        { orderId: 'o9', etaMs: AHORA, late: false, ...SLOT },
      ]);
      expect(await t.svc.avisarSalida(DIST, 'hoja-1', otro, AHORA, null)).toBe(
        0,
      );
      expect(t.notifier.salidaAlCliente).not.toHaveBeenCalled();
    });
  });

  it('la posición del chofer va al panel durante toda la hoja en curso, al ritmo del recálculo', async () => {
    const { svc, notifier } = armar({
      hojaDelChofer: [{ sheetId: 'hoja-1', distributorId: DIST }],
    });
    await svc.onPosition({ userId: 'u-chofer', lat: -27.4, lng: -55.9 });
    expect(notifier.alPanel).toHaveBeenCalledWith(
      DIST,
      'route-sheet:driver-location',
      expect.objectContaining({
        sheetId: 'hoja-1',
        driverUserId: 'u-chofer',
        lat: -27.4,
        lng: -55.9,
      }),
    );
    notifier.alPanel.mockClear();
    // Dentro del mínimo entre recálculos, ni recálculo ni posición al panel.
    await svc.onPosition({ userId: 'u-chofer', lat: -27.4, lng: -55.9 });
    expect(notifier.alPanel).not.toHaveBeenCalledWith(
      DIST,
      'route-sheet:driver-location',
      expect.anything(),
    );
  });
});
