import {
  INestApplication,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { RoleType } from '../../common/constants/role-type.enum';
import { RedisService } from '../../redis/redis.service';
import { InsurerService } from '../application/insurer.service';
import { Insurer } from '../entities/insurer.entity';
import { InsurerController } from './insurer.controller';
import { crearValidationPipe } from '../../common/validation/validation-pipe';

const ID = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f001';

const aseguradora = {
  insurerId: ID,
  name: 'Seguros Rivadavia',
  taxId: '30500050205',
  phone: null,
  email: null,
  website: null,
  paymentUrl: 'https://pagos.rivadavia.test/cuotas',
  notes: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
} as Insurer;

describe('InsurerController · aseguradoras en la API v2', () => {
  let app: INestApplication<Server>;
  let insurers: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    insurers = {
      findAll: jest.fn().mockResolvedValue({ data: [aseguradora], total: 1 }),
      findOne: jest.fn().mockResolvedValue(aseguradora),
      create: jest.fn().mockResolvedValue(aseguradora),
      update: jest.fn().mockResolvedValue(aseguradora),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const modulo = await Test.createTestingModule({
      controllers: [InsurerController],
      providers: [
        { provide: InsurerService, useValue: insurers },
        { provide: RedisService, useValue: {} },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.distributorId = 'd1';
      req.user = { user_id: 'u1', email: 'a@b.c', role: RoleType.ADMIN };
      next();
    });
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.useGlobalPipes(crearValidationPipe());
    await app.listen(0, '127.0.0.1'); // una sola vez y en loopback, adonde se conecta supertest: si no, falla al azar con carga
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /v2/insurers lista con el enlace de pago y acota a la distribuidora', async () => {
    const res = await request(app.getHttpServer())
      .get('/v2/insurers?term=riva')
      .expect(200);
    expect(res.body).toMatchObject({
      total: 1,
      data: [
        {
          name: 'Seguros Rivadavia',
          paymentUrl: 'https://pagos.rivadavia.test/cuotas',
        },
      ],
    });
    expect(insurers.findAll).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ term: 'riva' }),
    );
  });

  it('POST /v2/insurers normaliza el CUIT con guiones y crea', async () => {
    await request(app.getHttpServer())
      .post('/v2/insurers')
      .send({ name: 'Seguros Rivadavia', taxId: '30-50005020-5' })
      .expect(201);
    expect(insurers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Seguros Rivadavia',
        taxId: '30500050205',
      }),
      'd1',
    );
  });

  it.each([
    ['un CUIT con el verificador mal', { taxId: '30500050208' }],
    ['un enlace de pago sin https', { paymentUrl: 'http://inseguro.test' }],
    ['un enlace de pago con espacios', { paymentUrl: 'https://a b.test' }],
    ['una web que no es URL', { website: 'rivadavia' }],
    ['un correo inválido', { email: 'no-es-correo' }],
    ['un teléfono con letras', { phone: 'llamar' }],
    ['sin nombre', { name: '   ' }],
    ['un campo que no existe', { otro: 1 }],
  ])('POST /v2/insurers 400 con %s', async (_caso, cambio) => {
    await request(app.getHttpServer())
      .post('/v2/insurers')
      .send({ name: 'Seguros Rivadavia', ...cambio })
      .expect(400);
    expect(insurers.create).not.toHaveBeenCalled();
  });

  it('un campo opcional vacío llega como null para borrarlo', async () => {
    await request(app.getHttpServer())
      .patch(`/v2/insurers/${ID}`)
      .send({ paymentUrl: '' })
      .expect(200);
    expect(insurers.update).toHaveBeenCalledWith(
      ID,
      { paymentUrl: null },
      'd1',
    );
  });

  it('GET /v2/insurers/:id responde la aseguradora', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v2/insurers/${ID}`)
      .expect(200);
    expect(res.body).toMatchObject({ insurerId: ID });
    await request(app.getHttpServer()).get('/v2/insurers/no-uuid').expect(400);
  });

  it('DELETE /v2/insurers/:id es una baja lógica sin cuerpo', async () => {
    await request(app.getHttpServer()).delete(`/v2/insurers/${ID}`).expect(204);
    expect(insurers.remove).toHaveBeenCalledWith(ID, 'd1');
  });

  it('en la v1 no existe', async () => {
    await request(app.getHttpServer()).get('/v1/insurers').expect(404);
  });
});
