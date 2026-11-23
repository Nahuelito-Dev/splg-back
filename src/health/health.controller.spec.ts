import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Server } from 'node:http';
import { ChequeosService } from './chequeos.service';
import { HealthController } from './health.controller';
import { ModeloPagina } from './pagina-estado.modelo';
import { PaginaEstadoService } from './pagina-estado.service';
import { RedisHealthIndicator } from './redis.health';
import { HistorialComponente } from './disponibilidad';

const HISTORIAL_VACIO: HistorialComponente = {
  dias: [],
  disponibilidad: null,
  incidentes: [],
};

function modelo(general: ModeloPagina['general']): ModeloPagina {
  return {
    general,
    verificadoEn: Date.parse('2026-11-22T18:00:00Z'),
    version: '1.2.3',
    historialDisponible: true,
    componentes: [
      {
        id: 'api',
        nombre: 'API',
        detalle: 'x',
        actual: 'up',
        historial: HISTORIAL_VACIO,
      },
    ],
  };
}

const JSON_SANO = {
  status: 'ok',
  info: { postgres: { status: 'up' } },
  error: {},
  details: { postgres: { status: 'up' } },
};

describe('GET /health: JSON para máquinas, HTML para navegadores', () => {
  let app: INestApplication;
  let server: Server;
  let check: jest.Mock;
  let modeloActual: jest.Mock;

  beforeEach(async () => {
    check = jest.fn().mockResolvedValue(JSON_SANO);
    modeloActual = jest.fn().mockResolvedValue(modelo('ok'));
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: ChequeosService, useValue: { check } },
        { provide: PaginaEstadoService, useValue: { modelo: modeloActual } },
        { provide: HealthCheckService, useValue: { check: jest.fn() } },
        { provide: TypeOrmHealthIndicator, useValue: {} },
        { provide: RedisHealthIndicator, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterEach(async () => {
    await app.close();
  });

  it('sin Accept (curl, wget, healthcheck de Docker): JSON de siempre', async () => {
    const res = await request(server)
      .get('/health')
      .set('Accept', '')
      .expect(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual(JSON_SANO);
    expect(modeloActual).not.toHaveBeenCalled();
  });

  it('con Accept: */* sigue siendo JSON', async () => {
    const res = await request(server)
      .get('/health')
      .set('Accept', '*/*')
      .expect(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('con Accept: application/json sigue siendo JSON', async () => {
    const res = await request(server)
      .get('/health')
      .set('Accept', 'application/json')
      .expect(200);
    expect(res.body).toEqual(JSON_SANO);
  });

  it('JSON con 503 y detalle cuando un componente falla (sin Accept html)', async () => {
    const cuerpo = {
      status: 'error',
      details: { redis: { status: 'down' } },
    };
    check.mockRejectedValue(new ServiceUnavailableException(cuerpo));
    const res = await request(server)
      .get('/health')
      .set('Accept', 'application/json')
      .expect(503);
    expect(res.body).toMatchObject(cuerpo);
  });

  it('con Accept de navegador devuelve la página HTML', async () => {
    const res = await request(server)
      .get('/health')
      .set(
        'Accept',
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      )
      .expect(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Estado de la API');
    expect(res.text).toContain('Todo funcionando');
    expect(res.headers['cache-control']).toBe('private, max-age=15');
    expect(res.headers.vary).toContain('Accept');
    expect(check).not.toHaveBeenCalled();
  });

  it('la CSP es estricta, con nonce, y coincide con el de la página', async () => {
    const res = await request(server)
      .get('/health')
      .set('Accept', 'text/html')
      .expect(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('http');
    const nonce = /nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(res.text).toContain(`<style nonce="${nonce}">`);
    expect(res.text).toContain(`<script nonce="${nonce}">`);
  });

  it('cada respuesta HTML trae un nonce distinto', async () => {
    const a = await request(server).get('/health').set('Accept', 'text/html');
    const b = await request(server).get('/health').set('Accept', 'text/html');
    expect(a.headers['content-security-policy']).not.toBe(
      b.headers['content-security-policy'],
    );
  });

  it('con algo caído la página igual se muestra, con 503', async () => {
    modeloActual.mockResolvedValue(modelo('parcial'));
    const res = await request(server)
      .get('/health')
      .set('Accept', 'text/html')
      .expect(503);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Funcionamiento parcial');
  });

  it('con la base caída la página dice Caída', async () => {
    modeloActual.mockResolvedValue(modelo('caida'));
    const res = await request(server)
      .get('/health')
      .set('Accept', 'text/html')
      .expect(503);
    expect(res.text).toContain('Caída');
  });

  it('?format=json fuerza el JSON aunque el cliente prefiera HTML', async () => {
    const res = await request(server)
      .get('/health?format=json')
      .set('Accept', 'text/html')
      .expect(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual(JSON_SANO);
  });

  it('/health/live no cambia', async () => {
    const res = await request(server)
      .get('/health/live')
      .set('Accept', 'text/html')
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  describe('contrato para máquinas (curl, wget, healthcheck de Docker)', () => {
    const CUERPO_503 = {
      status: 'error',
      info: { postgres: { status: 'up' } },
      error: { redis: { status: 'down' } },
      details: {
        postgres: { status: 'up' },
        redis: { status: 'down' },
      },
    };

    /** Sin el header Accept (no vacío: ausente), como wget. */
    const sinAccept = () => request(server).get('/health');

    it('200: sin Accept y con */* dan el mismo status y el mismo cuerpo exacto que la variante JSON', async () => {
      const json = await request(server)
        .get('/health')
        .set('Accept', 'application/json');
      const ausente = await sinAccept();
      const cualquiera = await request(server)
        .get('/health')
        .set('Accept', '*/*');
      for (const res of [ausente, cualquiera]) {
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe(json.headers['content-type']);
        expect(res.text).toBe(json.text);
        expect(res.body).toEqual(JSON_SANO);
      }
    });

    it('503: sin Accept y con */* dan el mismo status y el mismo cuerpo exacto que la variante JSON', async () => {
      check.mockRejectedValue(new ServiceUnavailableException(CUERPO_503));
      const json = await request(server)
        .get('/health')
        .set('Accept', 'application/json');
      const ausente = await sinAccept();
      const cualquiera = await request(server)
        .get('/health')
        .set('Accept', '*/*');
      expect(json.status).toBe(503);
      for (const res of [ausente, cualquiera]) {
        expect(res.status).toBe(503);
        expect(res.headers['content-type']).toBe(json.headers['content-type']);
        expect(res.text).toBe(json.text);
        expect(res.body).toMatchObject(CUERPO_503);
      }
      expect(modeloActual).not.toHaveBeenCalled();
    });
  });

  describe('Swagger', () => {
    it('/health documenta JSON y text/html en el 200 y en el 503', () => {
      const documento = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('t').build(),
      );
      const get = documento.paths['/health'].get;
      expect(get).toBeDefined();
      for (const codigo of ['200', '503']) {
        const respuesta = get?.responses[codigo] as {
          content?: Record<string, unknown>;
        };
        expect(Object.keys(respuesta.content ?? {}).sort()).toEqual([
          'application/json',
          'text/html',
        ]);
      }
      expect(get?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'format', in: 'query' }),
        ]),
      );
    });
  });
});
