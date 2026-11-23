import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { PermissionGuard } from '../admin/guards/permission.guard';
import { StaffPermissionsService } from '../admin/staff-permissions.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { RolesGuard } from '../common/guards/roles.guard';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import { LiveFleetController } from './live-fleet.controller';
import { LiveFleetService } from './live-fleet.service';

const DIST = 'dist-a';

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
        ? ((req.headers['x-distributor'] as string | undefined) ?? null)
        : DIST;
    return true;
  }
}

/**
 * Matriz HTTP de `GET /v2/tracking/vehicles` con los guards reales de rol y
 * permiso y el filtro global. El servicio se simula (su armado se prueba en
 * `live-fleet.service.spec.ts`). No hay 404: es un listado, y lo de otra
 * distribuidora simplemente no viene.
 */
describe('GET /v2/tracking/vehicles: matriz HTTP', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  const liveFleet = { vehiculos: jest.fn() };
  const RESPUESTA = { generatedAt: '2026-11-21T12:00:00.000Z', vehicles: [] };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [LiveFleetController],
      providers: [
        { provide: LiveFleetService, useValue: liveFleet },
        {
          provide: StaffPermissionsService,
          useValue: {
            deUsuario: jest.fn(() =>
              Promise.resolve({ todos: false, rol: null, permisos }),
            ),
          },
        },
        Reflector,
        { provide: APP_GUARD, useClass: AuthDePrueba },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    app.useGlobalFilters(new GlobalExceptionFilter(app.getHttpAdapter()));
    app.useGlobalPipes(crearValidationPipe());
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    permisos = ['pedidos.ver'];
    liveFleet.vehiculos.mockResolvedValue(RESPUESTA);
  });

  const llamar = (rol: RoleType | null, extra: Record<string, string> = {}) => {
    const r = request(app.getHttpServer()).get('/api/v2/tracking/vehicles');
    if (rol) r.set('Authorization', 'Bearer x').set('x-rol', rol);
    for (const [k, v] of Object.entries(extra)) r.set(k, v);
    return r;
  };
  const resultado = async (r: request.Test) => {
    const res = await r;
    return [res.status, (res.body as { code?: string }).code ?? null];
  };

  it('200: el admin que ve pedidos recibe los vehículos de su distribuidora', async () => {
    const res = await llamar(RoleType.ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RESPUESTA);
    expect(liveFleet.vehiculos).toHaveBeenCalledWith(DIST);
  });

  it('200: también alcanza con el permiso de despacho', async () => {
    permisos = ['despacho.gestionar'];
    expect(await resultado(llamar(RoleType.ADMIN))).toEqual([200, null]);
  });

  it('200: el super admin con X-Distributor (la del header, nunca otra)', async () => {
    expect(
      await resultado(
        llamar(RoleType.SUPER_ADMIN, { 'x-distributor': 'dist-b' }),
      ),
    ).toEqual([200, null]);
    expect(liveFleet.vehiculos).toHaveBeenCalledWith('dist-b');
  });

  it('400: super admin sin distribuidora', async () => {
    expect(await resultado(llamar(RoleType.SUPER_ADMIN))).toEqual([
      400,
      'MISSING_DISTRIBUTOR',
    ]);
    expect(liveFleet.vehiculos).not.toHaveBeenCalled();
  });

  it('401: sin token', async () => {
    expect(await resultado(llamar(null))).toEqual([401, null]);
    expect(liveFleet.vehiculos).not.toHaveBeenCalled();
  });

  it('403: rol de app, o admin sin permiso de pedidos ni de despacho', async () => {
    expect(await resultado(llamar(RoleType.DELIVERY))).toEqual([403, null]);
    expect(await resultado(llamar(RoleType.CUSTOMER))).toEqual([403, null]);
    permisos = ['flota.ver'];
    expect(await resultado(llamar(RoleType.ADMIN))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect(liveFleet.vehiculos).not.toHaveBeenCalled();
  });
});
