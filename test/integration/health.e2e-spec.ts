/**
 * Tests de integración del módulo Health.
 *
 * Valida que los 3 endpoints (/health, /health/live, /health/ready)
 * responden correctamente con DB + Redis reales corriendo,
 * y que devuelven 503 cuando alguna dependencia cae.
 */
import request from 'supertest';
import { TestEnv, createTestApp } from './setup/test-env';

/** Estado de un indicador individual, tal como lo arma `@nestjs/terminus`. */
interface EstadoIndicador {
  status: 'up' | 'down';
}

/** `res.body` de `GET /health` y `/health/ready` (`HealthCheckResult`). */
interface CuerpoHealthCheck {
  status: 'ok' | 'error' | 'shutting_down';
  info?: Record<string, EstadoIndicador>;
  error?: Record<string, EstadoIndicador>;
}

/** `res.body` de `GET /health/live`. */
interface CuerpoLive {
  status: string;
  timestamp: string;
}

describe('Health (e2e)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestApp();
  }, 120000); // 2 min: arranque de containers puede tardar primera vez

  afterAll(async () => {
    await env.cleanup();
  });

  describe('GET /health/live', () => {
    it('responde 200 sin chequear dependencias', async () => {
      const res = await request(env.app.getHttpServer())
        .get('/health/live')
        .expect(200);

      const body = res.body as CuerpoLive;
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('GET /health/ready', () => {
    it('responde 200 con DB + Redis sanos', async () => {
      const res = await request(env.app.getHttpServer())
        .get('/health/ready')
        .expect(200);

      const body = res.body as CuerpoHealthCheck;
      expect(body.info?.postgres.status).toBe('up');
      expect(body.info?.redis.status).toBe('up');
    });
  });

  describe('GET /health', () => {
    it('responde 200 con status "ok" cuando todo está sano', async () => {
      const res = await request(env.app.getHttpServer())
        .get('/health')
        .expect(200);

      const body = res.body as CuerpoHealthCheck;
      expect(body.status).toBe('ok');
      expect(body.info?.postgres.status).toBe('up');
      expect(body.info?.redis.status).toBe('up');
      expect(body.info?.memory_rss.status).toBe('up');
    });

    it('responde 503 cuando Redis está caído', async () => {
      await env.redisContainer.stop();

      const res = await request(env.app.getHttpServer())
        .get('/health')
        .expect(503);

      const body = res.body as CuerpoHealthCheck;
      expect(body.status).toBe('error');
      expect(body.error?.redis.status).toBe('down');

      // El container de Redis queda detenido: este describe es el último del archivo.
    });

    it('/health/ready también responde 503 con Redis caído', async () => {
      const res = await request(env.app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      const body = res.body as CuerpoHealthCheck;
      expect(body.error?.redis.status).toBe('down');
    });
  });
});
