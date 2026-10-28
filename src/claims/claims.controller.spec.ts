import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Server } from 'http';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';
import { APP_GUARD } from '@nestjs/core';
import { RedisService } from '../redis/redis.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

const ID = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';

/**
 * Qué pasa con la distribuidora en `take`, `reopen` y `resolve`: un super
 * admin sin `X-Distributor` no puede operar sobre reclamos de cualquier
 * distribuidora. El guard global no corre acá; un middleware deja en la
 * request lo que el guard dejaría.
 */
describe('ClaimsController · distribuidora obligatoria', () => {
  let app: INestApplication<Server>;
  let claims: {
    take: jest.Mock;
    reopen: jest.Mock;
    resolve: jest.Mock;
    photoUrlFor: jest.Mock;
  };
  let distributorId: string | null;

  beforeEach(async () => {
    distributorId = null;
    claims = {
      take: jest.fn().mockResolvedValue({}),
      reopen: jest.fn().mockResolvedValue({}),
      resolve: jest.fn().mockResolvedValue({}),
      photoUrlFor: jest.fn().mockResolvedValue(null),
    };
    const modulo = await Test.createTestingModule({
      controllers: [ClaimsController],
      providers: [
        { provide: ClaimsService, useValue: claims },
        { provide: RedisService, useValue: {} },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.distributorId = distributorId;
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

  const llamadas: Array<[string, string, object]> = [
    ['take', `/claims/${ID}/take`, {}],
    ['reopen', `/claims/${ID}/reopen`, { reason: 'motivo' }],
    [
      'resolve',
      `/claims/${ID}/resolve`,
      { resolution: 'listo', status: 'resolved' },
    ],
  ];

  it.each(llamadas)(
    '%s: 400 si no hay distribuidora en contexto, y no toca el reclamo',
    async (metodo, ruta, cuerpo) => {
      const res = await request(app.getHttpServer()).patch(ruta).send(cuerpo);
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toMatch(
        /Falta la distribuidora/,
      );
      expect(claims[metodo as 'take']).not.toHaveBeenCalled();
    },
  );

  it.each(llamadas)(
    '%s: con distribuidora acota por ella',
    async (metodo, ruta, cuerpo) => {
      distributorId = 'd1';
      const res = await request(app.getHttpServer()).patch(ruta).send(cuerpo);
      expect(res.status).toBe(200);
      const argumentos = claims[metodo as 'take'].mock.calls[0] as unknown[];
      expect(argumentos.at(-1)).toBe('d1');
    },
  );

  it('resolve y reopen rechazan un texto de sólo espacios (400)', async () => {
    distributorId = 'd1';
    const a = await request(app.getHttpServer())
      .patch(`/claims/${ID}/resolve`)
      .send({ resolution: '   ', status: 'resolved' });
    const b = await request(app.getHttpServer())
      .patch(`/claims/${ID}/reopen`)
      .send({ reason: '  \t ' });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(claims.resolve).not.toHaveBeenCalled();
    expect(claims.reopen).not.toHaveBeenCalled();
  });

  it('resolve guarda el texto recortado', async () => {
    distributorId = 'd1';
    await request(app.getHttpServer())
      .patch(`/claims/${ID}/resolve`)
      .send({ resolution: '  se cambió  ', status: 'rejected' })
      .expect(200);
    expect(claims.resolve).toHaveBeenCalledWith(
      ID,
      'se cambió',
      'rejected',
      'd1',
    );
  });

  it('resolve no acepta in_process: tomar el reclamo es PATCH /take', async () => {
    distributorId = 'd1';
    await request(app.getHttpServer())
      .patch(`/claims/${ID}/resolve`)
      .send({ resolution: 'ok', status: 'in_process' })
      .expect(400);
  });
});

/**
 * `GET /claims/mine`: el cliente ve sus reclamos; ningún otro rol entra. El
 * guard de autenticación no corre acá: un middleware deja el usuario y el
 * tenant que dejaría, y se registra el `RolesGuard` real.
 */
describe('ClaimsController · mis reclamos', () => {
  let app: INestApplication<Server>;
  let claims: { findMine: jest.Mock; photoUrlFor: jest.Mock };
  let usuario: AuthenticatedUser;
  let distributorId: string | null;

  const reclamo = {
    claimId: 'c1',
    orderId: 'o1',
    customerId: 'u1',
    distributorId: 'd1',
    reason: 'Fuga',
    description: 'Pierde gas',
    status: 'pending',
    photoUrl: null,
    resolutionNote: null,
    createdAt: new Date('2026-10-01T10:00:00Z'),
    order: {
      orderId: 'o1',
      status: 'delivered',
      totalAmount: 14900,
      createdAt: new Date('2026-09-30T10:00:00Z'),
      scheduledDate: null,
      customerId: 'u1',
      deliveryId: 'interno',
    },
  };

  beforeEach(async () => {
    usuario = { user_id: 'u1', email: 'c@splg.com', role: RoleType.CUSTOMER };
    distributorId = 'd1';
    claims = {
      findMine: jest.fn().mockResolvedValue([[reclamo], 3]),
      photoUrlFor: jest.fn().mockResolvedValue(null),
    };
    const modulo = await Test.createTestingModule({
      controllers: [ClaimsController],
      providers: [
        { provide: ClaimsService, useValue: claims },
        { provide: RedisService, useValue: {} },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = usuario;
      req.distributorId = distributorId;
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

  it('devuelve los del usuario autenticado, paginados, con el total en la cabecera', async () => {
    const res = await request(app.getHttpServer()).get(
      '/claims/mine?limit=5&offset=5',
    );
    expect(res.status).toBe(200);
    expect(res.headers['x-total-count']).toBe('3');
    expect(res.body).toEqual([
      {
        claimId: 'c1',
        status: 'pending',
        reason: 'Fuga',
        description: 'Pierde gas',
        createdAt: '2026-10-01T10:00:00.000Z',
        order: {
          orderId: 'o1',
          status: 'delivered',
          totalAmount: 14900,
          createdAt: '2026-09-30T10:00:00.000Z',
          scheduledDate: null,
        },
        photoUrl: null,
        resolutionNote: null,
      },
    ]);
    expect(claims.findMine).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ limit: 5, offset: 5 }),
      'd1',
    );
  });

  it('acota por la distribuidora de la request: sin ella, pasa null', async () => {
    distributorId = null;
    await request(app.getHttpServer()).get('/claims/mine').expect(200);
    expect(claims.findMine).toHaveBeenCalledWith('u1', expect.anything(), null);
  });

  it.each([RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY])(
    'el rol %s no entra (403)',
    async (role) => {
      usuario = { ...usuario, role };
      await request(app.getHttpServer()).get('/claims/mine').expect(403);
      expect(claims.findMine).not.toHaveBeenCalled();
    },
  );

  it('rechaza una paginación inválida (400)', async () => {
    await request(app.getHttpServer())
      .get('/claims/mine?limit=1000')
      .expect(400);
  });
});
