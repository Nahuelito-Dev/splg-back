import {
  type INestApplication,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

describe('ExportsController', () => {
  let app: INestApplication<Server>;
  const preparar = jest.fn();

  beforeEach(async () => {
    preparar.mockResolvedValue({
      nombreDeArchivo: 'pedidos-2026-10-27.csv',
      tipoDeContenido: 'text/csv; charset=utf-8',
      total: 2,
      cuerpo: Readable.from(['a;b\n', '1;2\n']),
    });
    const modulo = await Test.createTestingModule({
      controllers: [ExportsController],
      providers: [{ provide: ExportsService, useValue: { preparar } }],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.assign(req, { distributorId: 'd1' });
      next();
    });
    await app.listen(0, '127.0.0.1'); // una sola vez y en loopback, adonde se conecta supertest: si no, falla al azar con carga
  });

  afterEach(async () => {
    await app.close();
  });

  it('descarga el archivo con los encabezados de adjunto, solo en /api/v2', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v2/exports/pedidos?format=csv&status=pending')
      .expect(200);

    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="pedidos-2026-10-27.csv"',
    );
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['x-total-count']).toBe('2');
    expect(res.text).toBe('a;b\n1;2\n');
    expect(preparar).toHaveBeenCalledWith(
      'pedidos',
      { format: 'csv', status: 'pending' },
      'd1',
      expect.any(AbortSignal),
    );
    await request(app.getHttpServer())
      .get('/api/v1/exports/pedidos')
      .expect(404);
  });

  it('si el stream falla a mitad, corta la conexión: el cliente no recibe un 200 completo', async () => {
    async function* roto(): AsyncGenerator<string> {
      await Promise.resolve();
      yield 'a;b\n';
      throw new Error('se cayó la base');
    }
    preparar.mockResolvedValue({
      nombreDeArchivo: 'pedidos-2026-10-27.csv',
      tipoDeContenido: 'text/csv; charset=utf-8',
      total: 9,
      cuerpo: Readable.from(roto()),
    });

    await expect(
      request(app.getHttpServer()).get('/api/v2/exports/pedidos'),
    ).rejects.toThrow();
  });
});
