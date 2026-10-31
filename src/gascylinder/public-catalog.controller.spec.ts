import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'http';
import { Repository } from 'typeorm';
import { PublicCatalogController } from './public-catalog.controller';
import { GasCylinderService } from './gascylinder.service';
import { GasCylinderPhotoService } from './gascylinder-photo.service';
import { GasCylinder } from './entities/gascylinder.entity';
import { DistributorService } from '../distributor/distributor.service';
import {
  Distributor,
  DistributorStatus,
} from '../distributor/entities/distributor.entity';

const garrafa = (over: Partial<GasCylinder> = {}): GasCylinder =>
  ({
    gasCylinderId: 'g1',
    distributorId: 'd1',
    type: '10kg',
    weight: 10,
    price: 5000,
    stock: 37,
    reservationDeficit: 2,
    averageUnitCost: 3100,
    description: 'Garrafa familiar',
    isActive: true,
    photoKey: 'gascylinders/d1/g1/x.jpg',
    promotions: [
      { quantity: 5, discountPercentage: 10 },
      { quantity: 2, discountPercentage: 5 },
    ],
    ...over,
  }) as GasCylinder;

describe('GET /public/distributors/:slug/catalog', () => {
  let app: INestApplication<Server>;
  let productos: { catalogoPublico: jest.Mock };

  beforeEach(async () => {
    productos = {
      catalogoPublico: jest.fn().mockResolvedValue({
        distributor: { slug: 'demo', name: 'Demo' },
        products: [garrafa(), garrafa({ gasCylinderId: 'g2', stock: 0 })],
      }),
    };
    const modulo = await Test.createTestingModule({
      controllers: [PublicCatalogController],
      providers: [
        { provide: GasCylinderService, useValue: productos },
        {
          provide: GasCylinderPhotoService,
          useValue: {
            firmar: jest.fn((gs: GasCylinder[]) => {
              gs.forEach((g) => (g.photoSignedUrl = 'https://s3/firmada'));
              return Promise.resolve();
            }),
          },
        },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
  });

  it('devuelve sólo lo que ve un visitante: sin costos ni cantidad de stock', async () => {
    const res = await request(app.getHttpServer())
      .get('/public/distributors/demo/catalog')
      .expect(200);
    const body = res.body as {
      slug: string;
      products: Record<string, unknown>[];
    };
    expect(productos.catalogoPublico).toHaveBeenCalledWith('demo');
    expect(body.slug).toBe('demo');
    expect(body.products[0]).toEqual({
      id: 'g1',
      type: '10kg',
      weight: 10,
      price: 5000,
      description: 'Garrafa familiar',
      photoUrl: 'https://s3/firmada',
      promotions: [
        { quantity: 2, discountPercentage: 5 },
        { quantity: 5, discountPercentage: 10 },
      ],
      inStock: true,
    });
    expect(body.products[1].inStock).toBe(false);
    const json = JSON.stringify(body);
    expect(json).not.toMatch(
      /"stock"|averageUnitCost|reservation|distributor_?id/i,
    );
  });

  it('un slug inexistente responde 404', async () => {
    productos.catalogoPublico.mockRejectedValue(new NotFoundException('x'));
    await request(app.getHttpServer())
      .get('/public/distributors/nada/catalog')
      .expect(404);
  });
});

describe('GasCylinderService.catalogoPublico', () => {
  let repo: { find: jest.Mock };
  let distribuidoras: { findBySlug: jest.Mock };
  let service: GasCylinderService;

  beforeEach(() => {
    repo = { find: jest.fn().mockResolvedValue([]) };
    distribuidoras = { findBySlug: jest.fn() };
    service = new GasCylinderService(
      repo as unknown as Repository<GasCylinder>,
      distribuidoras as unknown as DistributorService,
      {} as never,
    );
  });

  it('trae los activos de ESA distribuidora', async () => {
    distribuidoras.findBySlug.mockResolvedValue({
      distributorId: 'd2',
      slug: 'gas-andino',
      status: DistributorStatus.ACTIVE,
    } as Distributor);
    await service.catalogoPublico('gas-andino');
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { distributorId: 'd2', isActive: true },
      }),
    );
  });

  it('una distribuidora no activa es 404 y no consulta productos', async () => {
    distribuidoras.findBySlug.mockResolvedValue({
      distributorId: 'd3',
      slug: 'baja',
      status: DistributorStatus.SUSPENDED,
    } as Distributor);
    await expect(service.catalogoPublico('baja')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.find).not.toHaveBeenCalled();
  });
});
