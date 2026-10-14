import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { montarDocumentacion } from './documentacion';

const RUTAS_DE_DOCUMENTACION = ['/docs', '/docs-json', '/docs-yaml'];

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

async function crearApp(): Promise<INestApplication> {
  const modulo = await Test.createTestingModule({
    controllers: [PingController],
  }).compile();
  const app = modulo.createNestApplication();
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  return app;
}

describe('montarDocumentacion', () => {
  let app: INestApplication;
  const servidor = () => app.getHttpServer() as Server;

  afterEach(async () => {
    await app.close();
  });

  describe('con credenciales', () => {
    beforeEach(async () => {
      app = await crearApp();
      montarDocumentacion(app, { SWAGGER_USER: 'doc', SWAGGER_PASSWORD: 'x' });
      await app.init();
    });

    it.each(RUTAS_DE_DOCUMENTACION)(
      '%s sin credenciales responde 401',
      async (ruta) => {
        await request(servidor()).get(ruta).expect(401);
      },
    );

    it.each(RUTAS_DE_DOCUMENTACION)(
      '%s con credenciales equivocadas responde 401',
      async (ruta) => {
        await request(servidor()).get(ruta).auth('doc', 'otra').expect(401);
      },
    );

    it('/docs-yaml con credenciales sirve el contrato', async () => {
      const res = await request(servidor())
        .get('/docs-yaml')
        .auth('doc', 'x')
        .expect(200);
      expect(res.text).toContain('openapi:');
    });

    it('/docs-json con credenciales sirve el contrato', async () => {
      const res = await request(servidor())
        .get('/docs-json')
        .auth('doc', 'x')
        .expect(200);
      expect((res.body as { openapi: string }).openapi).toBeDefined();
    });
  });

  describe('sin credenciales', () => {
    it.each(['production', 'staging', undefined])(
      'con NODE_ENV=%s no monta nada (falla cerrada)',
      async (entorno) => {
        app = await crearApp();
        expect(montarDocumentacion(app, { NODE_ENV: entorno })).toBe(false);
        await app.init();
        for (const ruta of RUTAS_DE_DOCUMENTACION) {
          await request(servidor()).get(ruta).expect(404);
        }
      },
    );

    it.each(['development', 'test'])(
      'con NODE_ENV=%s queda abierta, también el YAML',
      async (entorno) => {
        app = await crearApp();
        expect(montarDocumentacion(app, { NODE_ENV: entorno })).toBe(true);
        await app.init();
        await request(servidor()).get('/docs-yaml').expect(200);
      },
    );
  });
});
