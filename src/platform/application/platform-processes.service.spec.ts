import {
  ProcessHealth,
  ProcessName,
  ProcessRunStatus,
} from '../../process-run/domain/process-catalog';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import type { DistributorService } from '../../distributor/distributor.service';
import type { ProcessRun } from '../../process-run/entities/process-run.entity';
import type {
  EstadoDeProceso,
  ProcessRunService,
} from '../../process-run/process-run.service';
import { PlatformProcessesService } from './platform-processes.service';

const AHORA = new Date('2026-11-14T13:00:00Z');

const estado = (
  proceso: ProcessName,
  distributorId: string | null,
  salud: ProcessHealth,
  inicio: string | null = null,
): EstadoDeProceso => ({
  proceso,
  distributorId,
  salud,
  ultimaBuena: null,
  ultima: inicio
    ? ({
        startedAt: new Date(inicio),
        status: ProcessRunStatus.OK,
      } as ProcessRun)
    : null,
});

function armar(
  estados: EstadoDeProceso[],
  empresas = [
    { distributorId: 'a', status: DistributorStatus.ACTIVE },
    { distributorId: 'b', status: DistributorStatus.ACTIVE },
    { distributorId: 'c', status: DistributorStatus.ACTIVE },
  ],
) {
  const runs = {
    estados: jest.fn().mockResolvedValue(estados),
    fallasDesde: jest.fn().mockResolvedValue([
      {
        process: ProcessName.CYLINDER_RECOVERY,
        distributorId: 'a',
        failures: 2,
      },
      {
        process: ProcessName.CYLINDER_RECOVERY,
        distributorId: 'b',
        failures: 1,
      },
      { process: ProcessName.FLEET_ALERTS, distributorId: null, failures: 4 },
    ]),
  };
  const service = new PlatformProcessesService(
    runs as unknown as ProcessRunService,
    {
      findAll: jest.fn().mockResolvedValue(empresas),
    } as unknown as DistributorService,
  );
  return { service, runs };
}

describe('PlatformProcessesService', () => {
  it('lee la salud, las fallas y las empresas activas', async () => {
    const { service, runs } = armar([]);
    await service.leer(AHORA);
    expect(runs.estados).toHaveBeenCalledWith(null, AHORA);
    expect(runs.fallasDesde).toHaveBeenCalledWith(
      new Date('2026-11-13T13:00:00Z'),
    );
  });

  it('excluye la salud y las fallas de empresas suspendidas', async () => {
    const { service } = armar(
      [
        estado(ProcessName.CYLINDER_RECOVERY, 'a', ProcessHealth.FAILED),
        estado(ProcessName.CYLINDER_RECOVERY, 'b', ProcessHealth.LATE),
        estado(ProcessName.FLEET_ALERTS, null, ProcessHealth.STUCK),
      ],
      [
        { distributorId: 'a', status: DistributorStatus.ACTIVE },
        { distributorId: 'b', status: DistributorStatus.SUSPENDED },
      ],
    );
    const salud = await service.leer(AHORA);
    expect(salud.estados.map((e) => e.distributorId)).toEqual(['a', null]);
    expect(salud.fallas.map((f) => f.distributorId)).toEqual(['a', null]);
  });

  it('agrega por proceso: estados de salud, empresas, alertas, fallas y última corrida', async () => {
    const { service } = armar([
      estado(
        ProcessName.CYLINDER_RECOVERY,
        'a',
        ProcessHealth.OK,
        '2026-11-14T12:00:00Z',
      ),
      estado(
        ProcessName.CYLINDER_RECOVERY,
        'b',
        ProcessHealth.FAILED,
        '2026-11-14T12:30:00Z',
      ),
      estado(
        ProcessName.CYLINDER_RECOVERY,
        'c',
        ProcessHealth.LATE,
        '2026-11-13T01:00:00Z',
      ),
      estado(
        ProcessName.FLEET_ALERTS,
        null,
        ProcessHealth.STUCK,
        '2026-11-14T11:00:00Z',
      ),
    ]);
    const r = await service.resumen(AHORA);
    const recupero = r.items.find(
      (i) => i.process === ProcessName.CYLINDER_RECOVERY,
    );
    expect(recupero).toMatchObject({
      global: false,
      companies: 3,
      health: { ok: 1, failed: 1, late: 1 },
      alerts: 2,
      failuresLast24h: 3,
      lastRunAt: new Date('2026-11-14T12:30:00Z'),
    });
    const flota = r.items.find((i) => i.process === ProcessName.FLEET_ALERTS);
    expect(flota).toMatchObject({
      global: true,
      companies: 0,
      health: { stuck: 1 },
      alerts: 1,
      failuresLast24h: 4,
    });
    expect(r.alerts).toBe(3);
    expect(r.items).toHaveLength(Object.values(ProcessName).length);
    expect(r.generatedAt).toBe(AHORA);
  });

  it('un proceso sin corridas no es global ni tiene última corrida', async () => {
    const { service } = armar([
      estado(ProcessName.STOCK_LOW_ALERT, null, ProcessHealth.NEVER),
    ]);
    const r = await service.resumen(AHORA);
    expect(
      r.items.find((i) => i.process === ProcessName.STOCK_LOW_ALERT),
    ).toMatchObject({
      global: false,
      lastRunAt: null,
      health: { never: 1 },
      alerts: 0,
    });
  });

  it('alertas por empresa: sólo las de empresa y con alerta', async () => {
    const { service } = armar([
      estado(ProcessName.CYLINDER_RECOVERY, 'a', ProcessHealth.OK),
      estado(ProcessName.CYLINDER_RECOVERY, 'b', ProcessHealth.FAILED),
      estado(ProcessName.REPURCHASE_ANTICIPATE, 'b', ProcessHealth.LATE),
      estado(ProcessName.FLEET_ALERTS, null, ProcessHealth.STUCK),
    ]);
    const salud = await service.leer(AHORA);
    expect([...PlatformProcessesService.alertasPorEmpresa(salud)]).toEqual([
      ['b', 2],
    ]);
    expect(PlatformProcessesService.alertasTotales(salud)).toBe(3);
    expect(PlatformProcessesService.fallasTotales(salud)).toBe(7);
    expect(PlatformProcessesService.deLaEmpresa(salud, 'b')).toEqual([
      expect.objectContaining({
        process: ProcessName.CYLINDER_RECOVERY,
        health: ProcessHealth.FAILED,
        failuresLast24h: 1,
      }),
      expect.objectContaining({
        process: ProcessName.REPURCHASE_ANTICIPATE,
        health: ProcessHealth.LATE,
        failuresLast24h: 0,
      }),
    ]);
  });
});
