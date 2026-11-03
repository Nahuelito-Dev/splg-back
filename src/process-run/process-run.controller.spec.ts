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
import { ProcessRunController } from './process-run.controller';
import { ProcessRunService } from './process-run.service';

describe('ProcessRunController (API v2)', () => {
  let app: INestApplication<Server>;
  let service: Record<string, jest.Mock>;
  let distributorId: string | null;
  let role: RoleType;

  beforeAll(async () => {
    service = { resumen: jest.fn(), listar: jest.fn() };
    const modulo = await Test.createTestingModule({
      controllers: [ProcessRunController],
      providers: [{ provide: ProcessRunService, useValue: service }],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.distributorId = distributorId;
      req.user = {
        user_id: 'u1',
        role,
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
    role = RoleType.ADMIN;
    service.resumen.mockResolvedValue({
      items: [],
      alerts: 0,
      generatedAt: new Date(),
    });
    service.listar.mockResolvedValue({ items: [], total: 0 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET summary usa la distribuidora del contexto', async () => {
    await request(app.getHttpServer())
      .get('/api/v2/process-runs/summary')
      .expect(200);
    expect(service.resumen).toHaveBeenCalledWith('d1', false);
  });

  it('el super admin sin X-Distributor consulta con null', async () => {
    distributorId = null;
    role = RoleType.SUPER_ADMIN;
    await request(app.getHttpServer()).get('/api/v2/process-runs').expect(200);
    expect(service.listar).toHaveBeenCalledWith(null, true, expect.anything());
  });

  it('el historial pasa los filtros convertidos y los valores por omisión', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/v2/process-runs?process=fleet_alerts&status=failed&from=2026-11-01&to=2026-11-03T10:00:00Z&limit=5&offset=10',
      )
      .expect(200);
    expect(service.listar).toHaveBeenCalledWith('d1', false, {
      process: 'fleet_alerts',
      status: 'failed',
      from: '2026-11-01',
      to: '2026-11-03T10:00:00Z',
      limit: 5,
      offset: 10,
    });
    await request(app.getHttpServer()).get('/api/v2/process-runs').expect(200);
    expect(service.listar).toHaveBeenLastCalledWith('d1', false, {
      limit: 20,
      offset: 0,
    });
  });

  it.each([
    'process=inventado',
    'status=roto',
    'from=ayer',
    'to=2026-13-45',
    'limit=0',
    'limit=101',
    'offset=-1',
    'limit=abc',
    'extra=1',
  ])('el filtro inválido %s es 400', async (filtro) => {
    await request(app.getHttpServer())
      .get(`/api/v2/process-runs?${filtro}`)
      .expect(400);
    expect(service.listar).not.toHaveBeenCalled();
  });
});
