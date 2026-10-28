import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { montarDocumentacion, soloRutasVersionadas } from './documentacion';
import type { OpenAPIObject } from '@nestjs/swagger';

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
      await app.listen(0); // una sola vez: sin esto supertest abre un servidor por pedido y falla al azar con carga
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
        await app.listen(0); // una sola vez: sin esto supertest abre un servidor por pedido y falla al azar con carga
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
        await app.listen(0); // una sola vez: sin esto supertest abre un servidor por pedido y falla al azar con carga
        await request(servidor()).get('/docs-yaml').expect(200);
      },
    );
  });
});

describe('soloRutasVersionadas', () => {
  const documento = (rutas: string[]): OpenAPIObject => ({
    openapi: '3.0.0',
    info: { title: 'x', version: '1' },
    paths: Object.fromEntries(rutas.map((r) => [r, {}])),
  });

  it('descarta la ruta neutra cuando existe su gemela /api/v1', () => {
    const salida = soloRutasVersionadas(
      documento(['/api/users', '/api/v1/users', '/api/v2/users']),
    );
    expect(Object.keys(salida.paths)).toEqual([
      '/api/v1/users',
      '/api/v2/users',
    ]);
  });

  it('conserva la neutra que no tiene versión equivalente', () => {
    const salida = soloRutasVersionadas(documento(['/api/health']));
    expect(Object.keys(salida.paths)).toEqual(['/api/health']);
  });
});
