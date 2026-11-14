import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../common/events/notificar-admin.event';
import { ProcessHealth, ProcessName } from './domain/process-catalog';
import { ProcessRun } from './entities/process-run.entity';
import { ProcessRunService } from './process-run.service';
import { ProcessRunWatchCron } from './process-run-watch.cron';

const AHORA = new Date('2026-11-03T15:00:00Z'); // 12:00 en Argentina
// El monitoreo lleva dos días corriendo.
const DESDE = new Date('2026-11-01T15:00:00Z');

function armar(
  estados: Array<{
    proceso: ProcessName;
    distributorId: string | null;
    salud: ProcessHealth;
    error?: string;
  }>,
) {
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 2 }),
    select: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ desde: DESDE }),
  };
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    query: jest.fn().mockResolvedValue([[], 5]),
  };
  const service = {
    estados: jest.fn().mockResolvedValue(
      estados.map((e) => ({
        ...e,
        ultima: e.error ? { error: e.error } : null,
        ultimaBuena: null,
      })),
    ),
  };
  const distributors = {
    findAll: jest.fn().mockResolvedValue([
      {
        distributorId: 'd1',
        name: 'Empresa 1',
        status: DistributorStatus.ACTIVE,
      },
      {
        distributorId: 'd2',
        name: 'Empresa 2',
        status: DistributorStatus.ACTIVE,
      },
      {
        distributorId: 'd3',
        name: 'Empresa 3',
        status: DistributorStatus.SUSPENDED,
      },
      {
        distributorId: 'd4',
        name: 'Empresa 4',
        status: DistributorStatus.ACTIVE,
      },
    ]),
  };
  const events = { emit: jest.fn() };
  const config = { get: jest.fn((_k: string, d: number) => d) };
  const cron = new ProcessRunWatchCron(
    repo as unknown as Repository<ProcessRun>,
    service as unknown as ProcessRunService,
    distributors as unknown as DistributorService,
    events as unknown as EventEmitter2,
    config as unknown as ConfigService,
  );
  return { cron, repo, events, qb };
}

const eventoDe = (events: { emit: jest.Mock }) =>
  (events.emit.mock.calls[0] as [string, NotificarAdminEvent])[1];

const emitidos = (events: { emit: jest.Mock }) =>
  events.emit.mock.calls.map(([nombre, e]: [string, NotificarAdminEvent]) => [
    nombre,
    e.distributorId,
    e.dedupeKey,
  ]);

describe('ProcessRunWatchCron', () => {
  it('un proceso global con alerta avisa UNA vez a la bandeja de la plataforma, no a las empresas', async () => {
    const { cron, events } = armar([
      {
        proceso: ProcessName.REPURCHASE_ANTICIPATE,
        distributorId: null,
        salud: ProcessHealth.LATE,
        error: 'El proveedor no respondió',
      },
      {
        proceso: ProcessName.STOCK_LOW_ALERT,
        distributorId: null,
        salud: ProcessHealth.OK,
      },
    ]);
    const r = await cron.vigilar(AHORA);
    expect(r.alerts).toBe(1);
    expect(emitidos(events)).toEqual([
      [
        EVENTO_NOTIFICAR_ADMIN,
        null,
        'process-run:repurchase_anticipate:global:late:2026-11-03',
      ],
    ]);
    const evento = eventoDe(events);
    expect(evento.title).toBe(
      'Proceso automático: Recompra: invitaciones anticipadas',
    );
    expect(evento.body).toBe(
      '«Recompra: invitaciones anticipadas» no corrió a tiempo. Último error: El proveedor no respondió',
    );
    expect(evento.link).toEqual({
      entity: 'process-run',
      id: 'repurchase_anticipate',
    });
  });

  it('sanea el error antes de enviarlo en el aviso', async () => {
    const { cron, events } = armar([
      {
        proceso: ProcessName.REPURCHASE_ANTICIPATE,
        distributorId: null,
        salud: ProcessHealth.FAILED,
        error: 'Bearer secreto token=otro email persona@empresa.com',
      },
    ]);
    await cron.vigilar(AHORA);
    const body = eventoDe(events).body;
    expect(body).toContain('[oculto]');
    expect(body).not.toMatch(/secreto|otro|persona@empresa/);
  });

  it.each([
    [ProcessHealth.FAILED, 'terminó con error'],
    [ProcessHealth.STUCK, 'quedó trabado'],
  ])('un proceso global %s avisa «%s»', async (salud, texto) => {
    const { cron, events } = armar([
      { proceso: ProcessName.FLEET_ALERTS, distributorId: null, salud },
    ]);
    await cron.vigilar(AHORA);
    expect(eventoDe(events).body).toContain(texto);
  });

  it('un proceso que nunca corrió avisa sólo cuando el monitoreo lleva más de 1,5 períodos', async () => {
    // Diario: 1,5 períodos son 36 h; el monitoreo lleva 48 h.
    const diario = armar([
      {
        proceso: ProcessName.STOCK_LOW_ALERT,
        distributorId: null,
        salud: ProcessHealth.NEVER,
      },
    ]);
    await diario.cron.vigilar(AHORA);
    expect(eventoDe(diario.events).body).toContain('todavía no corrió');
    // Recién activado: no hay de qué avisar todavía.
    const nuevo = armar([
      {
        proceso: ProcessName.STOCK_LOW_ALERT,
        distributorId: null,
        salud: ProcessHealth.NEVER,
      },
    ]);
    nuevo.qb.getRawOne.mockResolvedValue({
      desde: new Date('2026-11-03T14:00:00Z'),
    });
    await nuevo.cron.vigilar(AHORA);
    expect(nuevo.events.emit).not.toHaveBeenCalled();
    // Sin ninguna corrida registrada tampoco.
    const vacio = armar([
      {
        proceso: ProcessName.STOCK_LOW_ALERT,
        distributorId: null,
        salud: ProcessHealth.NEVER,
      },
    ]);
    vacio.qb.getRawOne.mockResolvedValue({ desde: null });
    await vacio.cron.vigilar(AHORA);
    expect(vacio.events.emit).not.toHaveBeenCalled();
  });

  it('una corrida de una empresa se avisa a la plataforma, con el nombre de la empresa', async () => {
    const { cron, events } = armar([
      {
        proceso: ProcessName.CYLINDER_RECOVERY,
        distributorId: 'd2',
        salud: ProcessHealth.FAILED,
      },
    ]);
    await cron.vigilar(AHORA);
    expect(emitidos(events)).toEqual([
      [
        EVENTO_NOTIFICAR_ADMIN,
        null,
        'process-run:cylinder_recovery:d2:failed:2026-11-03',
      ],
    ]);
    expect(eventoDe(events).title).toBe(
      'Proceso automático: Recupero de envases de Empresa 2',
    );
  });

  it('una empresa activa se vigila; una suspendida o inexistente no', async () => {
    const { cron, events } = armar([
      {
        proceso: ProcessName.CYLINDER_RECOVERY,
        distributorId: 'd4',
        salud: ProcessHealth.FAILED,
      },
      {
        proceso: ProcessName.CYLINDER_RECOVERY,
        distributorId: 'd3',
        salud: ProcessHealth.FAILED,
      },
      {
        proceso: ProcessName.CYLINDER_RECOVERY,
        distributorId: 'd9',
        salud: ProcessHealth.FAILED,
      },
    ]);
    const r = await cron.vigilar(AHORA);
    expect(r.alerts).toBe(1);
    expect(emitidos(events)).toEqual([
      [
        EVENTO_NOTIFICAR_ADMIN,
        null,
        'process-run:cylinder_recovery:d4:failed:2026-11-03',
      ],
    ]);
  });

  it.each([ProcessHealth.OK, ProcessHealth.PARTIAL, ProcessHealth.RUNNING])(
    'el estado %s no avisa',
    async (salud) => {
      const { cron, events } = armar([
        { proceso: ProcessName.FLEET_ALERTS, distributorId: null, salud },
      ]);
      await cron.vigilar(AHORA);
      expect(events.emit).not.toHaveBeenCalled();
    },
  );

  it('no se avisa a sí misma', async () => {
    const { cron, events } = armar([
      {
        proceso: ProcessName.PROCESS_RUN_WATCH,
        distributorId: null,
        salud: ProcessHealth.LATE,
      },
    ]);
    await cron.vigilar(AHORA);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('cierra como fallidas las corridas que quedaron en curso más de un día', async () => {
    const { cron, qb } = armar([]);
    const r = await cron.vigilar(AHORA);
    expect(r.closed).toBe(2);
    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining('started_at < :corte'),
      {
        s: 'running',
        corte: new Date('2026-11-02T15:00:00Z'),
      },
    );
  });

  it('la purga conserva la última corrida de cada proceso y distribuidora', async () => {
    const { cron, repo } = armar([]);
    const r = await cron.purgar(AHORA);
    expect(r).toEqual({ purged: 5 });
    const [sql, [corte]] = repo.query.mock.calls[0] as [string, [Date]];
    expect(sql).toMatch(/EXISTS/);
    expect(sql).toMatch(/IS NOT DISTINCT FROM/);
    expect(corte).toEqual(new Date('2026-10-04T15:00:00Z'));
  });
});
