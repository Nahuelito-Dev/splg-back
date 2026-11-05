import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { RedisService } from '../redis/redis.service';
import { DocumentReadingCron } from './document-reading.cron';
import {
  DocumentReadingRunnerService,
  DocumentReadingRunResult,
} from './document-reading-runner.service';
import { DocumentReadingSettingsService } from './document-reading-settings.service';

const result = (
  overrides: Partial<DocumentReadingRunResult> = {},
): DocumentReadingRunResult => ({
  distributors: 1,
  read: 1,
  duplicates: 0,
  failed: 0,
  skipped: 0,
  budgetReached: 0,
  ...overrides,
});
const settings = {
  enabled: true,
  frequencyMinutes: 15,
  batchSize: 20,
  maxAttempts: 3,
  monthlyBudgetUsd: 20,
  typesMask: 255,
};

describe('DocumentReadingCron', () => {
  let runner: { disponible: boolean; run: jest.Mock };
  let params: { parametros: jest.Mock };
  let distributors: { findAll: jest.Mock };
  let redis: { get: jest.Mock; setex: jest.Mock; withLock: jest.Mock };
  let cron: DocumentReadingCron;

  beforeEach(() => {
    runner = { disponible: true, run: jest.fn().mockResolvedValue(result()) };
    params = { parametros: jest.fn().mockResolvedValue(settings) };
    distributors = {
      findAll: jest.fn().mockResolvedValue([
        { distributorId: 'd1', status: DistributorStatus.ACTIVE },
        { distributorId: 'd2', status: DistributorStatus.SUSPENDED },
      ]),
    };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue(undefined),
      withLock: jest.fn(
        (
          _key: string,
          _ttl: number,
          fn: () => Promise<DocumentReadingRunResult>,
        ) => fn().then((valor) => ({ obtenido: true, valor })),
      ),
    };
    cron = new DocumentReadingCron(
      runner as unknown as DocumentReadingRunnerService,
      params as unknown as DocumentReadingSettingsService,
      distributors as unknown as DistributorService,
      redis as unknown as RedisService,
    );
  });

  it('salta todo si no hay lector disponible', async () => {
    runner.disponible = false;
    await expect(cron.ejecutarSinCerrojo()).resolves.toEqual(
      result({ distributors: 0, read: 0 }),
    );
    expect(distributors.findAll).not.toHaveBeenCalled();
  });

  it('salta distribuidoras inactivas o con la opción apagada', async () => {
    params.parametros.mockResolvedValue({ ...settings, enabled: false });
    await cron.ejecutarSinCerrojo();
    expect(params.parametros).toHaveBeenCalledTimes(1);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('respeta la frecuencia y guarda la marca al correr', async () => {
    const ahora = new Date('2026-11-05T12:00:00Z');
    redis.get.mockResolvedValue(String(ahora.getTime() - 14 * 60_000));
    await cron.ejecutarSinCerrojo(ahora);
    expect(runner.run).not.toHaveBeenCalled();
    redis.get.mockResolvedValue(String(ahora.getTime() - 15 * 60_000));
    await cron.ejecutarSinCerrojo(ahora);
    expect(runner.run).toHaveBeenCalledWith('d1');
    expect(redis.setex).toHaveBeenCalledWith(
      'document-reading:ultima:d1',
      31 * 24 * 60 * 60,
      String(ahora.getTime()),
    );
  });

  it('un error de una distribuidora no corta las demás', async () => {
    distributors.findAll.mockResolvedValue([
      { distributorId: 'd1', status: DistributorStatus.ACTIVE },
      { distributorId: 'd2', status: DistributorStatus.ACTIVE },
    ]);
    runner.run
      .mockRejectedValueOnce(new Error('falló d1'))
      .mockResolvedValueOnce(result({ duplicates: 2 }));
    await expect(cron.ejecutarSinCerrojo()).resolves.toMatchObject({
      distributors: 1,
      duplicates: 2,
    });
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('suma los contadores de cada corrida', async () => {
    distributors.findAll.mockResolvedValue([
      { distributorId: 'd1', status: DistributorStatus.ACTIVE },
      { distributorId: 'd2', status: DistributorStatus.ACTIVE },
    ]);
    runner.run
      .mockResolvedValueOnce(result({ read: 2 }))
      .mockResolvedValueOnce(
        result({ failed: 3, skipped: 4, budgetReached: 1 }),
      );
    await expect(cron.ejecutarSinCerrojo()).resolves.toEqual({
      distributors: 2,
      read: 3,
      duplicates: 0,
      failed: 3,
      skipped: 4,
      budgetReached: 1,
    });
  });

  it('sin cerrojo queda saltada y no procesa', async () => {
    redis.withLock.mockResolvedValue({ obtenido: false });
    await expect(cron.ejecutar()).resolves.toBeUndefined();
    expect(runner.run).not.toHaveBeenCalled();
  });
});
