import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import {
  ProcessHealth,
  ProcessName,
  ProcessRunStatus,
  RunTrigger,
} from './domain/process-catalog';
import { ProcessRun } from './entities/process-run.entity';
import { ProcessRunService } from './process-run.service';
import type { AdminNotification } from '../admin-notifications/entities/admin-notification.entity';

const AHORA = new Date('2026-11-03T12:00:00Z');

function corrida(p: Partial<ProcessRun>): ProcessRun {
  return {
    runId: 'r',
    process: ProcessName.FLEET_ALERTS,
    distributorId: null,
    startedAt: new Date(AHORA.getTime() - 60_000),
    finishedAt: new Date(AHORA.getTime() - 59_000),
    status: ProcessRunStatus.OK,
    counters: {},
    error: null,
    trigger: RunTrigger.CRON,
    instance: 'h:1',
    traceId: null,
    requestedBy: null,
    durationMs: null,
    errorFingerprint: null,
    companies: null,
    ...p,
  };
}

/** Un query builder que responde en orden a cada `getMany`. */
function armar(respuestas: ProcessRun[][]) {
  const qb = {
    distinctOn: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getMany: jest
      .fn()
      .mockImplementation(() => Promise.resolve(respuestas.shift() ?? [])),
    getManyAndCount: jest.fn().mockResolvedValue([[corrida({})], 1]),
  };
  const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  const config = { get: jest.fn((_k: string, d: number) => d) };
  const service = new ProcessRunService(
    repo as unknown as Repository<ProcessRun>,
    config as unknown as ConfigService,
    {} as Repository<AdminNotification>,
  );
  return { service, qb };
}

describe('ProcessRunService', () => {
  it('estados: los procesos sin corridas son never y los demás toman su salud', async () => {
    const vieja = corrida({
      startedAt: new Date(AHORA.getTime() - 3 * 3600_000),
    });
    const { service } = armar([[vieja], [vieja]]);
    const estados = await service.estados(null, AHORA);
    expect(
      estados.find((e) => e.proceso === ProcessName.FLEET_ALERTS)?.salud,
    ).toBe(ProcessHealth.LATE);
    expect(
      estados.find((e) => e.proceso === ProcessName.STOCK_LOW_ALERT)?.salud,
    ).toBe(ProcessHealth.NEVER);
    expect(estados).toHaveLength(Object.values(ProcessName).length);
  });

  it('con tenant se queda con la más nueva entre la propia y la global', async () => {
    const global = corrida({ startedAt: new Date(AHORA.getTime() - 600_000) });
    const propia = corrida({
      distributorId: 'd1',
      status: ProcessRunStatus.FAILED,
    });
    const { service, qb } = armar([[global, propia], []]);
    const estados = (await service.estados('d1', AHORA)).filter(
      (e) => e.proceso === ProcessName.FLEET_ALERTS,
    );
    expect(estados).toHaveLength(1);
    expect(estados[0].salud).toBe(ProcessHealth.FAILED);
    expect(estados[0].distributorId).toBe('d1');
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('IS NULL'),
      { distributorId: 'd1' },
    );
  });

  it('sin tenant separa por distribuidora', async () => {
    const { service } = armar([
      [
        corrida({ distributorId: 'd1' }),
        corrida({ distributorId: 'd2', status: ProcessRunStatus.FAILED }),
      ],
      [],
    ]);
    const estados = (await service.estados(null, AHORA)).filter(
      (e) => e.proceso === ProcessName.FLEET_ALERTS,
    );
    expect(estados.map((e) => [e.distributorId, e.salud])).toEqual([
      ['d1', ProcessHealth.OK],
      ['d2', ProcessHealth.FAILED],
    ]);
  });

  it('resumen cuenta las alertas y arma las fechas', async () => {
    const colgada = corrida({
      status: ProcessRunStatus.RUNNING,
      finishedAt: null,
      startedAt: new Date(Date.now() - 3 * 3600_000),
    });
    const { service } = armar([[colgada], []]);
    const r = await service.resumen();
    const item = r.items.find((i) => i.process === ProcessName.FLEET_ALERTS);
    expect(item?.health).toBe(ProcessHealth.STUCK);
    expect(item?.lastRun?.durationMs).toBeNull();
    expect(item?.nextExpectedAt).toBeInstanceOf(Date);
    expect(r.alerts).toBe(1);
  });

  it('resumen de una empresa agrega never para los procesos sin corrida propia', async () => {
    const propia = corrida({ distributorId: 'd1' });
    const { service } = armar([[propia], [propia]]);
    const r = await service.resumen('d1');
    expect(r.items).toHaveLength(Object.values(ProcessName).length);
    expect(r.items).toContainEqual(
      expect.objectContaining({
        process: ProcessName.STOCK_LOW_ALERT,
        distributorId: 'd1',
        health: ProcessHealth.NEVER,
        lastRun: null,
      }),
    );
  });

  it('listar rechaza from posterior a to', async () => {
    const { service } = armar([]);
    await expect(
      service.listar({
        from: '2026-11-03',
        to: '2026-11-01',
        limit: 20,
        offset: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('listar aplica los filtros y pagina', async () => {
    const { service, qb } = armar([]);
    const r = await service.listar({
      distributorId: 'd1',
      process: ProcessName.FLEET_ALERTS,
      status: ProcessRunStatus.FAILED,
      from: '2026-11-01',
      to: '2026-11-03',
      limit: 5,
      offset: 10,
    });
    expect(r.total).toBe(1);
    expect(r.items[0].title).toBeDefined();
    expect(qb.take).toHaveBeenCalledWith(5);
    expect(qb.skip).toHaveBeenCalledWith(10);
    expect(qb.andWhere).toHaveBeenCalledWith('r.process = :process', {
      process: ProcessName.FLEET_ALERTS,
    });
    expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', {
      status: ProcessRunStatus.FAILED,
    });
    // Filtra por esa empresa exacta: sin sumar las corridas globales.
    expect(qb.andWhere).toHaveBeenCalledWith(
      'r.distributorId = :distributorId',
      { distributorId: 'd1' },
    );
  });

  it('listar sin empresa no filtra por empresa', async () => {
    const { service, qb } = armar([]);
    await service.listar({ limit: 20, offset: 0 });
    expect(qb.andWhere).not.toHaveBeenCalledWith(
      'r.distributorId = :distributorId',
      expect.anything(),
    );
  });

  it('la plataforma ve el detalle de todas las corridas; con una empresa, sólo las de ella', async () => {
    const global = corrida({
      status: ProcessRunStatus.FAILED,
      counters: { applied: 42 },
      error: 'falló token=supersecreto en 7 distribuidoras',
    });
    const propia = corrida({
      process: ProcessName.STOCK_LOW_ALERT,
      distributorId: 'd1',
      counters: { sent: 2 },
      error: 'algo propio',
    });
    const ajena = corrida({
      process: ProcessName.STOCK_LOW_ALERT,
      distributorId: 'd2',
    });
    const todo = await armar([[global, propia, ajena], []]).service.resumen();
    expect(
      todo.items.find((i) => i.process === ProcessName.FLEET_ALERTS)?.lastRun,
    ).toMatchObject({
      counters: { applied: 42 },
      error: 'falló token=[oculto] en 7 distribuidoras',
    });
    expect(
      todo.items
        .filter((i) => i.process === ProcessName.STOCK_LOW_ALERT)
        .map((i) => i.distributorId)
        .sort(),
    ).toEqual(['d1', 'd2']);

    const deD1 = await armar([[global, propia, ajena], []]).service.resumen(
      'd1',
    );
    expect(deD1.items).toHaveLength(Object.values(ProcessName).length);
    const stock = deD1.items.find(
      (item) => item.process === ProcessName.STOCK_LOW_ALERT,
    );
    expect(stock).toMatchObject({
      distributorId: 'd1',
      lastRun: { counters: { sent: 2 }, error: 'algo propio' },
    });
  });

  it('fallasDesde agrupa por proceso y empresa en una consulta', async () => {
    const { service, qb } = armar([]);
    qb.getRawMany.mockResolvedValue([
      { process: ProcessName.FLEET_ALERTS, distributorId: null, failures: '3' },
      {
        process: ProcessName.CYLINDER_RECOVERY,
        distributorId: 'd1',
        failures: '1',
      },
    ]);
    const desde = new Date('2026-11-02T00:00:00Z');
    const r = await service.fallasDesde(desde);
    expect(r).toEqual([
      { process: ProcessName.FLEET_ALERTS, distributorId: null, failures: 3 },
      {
        process: ProcessName.CYLINDER_RECOVERY,
        distributorId: 'd1',
        failures: 1,
      },
    ]);
    expect(qb.where).toHaveBeenCalledWith(
      'r.status = :fallida AND r.startedAt >= :desde',
      { fallida: ProcessRunStatus.FAILED, desde },
    );
    expect(qb.groupBy).toHaveBeenCalledWith('r.process');
    expect(qb.addGroupBy).toHaveBeenCalledWith('r.distributorId');
  });

  it('una salteada reciente cuenta para el atraso: el proceso vivo sin trabajo queda ok', async () => {
    const dia = 24 * 3600_000;
    const vieja = corrida({
      process: ProcessName.DOCUMENT_READING,
      status: ProcessRunStatus.OK,
      startedAt: new Date(AHORA.getTime() - 3 * dia),
    });
    const salteada = corrida({
      process: ProcessName.DOCUMENT_READING,
      status: ProcessRunStatus.SKIPPED,
      startedAt: new Date(AHORA.getTime() - 60_000),
    });
    const conVida = (
      await armar([[vieja], [vieja], [salteada]]).service.estados(null, AHORA)
    ).find((e) => e.proceso === ProcessName.DOCUMENT_READING);
    expect(conVida?.salud).toBe(ProcessHealth.OK);

    const sinVida = (
      await armar([[vieja], [vieja], []]).service.estados(null, AHORA)
    ).find((e) => e.proceso === ProcessName.DOCUMENT_READING);
    expect(sinVida?.salud).toBe(ProcessHealth.LATE);
  });

  it('una salteada posterior no tapa una falla ni un proceso colgado', async () => {
    const falla = corrida({
      process: ProcessName.DOCUMENT_READING,
      status: ProcessRunStatus.FAILED,
      startedAt: new Date(AHORA.getTime() - 120_000),
    });
    const colgada = corrida({
      process: ProcessName.DOCUMENT_READING,
      status: ProcessRunStatus.RUNNING,
      startedAt: new Date(AHORA.getTime() - 5 * 3600_000),
    });
    const salteada = corrida({
      process: ProcessName.DOCUMENT_READING,
      status: ProcessRunStatus.SKIPPED,
      startedAt: new Date(AHORA.getTime() - 60_000),
    });
    const conFalla = (
      await armar([[falla], [], [salteada]]).service.estados(null, AHORA)
    ).find((e) => e.proceso === ProcessName.DOCUMENT_READING);
    expect(conFalla?.salud).toBe(ProcessHealth.FAILED);
    const conCuelgue = (
      await armar([[colgada], [], [salteada]]).service.estados(null, AHORA)
    ).find((e) => e.proceso === ProcessName.DOCUMENT_READING);
    expect(conCuelgue?.salud).toBe(ProcessHealth.STUCK);
  });

  it('el estado no cuenta las salteadas ni las de webhook (las manuales sí)', async () => {
    const { service, qb } = armar([[], [], []]);
    await service.estados(null, AHORA);
    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining('r.status <> :saltada AND r.trigger <> :webhook'),
      { saltada: ProcessRunStatus.SKIPPED, webhook: RunTrigger.WEBHOOK },
    );
  });
});

describe('ProcessRunService.detalle (monitor O1)', () => {
  const RUN = '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b';

  function conDetalle(run: ProcessRun | null, avisos: AdminNotification[]) {
    const runs = { findOne: jest.fn().mockResolvedValue(run) };
    const repoAvisos = { find: jest.fn().mockResolvedValue(avisos) };
    const service = new ProcessRunService(
      runs as unknown as Repository<ProcessRun>,
      { get: jest.fn() } as unknown as ConfigService,
      repoAvisos as unknown as Repository<AdminNotification>,
    );
    return { service, runs, repoAvisos };
  }

  it('devuelve la corrida completa con los avisos de su traza', async () => {
    const run = corrida({
      runId: RUN,
      process: ProcessName.PAYMENT_INBOX_PROCESS,
      status: ProcessRunStatus.PARTIAL,
      counters: { processed: 2, errors: 1 },
      error: 'No se pudo leer el pago',
      errorFingerprint: 'a91f03c2d4e5b6f7',
      trigger: RunTrigger.WEBHOOK,
      traceId: 'prueba-o1',
      durationMs: 1000,
      companies: { ok: 1, failed: 1 },
    });
    const aviso = {
      notificationId: 'n1',
      kind: 'payment_inbox_failed',
      distributorId: null,
      title: 'Con datos de Juan',
      createdAt: new Date('2026-11-14T12:00:01Z'),
    } as AdminNotification;
    const { service, runs, repoAvisos } = conDetalle(run, [aviso]);
    const dto = await service.detalle(RUN);
    expect(runs.findOne).toHaveBeenCalledWith({ where: { runId: RUN } });
    expect(repoAvisos.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { traceId: 'prueba-o1' } }),
    );
    expect(dto).toMatchObject({
      id: RUN,
      process: 'payment_inbox_process',
      title: 'Bandeja de avisos de pago: procesamiento',
      module: null,
      status: 'partial',
      trigger: 'webhook',
      requestedBy: null,
      instance: 'h:1',
      durationMs: 1000,
      counters: { processed: 2, errors: 1 },
      companies: { ok: 1, failed: 1 },
      error: 'No se pudo leer el pago',
      errorFingerprint: 'a91f03c2d4e5b6f7',
      traceId: 'prueba-o1',
      notifications: [
        {
          id: 'n1',
          kind: 'payment_inbox_failed',
          distributorId: null,
          createdAt: new Date('2026-11-14T12:00:01Z'),
        },
      ],
    });
    expect(JSON.stringify(dto)).not.toContain('Juan');
  });

  it('sin traza (corrida vieja) no busca avisos', async () => {
    const { service, repoAvisos } = conDetalle(corrida({ runId: RUN }), []);
    const dto = await service.detalle(RUN);
    expect(dto.notifications).toEqual([]);
    expect(dto.traceId).toBeNull();
    expect(repoAvisos.find).not.toHaveBeenCalled();
  });

  it('404 PROCESS_RUN_NOT_FOUND si no existe', async () => {
    const { service } = conDetalle(null, []);
    const error = await service.detalle(RUN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      code: 'PROCESS_RUN_NOT_FOUND',
    });
  });
});
