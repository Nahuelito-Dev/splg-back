import {
  INestApplication,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { SupplierPhotoController } from './supplier-photo.controller';
import { SupplierPhotoService } from '../application/supplier-photo.service';
import { crearValidationPipe } from '../../common/validation/validation-pipe';

const ID = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f001';
const PNG = Buffer.from('89504e470d0a1a0a0000000d', 'hex');

describe('SupplierPhotoController · foto en la API v2', () => {
  let app: INestApplication<Server>;
  let photo: { subir: jest.Mock; quitar: jest.Mock; enlace: jest.Mock };

  beforeEach(async () => {
    photo = {
      subir: jest.fn().mockResolvedValue({ kind: 'none' }),
      quitar: jest.fn().mockResolvedValue({ kind: 'none' }),
      enlace: jest.fn().mockResolvedValue({ kind: 'none' }),
    };
    const modulo = await Test.createTestingModule({
      controllers: [SupplierPhotoController],
      providers: [{ provide: SupplierPhotoService, useValue: photo }],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.distributorId = 'd1';
      next();
    });
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.useGlobalPipes(crearValidationPipe({ forbidNonWhitelisted: false }));
    await app.listen(0, '127.0.0.1'); // una sola vez y en loopback, adonde se conecta supertest: si no, falla al azar con carga
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /v2/suppliers/:id/photo?modo=url sin foto da url null', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v2/suppliers/${ID}/photo?modo=url`)
      .expect(200);
    expect(res.body).toEqual({
      url: null,
      expiresAt: null,
      requiresAuth: false,
    });
  });

  it('PUT y DELETE /v2/suppliers/:id/photo responden { url, expiresAt }', async () => {
    photo.subir.mockResolvedValue({
      kind: 'stored',
      signed: { url: 'https://s3/f', expiresAt: new Date('2030-01-01') },
    });
    const subida = await request(app.getHttpServer())
      .put(`/v2/suppliers/${ID}/photo`)
      .attach('file', PNG, { filename: 'f.png', contentType: 'image/png' })
      .expect(200);
    expect(subida.body).toEqual({
      url: 'https://s3/f',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    const baja = await request(app.getHttpServer())
      .delete(`/v2/suppliers/${ID}/photo`)
      .expect(200);
    expect(baja.body).toEqual({ url: null, expiresAt: null });
  });

  it('en la v1 la foto no existe', async () => {
    await request(app.getHttpServer())
      .get(`/v1/suppliers/${ID}/photo`)
      .expect(404);
    await request(app.getHttpServer())
      .put(`/v1/suppliers/${ID}/photo`)
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/v1/suppliers/${ID}/photo`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/suppliers/${ID}/photo`)
      .expect(404);
  });
});
