/**
 * Tests de integración: distributed lock con Redlock.
 *
 * Valida que RedisService.acquireLock previene ejecución concurrente
 * del mismo recurso en multi-instancia (caso del cron de dispatch).
 */
import { TestEnv, createTestApp } from './setup/test-env';
import { RedisService } from '../../src/redis/redis.service';

describe('Redlock distributed lock (e2e)', () => {
  let env: TestEnv;
  let redisService: RedisService;

  beforeAll(async () => {
    env = await createTestApp();
    redisService = env.app.get(RedisService);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  it('primer acquire obtiene el lock, segundo concurrente recibe null', async () => {
    const lock1 = await redisService.acquireLock('test:lock-1', 5000);
    expect(lock1).not.toBeNull();

    // Segundo intento sobre la misma key mientras lock1 está vivo
    const lock2 = await redisService.acquireLock('test:lock-1', 5000);
    expect(lock2).toBeNull();

    // Liberamos lock1 y reintentamos: ahora sí debe obtenerlo
    await lock1!.release();

    const lock3 = await redisService.acquireLock('test:lock-1', 5000);
    expect(lock3).not.toBeNull();
    await lock3!.release();
  });

  it('locks distintos no interfieren entre sí', async () => {
    const lockA = await redisService.acquireLock('test:resource-a', 5000);
    const lockB = await redisService.acquireLock('test:resource-b', 5000);

    expect(lockA).not.toBeNull();
    expect(lockB).not.toBeNull();

    await lockA!.release();
    await lockB!.release();
  });

  it('lock expira automáticamente por TTL', async () => {
    const lock = await redisService.acquireLock('test:ttl', 500); // 0.5s
    expect(lock).not.toBeNull();

    // Esperar a que expire
    await new Promise((r) => setTimeout(r, 700));

    // Después del TTL, otro proceso puede adquirirlo
    const lockAfterExpiry = await redisService.acquireLock('test:ttl', 1000);
    expect(lockAfterExpiry).not.toBeNull();
    await lockAfterExpiry!.release();
  });

  it('simula multi-instancia: 5 acquires paralelos → solo 1 obtiene', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        redisService.acquireLock('test:concurrent', 3000),
      ),
    );

    const acquired = results.filter((r) => r !== null);
    expect(acquired.length).toBe(1);

    await acquired[0]!.release();
  });
});
