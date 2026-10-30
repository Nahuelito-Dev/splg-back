import { RedisService } from '../../redis/redis.service';
import { VehicleUsageCron } from './vehicle-usage.cron';
import { VehicleUsageFeedService } from './vehicle-usage-feed.service';

describe('VehicleUsageCron', () => {
  let feed: { distribuidorasConVehiculos: jest.Mock; alimentar: jest.Mock };
  let withLock: jest.Mock;
  let cron: VehicleUsageCron;

  beforeEach(() => {
    feed = {
      distribuidorasConVehiculos: jest.fn().mockResolvedValue(['d1', 'd2']),
      alimentar: jest.fn().mockResolvedValue({ vehiculos: 1, filas: 1 }),
    };
    withLock = jest
      .fn()
      .mockImplementation(
        async (_k: string, _t: number, fn: () => Promise<unknown>) => ({
          obtenido: true,
          valor: await fn(),
        }),
      );
    cron = new VehicleUsageCron(
      feed as unknown as VehicleUsageFeedService,
      { withLock } as unknown as RedisService,
    );
  });

  it('corre bajo el cerrojo y alimenta todas las distribuidoras', async () => {
    await cron.alimentar();
    expect(withLock).toHaveBeenCalledWith(
      VehicleUsageCron.CERROJO,
      VehicleUsageCron.CERROJO_TTL_MS,
      expect.any(Function),
    );
    expect(feed.alimentar).toHaveBeenCalledTimes(2);
  });

  it('si otra instancia tiene el cerrojo no alimenta nada', async () => {
    withLock.mockResolvedValue({ obtenido: false });
    await cron.alimentar();
    expect(feed.alimentar).not.toHaveBeenCalled();
  });

  it('una distribuidora que falla no frena a las demás', async () => {
    feed.alimentar.mockRejectedValueOnce(new Error('boom'));
    expect(await cron.alimentarTodas()).toBe(1);
    expect(feed.alimentar).toHaveBeenCalledTimes(2);
  });

  it('un error del cerrojo no se propaga', async () => {
    withLock.mockRejectedValue(new Error('redis caído'));
    await expect(cron.alimentar()).resolves.toBeUndefined();
  });
});
