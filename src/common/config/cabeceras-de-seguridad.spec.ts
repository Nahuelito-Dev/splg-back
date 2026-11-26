import { Controller, Get, Res } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Response } from 'express';
import { montarCabecerasDeSeguridad } from './cabeceras-de-seguridad';

@Controller()
class PruebaController {
  @Get('docs')
  docs(): string {
    return 'swagger';
  }

  @Get('health')
  health(@Res({ passthrough: true }) res: Response): string {
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    return 'ok';
  }

  @Get('algo')
  algo(): { ok: boolean } {
    return { ok: true };
  }
}

describe('montarCabecerasDeSeguridad', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [PruebaController],
    }).compile();
    app = modulo.createNestApplication<NestExpressApplication>();
    montarCabecerasDeSeguridad(app);
    await app.init();
  });

  afterAll(() => app.close());

  it('las rutas de la API llevan las cabeceras de helmet', async () => {
    const res = await request(app.getHttpServer()).get('/algo').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('/docs no lleva política de contenido (Swagger usa scripts en línea) pero sí el resto', async () => {
    const res = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('la política propia de la página de estado pisa la de helmet', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
  });
});
