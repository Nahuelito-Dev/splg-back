import {
  INestApplication,
  ValidationPipe,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminNotificationsService } from './admin-notifications.service';

const ID = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';

describe('AdminNotificationsController (API v2)', () => {
  let app: INestApplication<Server>;
  let service: Record<string, jest.Mock>;
  let distributorId: string | null;

  beforeAll(async () => {
    service = {
      listar: jest.fn(),
      contarSinLeer: jest.fn(),
      marcarLeido: jest.fn(),
      marcarTodosLeidos: jest.fn(),
    };
    const modulo = await Test.createTestingModule({
      controllers: [AdminNotificationsController],
      providers: [{ provide: AdminNotificationsService, useValue: service }],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    // Igual que main.ts: prefijo `api` y versionado por URI.
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.distributorId = distributorId;
      req.user = {
        user_id: 'u1',
        role: RoleType.ADMIN,
      } as AuthenticatedUser as Request['user'];
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    distributorId = 'd1';
    service.listar.mockResolvedValue({ items: [], total: 0 });
    service.contarSinLeer.mockResolvedValue({ count: 4 });
    service.marcarLeido.mockResolvedValue({ id: ID });
    service.marcarTodosLeidos.mockResolvedValue({ updated: 2 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v2/admin-notifications lista con usuario y distribuidora del token y filtros convertidos', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v2/admin-notifications?unread=true&limit=5&offset=10')
      .expect(200);

    expect(res.body).toEqual({ items: [], total: 0 });
    expect(service.listar).toHaveBeenCalledWith('u1', 'd1', {
      unread: true,
      limit: 5,
      offset: 10,
    });
  });

  it('sin filtros usa 20 y 0, y unread=false llega como false', async () => {
    await request(app.getHttpServer())
      .get('/api/v2/admin-notifications')
      .expect(200);
    expect(service.listar).toHaveBeenLastCalledWith('u1', 'd1', {
      limit: 20,
      offset: 0,
    });

    await request(app.getHttpServer())
      .get('/api/v2/admin-notifications?unread=false')
      .expect(200);
    expect(service.listar).toHaveBeenLastCalledWith(
      'u1',
      'd1',
      expect.objectContaining({ unread: false }),
    );
  });

  it('el super admin sin X-Distributor consulta con distribuidora null', async () => {
    distributorId = null;

    await request(app.getHttpServer())
      .get('/api/v2/admin-notifications')
      .expect(200);

    expect(service.listar).toHaveBeenCalledWith('u1', null, expect.anything());
  });

  it('filtros inválidos son 400', async () => {
    await request(app.getHttpServer())
      .get('/api/v2/admin-notifications?unread=quizas')
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v2/admin-notifications?limit=1000')
      .expect(400);
  });

  it('la ruta sin versión no existe: el contrato es sólo v2', async () => {
    await request(app.getHttpServer())
      .get('/api/admin-notifications')
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/admin-notifications')
      .expect(404);
  });

  it('GET unread-count devuelve { count }', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v2/admin-notifications/unread-count')
      .expect(200);

    expect(res.body).toEqual({ count: 4 });
    expect(service.contarSinLeer).toHaveBeenCalledWith('u1', 'd1');
  });

  it('PATCH read-all devuelve { updated }', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v2/admin-notifications/read-all')
      .expect(200);

    expect(res.body).toEqual({ updated: 2 });
    expect(service.marcarTodosLeidos).toHaveBeenCalledWith('u1', 'd1');
    expect(service.marcarLeido).not.toHaveBeenCalled();
  });

  it('PATCH :id/read marca el aviso del usuario', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v2/admin-notifications/${ID}/read`)
      .expect(200);

    expect(service.marcarLeido).toHaveBeenCalledWith('u1', 'd1', ID);
  });

  it('PATCH :id/read con un id que no es UUID es 400', async () => {
    await request(app.getHttpServer())
      .patch('/api/v2/admin-notifications/no-es-uuid/read')
      .expect(400);
    expect(service.marcarLeido).not.toHaveBeenCalled();
  });
});
