import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  NotFoundException,
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
import { AlcanceGuard } from '../common/guards/alcance.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import {
  NotificationLogController,
  OrderNotificationsController,
} from './notification-log.controller';
import { NotificationLogService } from './notification-log.service';

const PEDIDO = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';

/** Lo que hace el `AuthGuard` real: sin token, 401; con token, el usuario del rol pedido. */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    const rol = req.headers['x-rol'] as RoleType;
    req.user = { user_id: 'u1', role: rol } as AuthenticatedUser;
    const encabezado = req.headers['x-distributor'];
    // Como el `AuthGuard` real: el super admin con sesión de soporte opera en
    // la empresa de la sesión; sin sesión, queda sin distribuidora.
    const conSesion =
      rol === RoleType.SUPER_ADMIN && typeof encabezado === 'string';
    if (conSesion) {
      req.supportSession = {
        id: 's1',
        distributorId: encabezado,
        scope: ['personal_data'],
        expiresAt: new Date(Date.now() + 60_000),
      };
    }
    req.distributorId =
      rol === RoleType.SUPER_ADMIN ? (conSesion ? encabezado : null) : 'dist-a';
    return true;
  }
}

/**
 * Matriz HTTP del registro de avisos (v3): 200, 400 por filtro inválido, 401,
 * 403 (rol y permiso) y 404 (pedido ajeno), con los guards reales de rol y
 * permiso, el pipe de validación y el filtro global. El servicio se simula: su
 * consulta se prueba aparte; acá, el código HTTP y la distribuidora que llega.
 */
describe('Registro de avisos: matriz HTTP (v3)', () => {
  let app: INestApplication<Server>;
  let permisos: string[];
  const avisos = { listar: jest.fn(), deUnPedido: jest.fn() };

  beforeAll(async () => {
    const staff = {
      deUsuario: jest.fn(() =>
        Promise.resolve({ todos: false, rol: null, permisos }),
      ),
    };
    const modulo = await Test.createTestingModule({
      controllers: [NotificationLogController, OrderNotificationsController],
      providers: [
        { provide: StaffPermissionsService, useValue: staff },
        { provide: NotificationLogService, useValue: avisos },
        Reflector,
        { provide: APP_GUARD, useClass: AuthDePrueba },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_GUARD, useClass: AlcanceGuard },
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
    permisos = ['auditoria.ver', 'pedidos.ver'];
    avisos.listar.mockReset().mockResolvedValue({
      data: [],
      total: 0,
      limit: 20,
      offset: 0,
    });
    avisos.deUnPedido.mockReset().mockResolvedValue([]);
  });

  const get = (ruta: string, rol?: RoleType, distribuidora?: string) => {
    let r = request(app.getHttpServer()).get(ruta);
    if (rol) {
      r = r.set('Authorization', 'Bearer t').set('X-Rol', rol);
    }
    if (distribuidora) r = r.set('X-Distributor', distribuidora);
    return r;
  };

  describe('GET /api/v3/notification-log', () => {
    const ruta = '/api/v3/notification-log';

    it('200: el admin ve los avisos de su distribuidora, con los filtros', async () => {
      await get(
        `${ruta}?channel=email&status=failed&type=CASH_READY&from=2026-11-01&to=2026-11-30&term=n***&orderId=${PEDIDO}&limit=5&offset=10`,
        RoleType.ADMIN,
      ).expect(200);
      expect(avisos.listar).toHaveBeenCalledWith(
        'dist-a',
        expect.objectContaining({
          channel: 'email',
          status: 'failed',
          type: 'CASH_READY',
          from: '2026-11-01',
          to: '2026-11-30',
          orderId: PEDIDO,
          limit: 5,
          offset: 10,
        }),
      );
    });

    it('200: el super admin con sesión de soporte ve sólo la empresa de la sesión', async () => {
      await get(ruta, RoleType.SUPER_ADMIN, 'dist-b').expect(200);
      expect(avisos.listar).toHaveBeenLastCalledWith(
        'dist-b',
        expect.anything(),
      );
    });

    it('403: el super admin sin sesión de soporte no tiene vista global', async () => {
      const r = await get(ruta, RoleType.SUPER_ADMIN).expect(403);
      expect(r.body).toMatchObject({ code: 'SUPPORT_SESSION_REQUIRED' });
      expect(avisos.listar).not.toHaveBeenCalled();
    });

    it('200: un admin no elige otra distribuidora con el header', async () => {
      await get(ruta, RoleType.ADMIN, 'dist-b').expect(200);
      expect(avisos.listar).toHaveBeenLastCalledWith(
        'dist-a',
        expect.anything(),
      );
    });

    it.each([
      ['channel=sms'],
      ['status=perdido'],
      ['from=ayer'],
      ['to=2026-13-45'],
      ['orderId=no-es-uuid'],
      ['limit=0'],
      ['limit=101'],
      ['offset=-1'],
      ['offset=10001'],
    ])('400: filtro inválido (%s)', async (consulta) => {
      await get(`${ruta}?${consulta}`, RoleType.ADMIN).expect(400);
      expect(avisos.listar).not.toHaveBeenCalled();
    });

    it('401: sin token', async () => {
      await get(ruta).expect(401);
    });

    it.each([RoleType.CUSTOMER, RoleType.DELIVERY])(
      '403: el rol %s no entra',
      async (rol) => {
        await get(ruta, rol).expect(403);
        expect(avisos.listar).not.toHaveBeenCalled();
      },
    );

    it('403: un admin sin el permiso de auditoría', async () => {
      permisos = ['pedidos.ver'];
      await get(ruta, RoleType.ADMIN).expect(403);
      expect(avisos.listar).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v3/orders/:id/notifications', () => {
    const ruta = `/api/v3/orders/${PEDIDO}/notifications`;

    it('200: los avisos del pedido, dentro de la distribuidora del admin', async () => {
      avisos.deUnPedido.mockResolvedValue([{ notificationLogId: 'n1' }]);
      const r = await get(ruta, RoleType.ADMIN).expect(200);
      expect(r.body).toEqual([{ notificationLogId: 'n1' }]);
      expect(avisos.deUnPedido).toHaveBeenCalledWith(PEDIDO, 'dist-a');
    });

    it('400: el id no es un UUID', async () => {
      await get('/api/v3/orders/abc/notifications', RoleType.ADMIN).expect(400);
    });

    it('401: sin token', async () => {
      await get(ruta).expect(401);
    });

    it('403: un cliente no ve los avisos del pedido', async () => {
      await get(ruta, RoleType.CUSTOMER).expect(403);
    });

    it('403: un admin con permiso de pedidos pero sin el de auditoría', async () => {
      permisos = ['pedidos.ver'];
      await get(ruta, RoleType.ADMIN).expect(403);
      expect(avisos.deUnPedido).not.toHaveBeenCalled();
    });

    it('200: el super admin con sesión ve los del pedido de la empresa de la sesión', async () => {
      await get(ruta, RoleType.SUPER_ADMIN, 'dist-b').expect(200);
      expect(avisos.deUnPedido).toHaveBeenCalledWith(PEDIDO, 'dist-b');
    });

    it('403: el super admin sin sesión de soporte', async () => {
      await get(ruta, RoleType.SUPER_ADMIN).expect(403);
      expect(avisos.deUnPedido).not.toHaveBeenCalled();
    });

    it('404: pedido de otra distribuidora o inexistente', async () => {
      avisos.deUnPedido.mockRejectedValue(
        new NotFoundException('Pedido no encontrado'),
      );
      await get(ruta, RoleType.ADMIN).expect(404);
    });
  });
});
