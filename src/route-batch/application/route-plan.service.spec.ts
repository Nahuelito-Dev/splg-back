import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ProcessConfigService } from '../../distributor/process-config.service';
import {
  RoutePlan,
  RoutePlanStatus,
} from '../../order/entities/route-plan.entity';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { RoutePlanService } from './route-plan.service';
import { RouteSheetLifecycleService } from './route-sheet-lifecycle.service';
import { noConfirmable, versionVieja } from './route-sheet.exceptions';
import { DIA, DIST, hoja, plan } from './route-sheet.fixtures';
import {
  CALENDARIO_POR_OMISION,
  diasDeLaMascara,
} from '../domain/calendario-laboral';
import { RoutePlanningCalendarService } from './route-planning-calendar.service';

function armar() {
  const insert = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };
  const plans = {
    findOne: jest.fn().mockResolvedValue(null),
    findOneOrFail: jest.fn().mockResolvedValue(plan()),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => insert),
  };
  const manager = {
    findOne: jest.fn().mockResolvedValue(plan()),
    find: jest.fn().mockResolvedValue([]),
    query: jest.fn().mockResolvedValue([]),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
  };
  const borradores = { find: jest.fn().mockResolvedValue([]) };
  const ds = {
    transaction: jest.fn((fn: (m: EntityManager) => unknown) =>
      fn(manager as unknown as EntityManager),
    ),
    getRepository: jest.fn(() => borradores),
    query: jest.fn().mockResolvedValue([]),
  };
  const processConfig = {
    obtener: jest.fn().mockResolvedValue({
      cutoffHour: 18,
      cutoffMinute: 30,
      enabled: 1,
      autoPropose: 1,
    }),
  };
  const lifecycle = { confirmar: jest.fn().mockResolvedValue(undefined) };
  const calendario = {
    calendario: jest.fn().mockResolvedValue(CALENDARIO_POR_OMISION),
  };
  const svc = new RoutePlanService(
    ds as unknown as DataSource,
    plans as unknown as Repository<RoutePlan>,
    processConfig as unknown as ProcessConfigService,
    lifecycle as unknown as RouteSheetLifecycleService,
    calendario as unknown as RoutePlanningCalendarService,
  );
  return {
    svc,
    plans,
    insert,
    manager,
    ds,
    borradores,
    lifecycle,
    processConfig,
    calendario,
  };
}

describe('RoutePlanService', () => {
  describe('abrir', () => {
    it('si ya existe lo devuelve sin escribir (idempotente)', async () => {
      const { svc, plans } = armar();
      plans.findOne.mockResolvedValueOnce(
        plan({ status: RoutePlanStatus.PROPOSED }),
      );
      expect((await svc.abrir(DIST, DIA, '2026-11-13')).status).toBe(
        'proposed',
      );
      expect(plans.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('un día pasado es 409 ROUTE_PLAN_DATE_PAST', async () => {
      const { svc } = armar();
      await expect(
        svc.abrir(DIST, '2026-11-12', '2026-11-13'),
      ).rejects.toMatchObject({
        response: { code: 'ROUTE_PLAN_DATE_PAST' },
      });
    });

    it('lo crea abierto con el cierre el día anterior a la hora del parámetro; una carrera no duplica (orIgnore)', async () => {
      const { svc, insert, plans } = armar();
      await svc.abrir(DIST, DIA, DIA);
      const valores = (insert.values.mock.calls as unknown[][])[0][0] as {
        status: string;
        cutoffAt: Date;
      };
      expect(valores.status).toBe('open');
      // 13/11 18:30 en Argentina = 21:30 UTC.
      expect(valores.cutoffAt.toISOString()).toBe('2026-11-13T21:30:00.000Z');
      expect(insert.orIgnore).toHaveBeenCalled();
      expect(plans.findOneOrFail).toHaveBeenCalledWith({
        where: { distributorId: DIST, planDate: DIA },
      });
    });

    it('abrirParaEditar: 409 ROUTE_PLAN_CLOSED si el día ya se cerró', async () => {
      const { svc, plans } = armar();
      plans.findOne.mockResolvedValueOnce(
        plan({ status: RoutePlanStatus.CLOSED }),
      );
      await expect(svc.abrirParaEditar(DIST, DIA)).rejects.toMatchObject({
        response: { code: 'ROUTE_PLAN_CLOSED' },
      });
      plans.findOne.mockResolvedValueOnce(plan());
      await expect(svc.abrirParaEditar(DIST, DIA)).resolves.toMatchObject({
        status: 'open',
      });
    });
  });

  describe('enElDia', () => {
    it('corre con el día bloqueado para compartir; 404 sin día y 409 cerrado', async () => {
      const { svc, manager } = armar();
      await expect(
        svc.enElDia(DIST, DIA, () => Promise.resolve('ok')),
      ).resolves.toBe('ok');
      expect((manager.findOne.mock.calls as unknown[][])[0][1]).toMatchObject({
        lock: { mode: 'pessimistic_read' },
      });
      manager.findOne.mockResolvedValueOnce(null);
      await expect(svc.enElDia(DIST, DIA, jest.fn())).rejects.toMatchObject({
        response: { code: 'ROUTE_PLAN_NOT_FOUND' },
      });
      manager.findOne.mockResolvedValueOnce(
        plan({ status: RoutePlanStatus.CLOSED }),
      );
      await expect(svc.enElDia(DIST, DIA, jest.fn())).rejects.toMatchObject({
        response: { code: 'ROUTE_PLAN_CLOSED' },
      });
    });
  });

  it('buscar: 404 si el día no se abrió', async () => {
    const { svc, plans } = armar();
    await expect(svc.buscar(DIST, DIA)).rejects.toMatchObject({
      response: { code: 'ROUTE_PLAN_NOT_FOUND' },
    });
    plans.findOne.mockResolvedValueOnce(plan());
    await expect(svc.buscar(DIST, DIA)).resolves.toMatchObject({
      planDate: DIA,
    });
  });

  describe('cerrar', () => {
    it('descarta los borradores (day_closed, paradas apagadas) y deja el día cerrado con quién lo cerró', async () => {
      const { svc, manager } = armar();
      const b = hoja({ batchId: 'b1' });
      manager.find.mockResolvedValueOnce([b]);
      const r = await svc.cerrar(DIST, DIA, 'u1');
      expect((manager.find.mock.calls as unknown[][])[0][1]).toMatchObject({
        where: { status: RouteBatchStatus.DRAFT, kind: 'planned' },
        lock: { mode: 'pessimistic_write' },
      });
      expect((manager.query.mock.calls as unknown[][])[0][1]).toEqual(['b1']);
      expect(b).toMatchObject({
        status: 'dissolved',
        closeReason: 'day_closed',
      });
      expect(b.closedAt).toBeInstanceOf(Date);
      expect(r).toMatchObject({ status: 'closed', closedByUserId: 'u1' });
    });

    it('404 sin día y 409 si ya estaba cerrado', async () => {
      const { svc, manager } = armar();
      manager.findOne.mockResolvedValueOnce(null);
      await expect(svc.cerrar(DIST, DIA, null)).rejects.toMatchObject({
        response: { code: 'ROUTE_PLAN_NOT_FOUND' },
      });
      manager.findOne.mockResolvedValueOnce(
        plan({ status: RoutePlanStatus.CLOSED }),
      );
      await expect(svc.cerrar(DIST, DIA, null)).rejects.toMatchObject({
        response: { code: 'ROUTE_PLAN_CLOSED' },
      });
    });
  });

  describe('confirmarTodas', () => {
    it('confirma cada borrador con su versión y junta los que no pudo con el motivo y las violaciones', async () => {
      const { svc, plans, borradores, lifecycle } = armar();
      plans.findOne.mockResolvedValue(plan());
      borradores.find.mockResolvedValueOnce([
        hoja({ batchId: 'ok', version: 2 }),
        hoja({ batchId: 'mal', version: 3 }),
        hoja({ batchId: 'vieja', version: 4 }),
      ]);
      const violaciones = [
        { code: 'no_stops' as const, message: 'La hoja no tiene paradas' },
      ];
      lifecycle.confirmar
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(noConfirmable(violaciones))
        .mockRejectedValueOnce(versionVieja());
      const r = await svc.confirmarTodas(DIST, DIA, 'u1');
      expect(lifecycle.confirmar).toHaveBeenNthCalledWith(
        1,
        DIST,
        'ok',
        { version: 2 },
        'u1',
      );
      expect(r.confirmed).toEqual(['ok']);
      expect(r.failed).toEqual([
        {
          sheetId: 'mal',
          message: 'No se puede confirmar la hoja: La hoja no tiene paradas',
          violations: violaciones,
        },
        {
          sheetId: 'vieja',
          message: expect.stringContaining('Otro administrador') as string,
          violations: [],
        },
      ]);
    });

    it('un error que no es HTTP se propaga; un HTTP con mensaje en arreglo usa el texto de la excepción', async () => {
      const { svc, plans, borradores, lifecycle } = armar();
      plans.findOne.mockResolvedValue(plan());
      borradores.find.mockResolvedValue([hoja()]);
      lifecycle.confirmar.mockRejectedValueOnce(
        new ConflictException(['a', 'b']),
      );
      const r = await svc.confirmarTodas(DIST, DIA, 'u1');
      expect(r.failed[0].message).toBe('Conflict Exception');
      lifecycle.confirmar.mockRejectedValueOnce(new Error('se cayó la base'));
      await expect(svc.confirmarTodas(DIST, DIA, 'u1')).rejects.toThrow(
        'se cayó la base',
      );
    });
  });

  describe('paraProponer', () => {
    // 13/11 a las 21:00 UTC = 18:00 en Argentina.
    const despuesDelCierre = new Date('2026-11-13T21:45:00Z');

    const activa = (
      distributorId: string,
      params: Record<string, unknown> | null = null,
      status = 'active',
    ) => ({ distributorId, status, deletedAt: null, params });

    it('sólo las distribuidoras cuyo cierre de mañana pasó y que no se propusieron ni cerraron', async () => {
      const { svc, ds, plans } = armar();
      ds.query.mockResolvedValueOnce([
        activa('sin-plan'),
        activa('abierta'),
        activa('propuesta'),
      ]);
      plans.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(plan({ status: RoutePlanStatus.OPEN }))
        .mockResolvedValueOnce(plan({ status: RoutePlanStatus.PROPOSED }));
      expect(await svc.paraProponer(despuesDelCierre)).toEqual([
        { distributorId: 'sin-plan', planDate: DIA },
        { distributorId: 'abierta', planDate: DIA },
      ]);
      // Recorre todas las distribuidoras, también las que nunca guardaron parámetros.
      const sql = (ds.query.mock.calls as unknown[][])[0][0] as string;
      expect(sql).toContain('FROM "distributor" d');
      expect(sql).toContain('LEFT JOIN "module_config" mc');
    });

    it('decide con el mismo predicado que la retención: sin parámetros propone; enabled 0, autoPropose 0 o suspendida no', async () => {
      const { svc, ds, plans } = armar();
      ds.query.mockResolvedValueOnce([
        activa('por-omision'),
        activa('apagada', { enabled: 0 }),
        activa('a-mano', { autoPropose: 0 }),
        activa('suspendida', null, 'suspended'),
      ]);
      expect(await svc.paraProponer(despuesDelCierre)).toEqual([
        { distributorId: 'por-omision', planDate: DIA },
      ]);
      expect(plans.findOne).toHaveBeenCalledTimes(1);
    });

    it('el cierre sale de los parámetros guardados (cierre 20:00: a las 18:45 todavía no)', async () => {
      const { svc, ds } = armar();
      ds.query.mockResolvedValueOnce([activa('d', { cutoffHour: 20 })]);
      expect(await svc.paraProponer(despuesDelCierre)).toEqual([]);
    });

    it('mañana feriado o día que no se reparte: no propone (el sábado 14/11)', async () => {
      const { svc, ds, plans, calendario } = armar();
      ds.query.mockResolvedValue([activa('d')]);
      calendario.calendario.mockResolvedValueOnce({
        diasHabiles: diasDeLaMascara(63),
        feriados: new Set([DIA]),
      });
      expect(await svc.paraProponer(despuesDelCierre)).toEqual([]);
      calendario.calendario.mockResolvedValueOnce({
        diasHabiles: diasDeLaMascara(31),
        feriados: new Set(),
      });
      expect(await svc.paraProponer(despuesDelCierre)).toEqual([]);
      expect(plans.findOne).not.toHaveBeenCalled();
      expect(calendario.calendario).toHaveBeenCalledWith('d', '2026-11-13');
    });

    it('antes del cierre no propone', async () => {
      const { svc, ds, plans } = armar();
      ds.query.mockResolvedValueOnce([activa('d')]);
      expect(await svc.paraProponer(new Date('2026-11-13T20:00:00Z'))).toEqual(
        [],
      );
      expect(plans.findOne).not.toHaveBeenCalled();
    });
  });

  describe('cerrarDiasVencidos', () => {
    it('cierra los días de hoy o anteriores; uno que otro proceso ya cerró no es error', async () => {
      const { svc, plans, manager } = armar();
      plans.find.mockResolvedValueOnce([
        plan({ planId: 'a' }),
        plan({ planId: 'b', distributorId: 'otra' }),
      ]);
      manager.findOne
        .mockResolvedValueOnce(plan())
        .mockResolvedValueOnce(plan({ status: RoutePlanStatus.CLOSED }));
      expect(
        await svc.cerrarDiasVencidos(new Date('2026-11-14T03:00:00Z')),
      ).toBe(1);
      const where = (
        (plans.find.mock.calls as unknown[][])[0][0] as {
          where: { planDate: { value: string } };
        }
      ).where;
      expect(where.planDate.value).toBe('2026-11-14');
    });

    it('un error que no es HTTP se propaga', async () => {
      const { svc, plans, ds } = armar();
      plans.find.mockResolvedValueOnce([plan()]);
      (ds.transaction as jest.Mock).mockRejectedValueOnce(
        new Error('sin conexión'),
      );
      await expect(svc.cerrarDiasVencidos(new Date())).rejects.toThrow(
        'sin conexión',
      );
    });
  });
});
