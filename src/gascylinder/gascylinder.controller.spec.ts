import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { GasCylinderController } from './gascylinder.controller';
import { GasCylinderService } from './gascylinder.service';
import { GasCylinderPhotoService } from './gascylinder-photo.service';

/**
 * El catálogo es público (la app cliente lo ve sin sesión), pero con un
 * usuario identificado se acota a SU distribuidora: un admin de otra no ve el
 * catálogo de la distribuidora por defecto. El guard global no corre acá: un
 * middleware deja en la request el tenant que el guard dejaría (`null` si la
 * request es anónima).
 */
describe('GasCylinderController · catálogo público con identidad opcional', () => {
  let app: INestApplication<Server>;
  let productos: { findAll: jest.Mock; getAvailableCylinders: jest.Mock };
  let tenant: string | null;

  beforeEach(async () => {
    tenant = null;
    productos = {
      findAll: jest.fn().mockResolvedValue({
        gasCylinders: [],
        total: 0,
        limit: 10,
        offset: 0,
      }),
      getAvailableCylinders: jest
        .fn()
        .mockResolvedValue({ products: [], paymentMethods: [] }),
    };
    const modulo = await Test.createTestingModule({
      controllers: [GasCylinderController],
      providers: [
        { provide: GasCylinderService, useValue: productos },
        {
          provide: GasCylinderPhotoService,
          useValue: { firmar: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.distributorId = tenant;
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0); // una sola vez: sin esto supertest abre un servidor por pedido y falla al azar con carga
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /gascylinder con un admin identificado usa SU distribuidora, no la del query', async () => {
    tenant = 'dist-del-admin';
    await request(app.getHttpServer())
      .get('/gascylinder?distributor=otra')
      .expect(200);
    expect(productos.findAll).toHaveBeenCalledWith(
      expect.anything(),
      'dist-del-admin',
    );
  });

  it('GET /gascylinder anónimo sigue usando ?distributor= (o la por defecto)', async () => {
    await request(app.getHttpServer())
      .get('/gascylinder?distributor=demo')
      .expect(200);
    expect(productos.findAll).toHaveBeenLastCalledWith(
      expect.anything(),
      'demo',
    );
    await request(app.getHttpServer()).get('/gascylinder').expect(200);
    expect(productos.findAll).toHaveBeenLastCalledWith(
      expect.anything(),
      undefined,
    );
  });

  it('GET /gascylinder/available/list con admin identificado usa SU distribuidora', async () => {
    tenant = 'dist-del-admin';
    await request(app.getHttpServer())
      .get('/gascylinder/available/list?distributor=otra')
      .expect(200);
    expect(productos.getAvailableCylinders).toHaveBeenCalledWith(
      'dist-del-admin',
    );
  });

  it('GET /gascylinder/available/list anónimo usa ?distributor=', async () => {
    await request(app.getHttpServer())
      .get('/gascylinder/available/list?distributor=demo')
      .expect(200);
    expect(productos.getAvailableCylinders).toHaveBeenCalledWith('demo');
  });
});
