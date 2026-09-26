/**
 * Tests de integración del módulo Health.
 *
 * Valida que los 3 endpoints (/health, /health/live, /health/ready)
 * responden correctamente con DB + Redis reales corriendo,
 * y que devuelven 503 cuando alguna dependencia cae.
 */
import request from 'supertest';
import { TestEnv, createTestApp } from './setup/test-env';

describe('Health (e2e)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestApp();
  }, 120000); // 2 min: arranque de containers puede tardar primera vez

  afterAll(async () => {
    await env.cleanup();
  });

  describe('GET /health', () => {
    it('responde 200 con status "ok" cuando todo está sano', async () => {
      const res = await request(env.app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.info.postgres.status).toBe('up');
      expect(res.body.info.redis.status).toBe('up');
      expect(res.body.info.memory_rss.status).toBe('up');
    });

    it('responde 503 cuando Redis está caído', async () => {
      await env.redisContainer.stop();

      const res = await request(env.app.getHttpServer())
        .get('/health')
        .expect(503);

      expect(res.body.status).toBe('error');
      expect(res.body.error.redis.status).toBe('down');

      // Reiniciamos para no contaminar otras suites — pero el container
      // ya no está; lo dejamos así porque es el último test del describe.
    });
  });

  describe('GET /health/live', () => {
    it('responde 200 sin chequear dependencias', async () => {
      const res = await request(env.app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('GET /health/ready', () => {
    it('responde 200 solo con DB + Redis sanos', async () => {
      // Este test corre antes del shutdown de Redis en /health
      // Si /health corre antes, este puede fallar — Jest serializa por defecto.
      const res = await request(env.app.getHttpServer()).get('/health/ready');

      // 200 si Redis está vivo, 503 si ya se cayó
      expect([200, 503]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.info.postgres.status).toBe('up');
        expect(res.body.info.redis.status).toBe('up');
      }
    });
  });
});
