import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DiskHealthIndicator,
  HealthCheckService,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { ChequeosService } from './chequeos.service';
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
describe('ChequeosService — umbral de memoria (H-53)', () => {
  let memory: { checkRSS: jest.Mock };
  let health: { check: jest.Mock };

  function crear(thresholdMb: number): ChequeosService {
    const config = { getOrThrow: jest.fn().mockReturnValue(thresholdMb) };
    memory = { checkRSS: jest.fn() };
    health = {
      check: jest.fn((checks: Chequeo[]) =>
        Promise.all(checks.map((fn) => fn())),
      ),
    };
    return new ChequeosService(
      health as unknown as HealthCheckService,
      { pingCheck: jest.fn() } as unknown as TypeOrmHealthIndicator,
      memory as unknown as MemoryHealthIndicator,
      { checkStorage: jest.fn() } as unknown as DiskHealthIndicator,
      { isHealthy: jest.fn() } as unknown as RedisHealthIndicator,
      config as unknown as ConfigService,
    );
  }

  it('usa el umbral configurado (512 MB por default), no 300 MB fijo', async () => {
    const servicio = crear(512);
    await servicio.check();
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
    const servicio = crear(2048);
    await servicio.check();
    expect(memory.checkRSS).toHaveBeenCalledWith(
      'memory_rss',
      2048 * 1024 * 1024,
    );
  });
});

describe('ChequeosService.estados', () => {
  function crearConResultado(resultado: () => Promise<unknown>) {
    const servicio = new ChequeosService(
      { check: jest.fn(resultado) } as unknown as HealthCheckService,
      {} as TypeOrmHealthIndicator,
      {} as MemoryHealthIndicator,
      {} as DiskHealthIndicator,
      {} as RedisHealthIndicator,
      { getOrThrow: () => 512 } as unknown as ConfigService,
    );
    return servicio;
  }

  it('todo sano: todos los componentes arriba', async () => {
    const servicio = crearConResultado(() =>
      Promise.resolve({
        status: 'ok',
        details: {
          postgres: { status: 'up' },
          redis: { status: 'up' },
          memory_rss: { status: 'up' },
          storage: { status: 'up' },
        },
      }),
    );
    expect(await servicio.estados()).toEqual({
      api: 'up',
      postgres: 'up',
      redis: 'up',
      memory_rss: 'up',
      storage: 'up',
    });
  });

  it('un 503 de Terminus marca caído sólo al componente que falló', async () => {
    const servicio = crearConResultado(() =>
      Promise.reject(
        new ServiceUnavailableException({
          status: 'error',
          details: {
            postgres: { status: 'up' },
            redis: { status: 'down' },
            memory_rss: { status: 'up' },
            storage: { status: 'up' },
          },
        }),
      ),
    );
    const estados = await servicio.estados();
    expect(estados.redis).toBe('down');
    expect(estados.postgres).toBe('up');
    expect(estados.api).toBe('up');
  });

  it('un error inesperado no lanza: todo menos la API figura caído', async () => {
    const servicio = crearConResultado(() => Promise.reject(new Error('boom')));
    const estados = await servicio.estados();
    expect(estados.api).toBe('up');
    expect(estados.postgres).toBe('down');
    expect(estados.storage).toBe('down');
  });
});
