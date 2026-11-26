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
import { PermissionGuard } from '../../admin/guards/permission.guard';
import { StaffPermissionsService } from '../../admin/staff-permissions.service';
import { RoleType } from '../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import { RolesGuard } from '../../common/guards/roles.guard';
import { crearValidationPipe } from '../../common/validation/validation-pipe';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import { ModuloGuard } from '../../platform/access/modulo.guard';
import { ServiceTimeService } from '../application/service-time.service';
import { RoutePlanningV3Controller } from './route-planning-v3.controller';

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

const ESTADO = {
  mode: 'fixed' as const,
  fixedMinutes: 10,
  suggestedMinutes: 8,
  p90Minutes: 14.5,
  effectiveMinutes: 10,
  samples: 42,
  minSamples: 20,
  windowDays: 30,
  computedAt: new Date('2026-11-25T06:15:00.000Z'),
};

/**
 * Matriz HTTP de `GET /v3/route-planning/service-time` y
 * `PATCH /v3/route-planning/settings`, con los guards reales de rol, permiso y
 * módulo, el pipe de validación y el filtro global. Los servicios se simulan.
 */
describe('v3 de la hoja de ruta: tiempo de atención y parámetros (matriz HTTP)', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  let hojaDeRutaEncendida: boolean;
  const serviceTime = { estado: jest.fn() };
  const processConfig = { obtener: jest.fn(), guardar: jest.fn() };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [RoutePlanningV3Controller],
      providers: [
        { provide: ServiceTimeService, useValue: serviceTime },
        { provide: ProcessConfigService, useValue: processConfig },
        {
          provide: StaffPermissionsService,
          useValue: {
            deUsuario: jest.fn(() =>
              Promise.resolve({ todos: false, rol: null, permisos }),
            ),
          },
        },
        {
          provide: AccesoDeLaEmpresa,
          useValue: {
            habilitado: jest.fn((_d: string, m: string) =>
              Promise.resolve(m !== 'route_planning' || hojaDeRutaEncendida),
            ),
          },
        },
        Reflector,
        { provide: APP_GUARD, useClass: AuthDePrueba },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_GUARD, useClass: ModuloGuard },
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
    permisos = ['despacho.gestionar'];
    hojaDeRutaEncendida = true;
    serviceTime.estado.mockResolvedValue(ESTADO);
    processConfig.obtener.mockResolvedValue({
      serviceMinutes: 10,
      serviceMinutesMode: 0,
      enabled: 1,
    });
    processConfig.guardar.mockResolvedValue({ params: {} });
  });

  const llamar = (
    metodo: 'get' | 'patch',
    ruta: string,
    rol: RoleType | null,
    extra: Record<string, string> = {},
  ) => {
    const r = request(app.getHttpServer())[metodo](
      `/api/v3/route-planning/${ruta}`,
    );
    if (rol) r.set('Authorization', 'Bearer x').set('x-rol', rol);
    for (const [k, v] of Object.entries(extra)) r.set(k, v);
    return r;
  };
  const resultado = async (r: request.Test) => {
    const res = await r;
    return [res.status, (res.body as { code?: string }).code ?? null];
  };

  describe('GET service-time', () => {
    it('200: sugerido, vigente, muestras y fecha de la distribuidora del admin', async () => {
      const res = await llamar('get', 'service-time', RoleType.ADMIN);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ...ESTADO,
        computedAt: '2026-11-25T06:15:00.000Z',
      });
      expect(serviceTime.estado).toHaveBeenCalledWith(DIST);
    });

    it('200: sin cálculo todavía, la fecha es null', async () => {
      serviceTime.estado.mockResolvedValue({
        ...ESTADO,
        suggestedMinutes: null,
        samples: 0,
        computedAt: null,
      });
      const res = await llamar('get', 'service-time', RoleType.ADMIN);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        computedAt: null,
        suggestedMinutes: null,
      });
    });

    it('400: super admin sin X-Distributor', async () => {
      expect(
        await resultado(llamar('get', 'service-time', RoleType.SUPER_ADMIN)),
      ).toEqual([400, 'MISSING_DISTRIBUTOR']);
    });

    it('401: sin token', async () => {
      expect(await resultado(llamar('get', 'service-time', null))).toEqual([
        401,
        null,
      ]);
      expect(serviceTime.estado).not.toHaveBeenCalled();
    });

    it('403: rol de app, admin sin permiso de despacho y hoja de ruta apagada', async () => {
      expect(
        await resultado(llamar('get', 'service-time', RoleType.DELIVERY)),
      ).toEqual([403, null]);
      permisos = ['pedidos.ver'];
      expect(
        await resultado(llamar('get', 'service-time', RoleType.ADMIN)),
      ).toEqual([403, 'PERMISSION_DENIED']);
      permisos = ['despacho.gestionar'];
      hojaDeRutaEncendida = false;
      expect(
        await resultado(llamar('get', 'service-time', RoleType.ADMIN)),
      ).toEqual([403, 'MODULE_DISABLED']);
      expect(serviceTime.estado).not.toHaveBeenCalled();
    });

    it('403 otra empresa: un admin con el X-Distributor de otra recibe sólo lo suyo', async () => {
      await llamar('get', 'service-time', RoleType.ADMIN, {
        'x-distributor': 'dist-b',
      });
      expect(serviceTime.estado).toHaveBeenCalledWith(DIST);
      expect(serviceTime.estado).not.toHaveBeenCalledWith('dist-b');
    });
  });

  describe('PATCH settings', () => {
    it('200: el modo learned se guarda como 1 y el resto de los parámetros se conserva', async () => {
      const res = await llamar('patch', 'settings', RoleType.ADMIN).send({
        serviceMinutesMode: 'learned',
        trafficFactor: 1.5,
      });
      expect(res.status).toBe(200);
      expect(processConfig.guardar).toHaveBeenCalledWith(
        DIST,
        ConfigurableProcess.ROUTE_PLANNING,
        {
          serviceMinutes: 10,
          serviceMinutesMode: 1,
          enabled: 1,
          trafficFactor: 1.5,
        },
        'u1',
      );
    });

    it('200: volver a fixed lo guarda como 0', async () => {
      processConfig.obtener.mockResolvedValue({ serviceMinutesMode: 1 });
      await llamar('patch', 'settings', RoleType.ADMIN).send({
        serviceMinutesMode: 'fixed',
      });
      expect(processConfig.guardar).toHaveBeenCalledWith(
        DIST,
        ConfigurableProcess.ROUTE_PLANNING,
        { serviceMinutesMode: 0 },
        'u1',
      );
    });

    it('200: sin el modo no lo toca', async () => {
      await llamar('patch', 'settings', RoleType.ADMIN).send({
        serviceMinutes: 12,
      });
      expect(processConfig.guardar).toHaveBeenCalledWith(
        DIST,
        ConfigurableProcess.ROUTE_PLANNING,
        { serviceMinutes: 12, serviceMinutesMode: 0, enabled: 1 },
        'u1',
      );
    });

    it('400: modo inválido, o un valor de la v2 fuera de rango', async () => {
      const malo = await llamar('patch', 'settings', RoleType.ADMIN).send({
        serviceMinutesMode: 'auto',
      });
      expect(malo.status).toBe(400);
      expect(JSON.stringify(malo.body)).toContain('«fixed» (fijo)');
      expect(
        (
          await llamar('patch', 'settings', RoleType.ADMIN).send({
            serviceMinutes: 99,
          })
        ).status,
      ).toBe(400);
      expect(processConfig.guardar).not.toHaveBeenCalled();
    });

    it('400: super admin sin X-Distributor', async () => {
      expect(
        await resultado(
          llamar('patch', 'settings', RoleType.SUPER_ADMIN).send({
            serviceMinutesMode: 'fixed',
          }),
        ),
      ).toEqual([400, 'MISSING_DISTRIBUTOR']);
    });

    it('401: sin token', async () => {
      expect(
        await resultado(
          llamar('patch', 'settings', null).send({
            serviceMinutesMode: 'fixed',
          }),
        ),
      ).toEqual([401, null]);
    });

    it('403: rol de app y admin sin permiso de despacho', async () => {
      expect(
        await resultado(
          llamar('patch', 'settings', RoleType.CUSTOMER).send({
            serviceMinutesMode: 'learned',
          }),
        ),
      ).toEqual([403, null]);
      permisos = ['pedidos.ver'];
      expect(
        await resultado(
          llamar('patch', 'settings', RoleType.ADMIN).send({
            serviceMinutesMode: 'learned',
          }),
        ),
      ).toEqual([403, 'PERMISSION_DENIED']);
      expect(processConfig.guardar).not.toHaveBeenCalled();
    });

    it('403 otra empresa: un admin guarda siempre en la suya', async () => {
      await llamar('patch', 'settings', RoleType.ADMIN, {
        'x-distributor': 'dist-b',
      }).send({ serviceMinutesMode: 'learned' });
      expect(processConfig.guardar).toHaveBeenCalledWith(
        DIST,
        expect.anything(),
        expect.anything(),
        'u1',
      );
    });
  });
});
