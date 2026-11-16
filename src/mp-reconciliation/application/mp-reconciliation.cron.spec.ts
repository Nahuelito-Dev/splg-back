import type { RedisService } from '../../redis/redis.service';
import { MpReconciliationCron } from './mp-reconciliation.cron';
import type { MpReconciliationService } from './mp-reconciliation.service';

describe('MpReconciliationCron', () => {
  let conciliaciones: {
    idsPendientes: jest.Mock;
    sincronizar: jest.Mock;
  };
  let redis: { withLock: jest.Mock };
  let cron: MpReconciliationCron;

  beforeEach(() => {
    conciliaciones = {
      idsPendientes: jest.fn().mockResolvedValue(['a', 'b', 'c']),
      sincronizar: jest.fn().mockResolvedValue(undefined),
    };
    redis = {
      withLock: jest.fn(
        async (_k: string, _ttl: number, fn: () => Promise<unknown>) => ({
          obtenido: true,
          valor: await fn(),
        }),
      ),
    };
    cron = new MpReconciliationCron(
      conciliaciones as unknown as MpReconciliationService,
      redis as unknown as RedisService,
    );
  });

  it('procesa las pendientes bajo el cerrojo distribuido', async () => {
    await cron.sincronizarPendientes();

    expect(redis.withLock).toHaveBeenCalledWith(
      MpReconciliationCron.CERROJO,
      MpReconciliationCron.CERROJO_TTL_MS,
      expect.any(Function),
    );
    expect(conciliaciones.sincronizar.mock.calls).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
  });

  it('la falla de una corrida no frena a las otras', async () => {
    conciliaciones.sincronizar.mockRejectedValueOnce(new Error('boom'));

    await expect(cron.barrer()).resolves.toBe(3);

    expect(conciliaciones.sincronizar).toHaveBeenCalledTimes(3);
  });

  it('si otra instancia tiene el cerrojo no hace nada', async () => {
    redis.withLock.mockResolvedValue({ obtenido: false });

    await cron.sincronizarPendientes();

    expect(conciliaciones.sincronizar).not.toHaveBeenCalled();
  });

  it('un error del cerrojo no tumba el proceso', async () => {
    redis.withLock.mockRejectedValue(new Error('redis caído'));

    await expect(cron.sincronizarPendientes()).resolves.toBeUndefined();
  });
});
