import { ConfigService } from '@nestjs/config';
import {
  HealthCheckService,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';

/** `HealthIndicatorFunction` no tipa bien para un mock de test: basta con
 * que `health.check` invoque cada función que le pasamos, como hace Nest. */
type Chequeo = () => unknown;

/**
 * H-53: `/health` exigía RSS < 300 MB fijo, el umbral de un proceso recién
 * levantado. Con tráfico real (la batería de Postman, por ejemplo) lo supera
 * y el chequeo daba 503 aunque el proceso estuviera sano. Ahora el umbral
 * sale de `HEALTH_MEMORY_RSS_THRESHOLD_MB` (default 512, ver joi.validation).
 */
describe('HealthController — umbral de memoria (H-53)', () => {
  let memory: { checkRSS: jest.Mock };
  let health: { check: jest.Mock };
  let config: { getOrThrow: jest.Mock };

  function crearController(thresholdMb: number): HealthController {
    config = { getOrThrow: jest.fn().mockReturnValue(thresholdMb) };
    const db = { pingCheck: jest.fn() };
    memory = { checkRSS: jest.fn() };
    const disk = { checkStorage: jest.fn() };
    const redis = { isHealthy: jest.fn() };
    health = {
      check: jest.fn((checks: Chequeo[]) =>
        Promise.all(checks.map((fn) => fn())),
      ),
    };
    return new HealthController(
      health as unknown as HealthCheckService,
      db as unknown as TypeOrmHealthIndicator,
      memory as unknown as MemoryHealthIndicator,
      disk as unknown as DiskHealthIndicator,
      redis as unknown as RedisHealthIndicator,
      config as unknown as ConfigService,
    );
  }

  it('usa el umbral configurado (512 MB por default), no 300 MB fijo', async () => {
    const controller = crearController(512);
    await controller.check();
    expect(memory.checkRSS).toHaveBeenCalledWith(
      'memory_rss',
      512 * 1024 * 1024,
    );
    expect(memory.checkRSS).not.toHaveBeenCalledWith(
      'memory_rss',
      300 * 1024 * 1024,
    );
  });

  it('un umbral distinto (env) cambia el chequeo real, no queda fijo en el código', async () => {
    const controller = crearController(2048);
    await controller.check();
    expect(memory.checkRSS).toHaveBeenCalledWith(
      'memory_rss',
      2048 * 1024 * 1024,
    );
  });
});
