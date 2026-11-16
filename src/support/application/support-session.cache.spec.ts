import type { RedisService } from '../../redis/redis.service';
import { claveDeSesion, SupportSessionCache } from './support-session.cache';

const ID = '11111111-1111-4111-8111-111111111111';
const AHORA = new Date('2026-11-13T12:00:00Z');

describe('SupportSessionCache', () => {
  let redis: { get: jest.Mock; setex: jest.Mock; del: jest.Mock };
  let cache: SupportSessionCache;

  beforeEach(() => {
    redis = {
      get: jest.fn(),
      setex: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    cache = new SupportSessionCache(redis as unknown as RedisService);
  });

  const sesion = (segundos: number) => ({
    id: ID,
    requestedBy: 'super-1',
    distributorId: 'empresa-a',
    scope: ['files'],
    expiresAt: new Date(AHORA.getTime() + segundos * 1000),
  });

  it('dura 30 segundos como máximo', async () => {
    await cache.guardar(sesion(3600), AHORA);
    expect(redis.setex).toHaveBeenCalledWith(
      claveDeSesion(ID),
      30,
      expect.any(String),
    );
  });

  it('nunca más que lo que le falta a la sesión', async () => {
    await cache.guardar(sesion(12.9), AHORA);
    expect(redis.setex).toHaveBeenCalledWith(
      claveDeSesion(ID),
      12,
      expect.any(String),
    );
  });

  it('a menos de un segundo del fin no se guarda', async () => {
    await cache.guardar(sesion(0.5), AHORA);
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('lee lo que guardó, con la fecha como Date', async () => {
    await cache.guardar(sesion(600), AHORA);
    const [, , valor] = redis.setex.mock.calls[0] as [string, number, string];
    redis.get.mockResolvedValue(valor);
    await expect(cache.leer(ID)).resolves.toEqual(sesion(600));
  });

  it('sin Redis no rompe: leer da null y guardar/olvidar no lanzan', async () => {
    redis.get.mockRejectedValue(new Error('caído'));
    redis.setex.mockRejectedValue(new Error('caído'));
    redis.del.mockRejectedValue(new Error('caído'));
    await expect(cache.leer(ID)).resolves.toBeNull();
    await expect(cache.guardar(sesion(600), AHORA)).resolves.toBeUndefined();
    await expect(cache.olvidar(ID)).resolves.toBeUndefined();
  });

  it('olvidar borra la clave de la sesión', async () => {
    await cache.olvidar(ID);
    expect(redis.del).toHaveBeenCalledWith(`soporte:sesion:${ID}`);
  });
});
