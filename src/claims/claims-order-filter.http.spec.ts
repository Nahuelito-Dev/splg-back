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
import { RedisService } from '../redis/redis.service';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';

const PEDIDO = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
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
    req.distributorId = rol === RoleType.SUPER_ADMIN ? null : DIST;
    return true;
  }
}

/**
 * Matriz HTTP de `GET /claims?orderId=` (el filtro por pedido del panel): con
 * los guards reales de rol y permiso, el pipe de validación y el filtro global.
 * El servicio se simula: que el filtro llegue acotado a la distribuidora del
 * que pregunta lo prueba `claims.service.spec.ts`.
 */
describe('GET /claims?orderId: matriz HTTP', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  const claims = {
    findAll: jest.fn(),
    photoUrlFor: jest.fn().mockResolvedValue(null),
  };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [ClaimsController],
      providers: [
        { provide: ClaimsService, useValue: claims },
        // Lo pide el interceptor de idempotencia de las subidas (no se usa acá).
        { provide: RedisService, useValue: {} },
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
    permisos = ['reclamos.ver'];
    claims.findAll.mockResolvedValue([]);
  });

  const llamar = (consulta: string, rol: RoleType | null) => {
    const r = request(app.getHttpServer()).get(`/api/claims${consulta}`);
    if (rol) r.set('Authorization', 'Bearer x').set('x-rol', rol);
    return r;
  };
  const resultado = async (r: request.Test) => {
    const res = await r;
    return [res.status, (res.body as { code?: string }).code ?? null];
  };

  it('200 con orderId: filtra por ese pedido en la distribuidora del que pregunta', async () => {
    const res = await llamar(`?orderId=${PEDIDO}`, RoleType.ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(claims.findAll).toHaveBeenCalledWith(DIST, { orderId: PEDIDO });
  });

  it('200 sin orderId: todos (el contrato de siempre); también en /v1', async () => {
    expect(await resultado(llamar('', RoleType.ADMIN))).toEqual([200, null]);
    expect(claims.findAll).toHaveBeenCalledWith(DIST, { orderId: undefined });
    const v1 = await request(app.getHttpServer())
      .get(`/api/v1/claims?orderId=${PEDIDO}`)
      .set('Authorization', 'Bearer x')
      .set('x-rol', RoleType.ADMIN);
    expect(v1.status).toBe(200);
    expect(claims.findAll).toHaveBeenLastCalledWith(DIST, { orderId: PEDIDO });
  });

  it('400: orderId que no es UUID (y no llega al servicio)', async () => {
    for (const malo of ['?orderId=no-es-uuid', '?orderId=123', '?orderId=']) {
      const res = await llamar(malo, RoleType.ADMIN);
      expect(res.status).toBe(400);
    }
    expect(claims.findAll).not.toHaveBeenCalled();
  });

  it('401: sin token', async () => {
    expect(await resultado(llamar(`?orderId=${PEDIDO}`, null))).toEqual([
      401,
      null,
    ]);
  });

  it('403: rol de app o admin sin permiso de ver reclamos', async () => {
    expect(
      await resultado(llamar(`?orderId=${PEDIDO}`, RoleType.CUSTOMER)),
    ).toEqual([403, null]);
    expect(
      await resultado(llamar(`?orderId=${PEDIDO}`, RoleType.DELIVERY)),
    ).toEqual([403, null]);
    permisos = ['pedidos.ver'];
    expect(
      await resultado(llamar(`?orderId=${PEDIDO}`, RoleType.ADMIN)),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(claims.findAll).not.toHaveBeenCalled();
  });
});
