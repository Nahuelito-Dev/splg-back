import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { RoleType } from '../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { conCodigo } from '../../common/errors/con-codigo';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { crearValidationPipe } from '../../common/validation/validation-pipe';
import { ProcessRunController } from '../../process-run/process-run.controller';
import { ProcessRunService } from '../../process-run/process-run.service';
import { TrazasController } from './trazas.controller';
import { TrazasService } from './trazas.service';

const RUN = '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b';

/** Lo que hace el `AuthGuard` real: sin token, 401; con token, el usuario del rol pedido. */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    const rol = req.headers['x-rol'] as RoleType;
    req.user = { user_id: 'u1', role: rol } as AuthenticatedUser;
    req.distributorId =
      rol === RoleType.SUPER_ADMIN
        ? null
        : (req.headers['x-distributor'] as string);
    return true;
  }
}

/**
 * Matriz HTTP de los dos endpoints de O1 (DISENO-OBSERVABILIDAD §7.1 y §7.5):
 * 200, 400, 401, 403 (admin de una empresa, chofer, cliente) y 404, con el
 * guard de roles real y el filtro global (los `code`).
 */
describe('Endpoints del monitor O1: GET /v2/process-runs/:runId y GET /v2/platform/traces/:traceId', () => {
  let app: INestApplication<Server>;
  const procesos = {
    detalle: jest.fn(),
    resumen: jest.fn(),
    listar: jest.fn(),
  };
  const trazas = { traza: jest.fn() };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [ProcessRunController, TrazasController],
      providers: [
        { provide: ProcessRunService, useValue: procesos },
        { provide: TrazasService, useValue: trazas },
        { provide: APP_GUARD, useClass: AuthDePrueba },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.use((_req: Request, _res: Response, next: NextFunction) => next());
    app.useGlobalFilters(new GlobalExceptionFilter(app.getHttpAdapter()));
    app.useGlobalPipes(crearValidationPipe());
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    procesos.detalle.mockResolvedValue({ id: RUN, traceId: 'prueba-o1' });
    trazas.traza.mockResolvedValue({ traceId: 'prueba-o1', items: [] });
  });

  const get = (ruta: string, rol: RoleType | null, tenant?: string) => {
    const r = request(app.getHttpServer()).get(`/api/v2${ruta}`);
    if (rol) r.set('Authorization', 'Bearer x').set('x-rol', rol);
    if (tenant) r.set('x-distributor', tenant);
    return r;
  };

  describe('GET /v2/process-runs/:runId', () => {
    it('200: el super admin ve el detalle', async () => {
      const r = await get(`/process-runs/${RUN}`, RoleType.SUPER_ADMIN).expect(
        200,
      );
      expect(r.body).toEqual({ id: RUN, traceId: 'prueba-o1' });
      expect(procesos.detalle).toHaveBeenCalledWith(RUN);
    });

    it('400 INVALID_ID: el id no es un UUID', async () => {
      const r = await get(
        '/process-runs/no-es-uuid',
        RoleType.SUPER_ADMIN,
      ).expect(400);
      expect(r.body).toMatchObject({ code: 'INVALID_ID' });
      expect(procesos.detalle).not.toHaveBeenCalled();
    });

    it('401: sin token', async () => {
      await get(`/process-runs/${RUN}`, null).expect(401);
      expect(procesos.detalle).not.toHaveBeenCalled();
    });

    it.each([RoleType.ADMIN, RoleType.DELIVERY, RoleType.CUSTOMER])(
      '403: %s (aun de su propia empresa) no ve corridas',
      async (rol) => {
        await get(`/process-runs/${RUN}`, rol, 'empresa-a').expect(403);
        expect(procesos.detalle).not.toHaveBeenCalled();
      },
    );

    it('404 PROCESS_RUN_NOT_FOUND: no existe', async () => {
      procesos.detalle.mockRejectedValue(
        conCodigo(
          NotFoundException,
          404,
          'No existe esa corrida',
          'PROCESS_RUN_NOT_FOUND',
        ),
      );
      const r = await get(`/process-runs/${RUN}`, RoleType.SUPER_ADMIN).expect(
        404,
      );
      expect(r.body).toMatchObject({ code: 'PROCESS_RUN_NOT_FOUND' });
    });

    it('summary no cae en :runId', async () => {
      procesos.resumen.mockResolvedValue({
        items: [],
        alerts: 0,
        generatedAt: new Date(),
      });
      await get('/process-runs/summary', RoleType.SUPER_ADMIN).expect(200);
      expect(procesos.detalle).not.toHaveBeenCalled();
      expect(procesos.resumen).toHaveBeenCalled();
    });
  });

  describe('GET /v2/platform/traces/:traceId', () => {
    it.each(['prueba-o1', RUN, 'A_b-9', 'a'.repeat(64)])(
      '200: el super admin abre la traza %s',
      async (id) => {
        await get(`/platform/traces/${id}`, RoleType.SUPER_ADMIN).expect(200);
        expect(trazas.traza).toHaveBeenCalledWith(id);
      },
    );

    it.each([
      ['más de 64 caracteres', 'a'.repeat(65)],
      ['un punto', 'a.b'],
      ['un espacio', 'a%20b'],
      ['un acento', 'traza-%C3%B1'],
      ['comillas', '%22x%22'],
    ])('400 INVALID_TRACE_ID: con %s', async (_caso, id) => {
      const r = await get(
        `/platform/traces/${id}`,
        RoleType.SUPER_ADMIN,
      ).expect(400);
      expect(r.body).toMatchObject({
        code: 'INVALID_TRACE_ID',
        message: expect.stringMatching(/de 1 a 64 caracteres/) as unknown,
      });
      expect(trazas.traza).not.toHaveBeenCalled();
    });

    it('401: sin token', async () => {
      await get('/platform/traces/prueba-o1', null).expect(401);
      expect(trazas.traza).not.toHaveBeenCalled();
    });

    it.each([RoleType.ADMIN, RoleType.DELIVERY, RoleType.CUSTOMER])(
      '403 (otra distribuidora): %s de la empresa A no abre trazas',
      async (rol) => {
        await get('/platform/traces/prueba-o1', rol, 'empresa-a').expect(403);
        expect(trazas.traza).not.toHaveBeenCalled();
      },
    );

    it('404 TRACE_NOT_FOUND: no hay nada con esa traza', async () => {
      trazas.traza.mockRejectedValue(
        conCodigo(NotFoundException, 404, 'No hay nada', 'TRACE_NOT_FOUND'),
      );
      const r = await get(
        '/platform/traces/inexistente',
        RoleType.SUPER_ADMIN,
      ).expect(404);
      expect(r.body).toMatchObject({ code: 'TRACE_NOT_FOUND' });
    });
  });
});
