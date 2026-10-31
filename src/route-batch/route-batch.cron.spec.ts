import { RedisService } from '../redis/redis.service';
import { RouteBatchCron } from './route-batch.cron';
import { RouteBatchService } from './route-batch.service';

describe('RouteBatchCron', () => {
  let service: {
    distribuidorasConProgramados: jest.Mock;
    parametros: jest.Mock;
    evaluar: jest.Mock;
    vencerOfertas: jest.Mock;
  };
  let redis: { setIfAbsent: jest.Mock; withLock: jest.Mock; del: jest.Mock };
  let cron: RouteBatchCron;
  const ahora = new Date('2026-11-01T12:00:00Z');

  beforeEach(() => {
    service = {
      distribuidorasConProgramados: jest.fn().mockResolvedValue(['d1', 'd2']),
      parametros: jest
        .fn()
        .mockResolvedValue({ enabled: 1, evaluationFrequencyMinutes: 15 }),
      evaluar: jest
        .fn()
        .mockResolvedValue({ candidates: 4, batches: 1, orders: 2 }),
      vencerOfertas: jest
        .fn()
        .mockResolvedValue({ expired: 1, rescued: 0, completed: 0 }),
    };
    redis = {
      setIfAbsent: jest.fn().mockResolvedValue(true),
      del: jest.fn().mockResolvedValue(undefined),
      withLock: jest.fn(async (_k: string, _t: number, fn: () => unknown) => {
        await fn();
        return { obtenido: true, valor: undefined };
      }),
    };
    cron = new RouteBatchCron(
      service as unknown as RouteBatchService,
      redis as unknown as RedisService,
    );
  });

  it('arma lotes en cada distribuidora a la que le toca, con la marca de su frecuencia', async () => {
    const n = await cron.armarLasQueTocan(ahora);

    expect(n).toBe(2);
    expect(service.evaluar).toHaveBeenCalledWith('d1', ahora);
    expect(service.evaluar).toHaveBeenCalledWith('d2', ahora);
    // 15 minutos menos la holgura del tic.
    expect(redis.setIfAbsent).toHaveBeenCalledWith(
      'route-batch:cada:d1',
      15 * 60 - RouteBatchCron.HOLGURA_SEGUNDOS,
    );
  });

  it('una distribuidora con el módulo apagado se saltea: no se arma ni se gasta su marca de frecuencia', async () => {
    service.parametros.mockImplementation((id: string) =>
      Promise.resolve({
        enabled: id === 'd2' ? 1 : 0,
        evaluationFrequencyMinutes: 15,
      }),
    );

    expect(await cron.armarLasQueTocan(ahora)).toBe(1);
    expect(service.evaluar).toHaveBeenCalledTimes(1);
    expect(service.evaluar).toHaveBeenCalledWith('d2', ahora);
    expect(redis.setIfAbsent).not.toHaveBeenCalledWith(
      'route-batch:cada:d1',
      expect.anything(),
    );
  });

  it('la que todavía no cumplió su frecuencia espera al próximo tic', async () => {
    redis.setIfAbsent.mockImplementation((k: string) =>
      Promise.resolve(k.endsWith('d2')),
    );

    expect(await cron.armarLasQueTocan(ahora)).toBe(1);
    expect(service.evaluar).toHaveBeenCalledTimes(1);
    expect(service.evaluar).toHaveBeenCalledWith('d2', ahora);
  });

  it('cada distribuidora usa SU frecuencia', async () => {
    service.parametros.mockImplementation((id: string) =>
      Promise.resolve({
        enabled: 1,
        evaluationFrequencyMinutes: id === 'd1' ? 1 : 60,
      }),
    );

    await cron.armarLasQueTocan(ahora);

    expect(redis.setIfAbsent).toHaveBeenCalledWith(
      'route-batch:cada:d1',
      60 - RouteBatchCron.HOLGURA_SEGUNDOS,
    );
    expect(redis.setIfAbsent).toHaveBeenCalledWith(
      'route-batch:cada:d2',
      3600 - RouteBatchCron.HOLGURA_SEGUNDOS,
    );
  });

  it('si otra instancia la está armando (evaluar devuelve null), no se gasta la marca de frecuencia', async () => {
    service.evaluar.mockResolvedValueOnce(null);

    expect(await cron.armarLasQueTocan(ahora)).toBe(1);
    expect(redis.del).toHaveBeenCalledWith('route-batch:cada:d1');
    expect(redis.del).not.toHaveBeenCalledWith('route-batch:cada:d2');
  });

  it('si una distribuidora falla, las demás igual corren', async () => {
    service.evaluar.mockRejectedValueOnce(new Error('boom'));

    expect(await cron.armarLasQueTocan(ahora)).toBe(1);
    expect(service.evaluar).toHaveBeenCalledTimes(2);
  });

  it('el tic de armado corre bajo cerrojo', async () => {
    await cron.armar();

    expect(redis.withLock).toHaveBeenCalledWith(
      RouteBatchCron.CERROJO_ARMADO,
      RouteBatchCron.CERROJO_TTL_MS,
      expect.any(Function),
    );
    expect(service.evaluar).toHaveBeenCalledTimes(2);
  });

  it('el tic de vencimientos corre bajo cerrojo y vence las ofertas', async () => {
    await cron.vencer();

    expect(redis.withLock).toHaveBeenCalledWith(
      RouteBatchCron.CERROJO_VENCIMIENTOS,
      RouteBatchCron.CERROJO_TTL_MS,
      expect.any(Function),
    );
    expect(service.vencerOfertas).toHaveBeenCalledTimes(1);
  });

  it('con el cerrojo tomado por otra instancia no hace nada', async () => {
    redis.withLock.mockResolvedValue({ obtenido: false });

    await cron.vencer();

    expect(service.vencerOfertas).not.toHaveBeenCalled();
  });

  it('un error del proceso no tira el tic', async () => {
    redis.withLock.mockRejectedValue(new Error('redis caído'));

    await expect(cron.vencer()).resolves.toBeUndefined();
  });
});
