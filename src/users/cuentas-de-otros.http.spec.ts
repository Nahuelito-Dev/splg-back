import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  NotFoundException,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { PermissionGuard } from '../admin/guards/permission.guard';
import {
  StaffPermissionsService,
  type PermisosDelUsuario,
} from '../admin/staff-permissions.service';
import { StaffRoleService } from '../admin/staff-role.service';
import { Admin } from '../admin/entities/admin.entity';
import { StaffRole } from '../admin/entities/staff-role.entity';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { RolesGuard } from '../common/guards/roles.guard';
import { AutoridadSobreCuentas } from '../common/permisos/autoridad-sobre-cuentas';
import { PERMISOS, type Permiso } from '../common/permisos/catalogo';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import { EmployeeAccountController } from '../registro/employee-account.controller';
import { GrantEmployeeAccountUseCase } from '../registro/grant-employee-account.use-case';
import { EmployeePhotoService } from '../employee/employee-photo.service';
import { UsersController } from './users.controller';
import { CustomersController } from '../customer/customer.controller';
import { CustomersService } from '../customer/customer.service';
import { UsersService } from './users.service';
import { UserPhotoService } from './user-photo.service';

const D = '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11';
const YO = '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20';
const ADMIN_ALTO = '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b';
const ADMIN_BAJO = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ADMIN_SISTEMA = '11111111-2222-4333-8444-555555555555';
const CHOFER = '22222222-3333-4444-8555-666666666666';
const AJENO = '33333333-4444-4555-8666-777777777777';
const EMPLEADO = '44444444-5555-4666-8777-888888888888';
const CLIENTE = '55555555-6666-4777-8888-999999999999';

/** Los roles del personal de los admins destino. */
const ROLES: Record<string, StaffRole> = {
  'r-alto': {
    staffRoleId: 'r-alto',
    permissions: ['administradores.gestionar', 'caja.anular'],
    isSystem: false,
  } as StaffRole,
  'r-bajo': {
    staffRoleId: 'r-bajo',
    permissions: ['pedidos.ver'],
    isSystem: false,
  } as StaffRole,
  'r-sistema': {
    staffRoleId: 'r-sistema',
    permissions: [] as string[],
    isSystem: true,
  } as StaffRole,
};
const PERFILES: Record<string, Partial<Admin>> = {
  [ADMIN_ALTO]: { userId: ADMIN_ALTO, distributorId: D, staffRoleId: 'r-alto' },
  [ADMIN_BAJO]: { userId: ADMIN_BAJO, distributorId: D, staffRoleId: 'r-bajo' },
  [ADMIN_SISTEMA]: {
    userId: ADMIN_SISTEMA,
    distributorId: D,
    staffRoleId: 'r-sistema',
  },
};
const TIPOS: Record<string, RoleType> = {
  [ADMIN_ALTO]: RoleType.ADMIN,
  [ADMIN_BAJO]: RoleType.ADMIN,
  [ADMIN_SISTEMA]: RoleType.ADMIN,
  [CHOFER]: RoleType.DELIVERY,
  [AJENO]: RoleType.ADMIN,
  [YO]: RoleType.ADMIN,
};

/** Los permisos del admin que pide (`x-permisos`, o `x-todos` para el rol de sistema). */
let delActor: PermisosDelUsuario;

/** El `AuthGuard` reducido a headers: sin token 401; el rol sale de `x-rol`. */
class AuthDePrueba implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException('Sin token o token inválido');
    }
    const permisos = String(req.headers['x-permisos'] ?? '')
      .split(',')
      .filter(Boolean) as Permiso[];
    // Como `StaffPermissionsService`: el rol de sistema trae la lista entera.
    const todos = req.headers['x-todos'] === 'si';
    delActor = { todos, rol: null, permisos: todos ? [...PERMISOS] : permisos };
    req.user = {
      user_id: YO,
      email: 'yo@splg.com',
      role: req.headers['x-rol'] as RoleType,
      distributor_id: D,
    } as AuthenticatedUser;
    req.distributorId = D;
    return true;
  }
}

/**
 * Matriz HTTP de la regla sobre cuentas de otros (17/11): nadie sube ni baja a
 * quien tiene más permisos. Guards reales de rol y de permiso, el
 * `StaffRoleService` real detrás del puerto (con una base falsa: perfiles y
 * roles de los admins destino), el pipe de validación y el filtro global.
 */
describe('Cuentas de otros: matriz HTTP (PATCH/DELETE /users/:id, /block, CU-182)', () => {
  let app: INestApplication<Server>;
  const users = {
    findAlcance: jest.fn((id: string) =>
      Promise.resolve({ rol: TIPOS[id], distributorId: D }),
    ),
    perteneceA: jest.fn((id: string) => Promise.resolve(id !== AJENO)),
    update: jest.fn((id: string) =>
      Promise.resolve({ userId: id, blocked: false }),
    ),
    remove: jest.fn(() => Promise.resolve({ message: 'Usuario dado de baja' })),
    toggleBlockUser: jest.fn((id: string, block: boolean) =>
      Promise.resolve({
        id,
        email: null,
        isBlocked: block,
        message: 'Usuario bloqueado',
      }),
    ),
  };
  // Si el guard deja pasar, el servicio contesta 404: así se distingue del 403.
  const clientes = {
    assertDeLaDistribuidora: jest.fn(() => Promise.resolve()),
    update: jest.fn(() =>
      Promise.reject(new NotFoundException('Cliente no encontrado')),
    ),
    updateLocation: jest.fn(() =>
      Promise.reject(new NotFoundException('Cliente no encontrado')),
    ),
  };
  const grant = {
    // Si el guard la deja pasar, el caso de uso contesta 409 (ya tiene cuenta).
    execute: jest.fn(() =>
      Promise.reject(
        new ConflictException('El empleado ya tiene una cuenta de acceso'),
      ),
    ),
  };

  const permisos = {
    deUsuario: jest.fn(
      (
        _userId: string,
        role: RoleType,
        _manager?: EntityManager,
        propia = false,
      ): Promise<PermisosDelUsuario> =>
        Promise.resolve(
          role === RoleType.SUPER_ADMIN || propia
            ? { todos: true, rol: null, permisos: [] }
            : delActor,
        ),
    ),
  };
  const manager = {
    getRepository: (clase: unknown) => ({
      findOne: (opciones: {
        where: { userId?: string; staffRoleId?: string };
      }) =>
        Promise.resolve(
          clase === Admin
            ? (PERFILES[opciones.where.userId ?? ''] ?? null)
            : (ROLES[opciones.where.staffRoleId ?? ''] ?? null),
        ),
    }),
  } as unknown as EntityManager;
  const roles = new StaffRoleService(
    {} as Repository<StaffRole>,
    { manager } as unknown as DataSource,
    permisos as unknown as StaffPermissionsService,
    { emit: () => true } as unknown as EventEmitter2,
  );

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [
        UsersController,
        EmployeeAccountController,
        CustomersController,
      ],
      providers: [
        { provide: UsersService, useValue: users },
        {
          provide: UserPhotoService,
          useValue: { firmar: () => Promise.resolve() },
        },
        { provide: AutoridadSobreCuentas, useValue: roles },
        { provide: StaffPermissionsService, useValue: permisos },
        { provide: GrantEmployeeAccountUseCase, useValue: grant },
        { provide: EmployeePhotoService, useValue: {} },
        { provide: CustomersService, useValue: clientes },
        Reflector,
        { provide: APP_GUARD, useClass: AuthDePrueba },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>();
    app.useGlobalFilters(new GlobalExceptionFilter(app.getHttpAdapter()));
    app.useGlobalPipes(crearValidationPipe());
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  const como = (
    rol: RoleType,
    permisosDelActor: Permiso[] | 'todos' = [],
  ): Record<string, string> => ({
    authorization: 'Bearer x',
    'x-rol': rol,
    ...(permisosDelActor === 'todos'
      ? { 'x-todos': 'si' }
      : { 'x-permisos': permisosDelActor.join(',') }),
  });
  const http = () => request(app.getHttpServer());
  const cuerpoDe = (res: { body: unknown }) =>
    res.body as Record<string, unknown>;

  describe('PATCH /users/:id', () => {
    it('sin token, 401', async () => {
      await http().patch(`/users/${ADMIN_BAJO}`).send({}).expect(401);
    });

    it('un id que no es UUID, 400', async () => {
      await http()
        .patch('/users/no-es-uuid')
        .set(como(RoleType.ADMIN, 'todos'))
        .send({ full_name: 'Ana' })
        .expect(400);
    });

    it('la contraseña de otro admin: 403 ADMIN_PASSWORD_NOT_CHANGEABLE aunque quien pide tenga todos los permisos', async () => {
      const body = cuerpoDe(
        await http()
          .patch(`/users/${ADMIN_BAJO}`)
          .set(como(RoleType.ADMIN, 'todos'))
          .send({ password: 'NuevaClave1' })
          .expect(403),
      );
      expect(body).toMatchObject({ code: 'ADMIN_PASSWORD_NOT_CHANGEABLE' });
      expect(users.update).not.toHaveBeenCalled();
    });

    it('el super admin sí la cambia', async () => {
      await http()
        .patch(`/users/${ADMIN_BAJO}`)
        .set(como(RoleType.SUPER_ADMIN))
        .send({ password: 'NuevaClave1' })
        .expect(200);
      // Sin regla que repetir en la transacción: el super admin pasa siempre.
      expect(users.update).toHaveBeenCalledWith(
        ADMIN_BAJO,
        { password: 'NuevaClave1' },
        undefined,
      );
    });

    it('nombre de un admin con un permiso que quien pide no tiene: 403 STAFF_ROLE_TARGET_OUTRANKS; de uno que cubre: 200', async () => {
      const actor = como(RoleType.ADMIN, [
        'administradores.gestionar',
        'pedidos.ver',
      ]);
      const body = cuerpoDe(
        await http()
          .patch(`/users/${ADMIN_ALTO}`)
          .set(actor)
          .send({ full_name: 'Ana' })
          .expect(403),
      );
      expect(body).toMatchObject({ code: 'STAFF_ROLE_TARGET_OUTRANKS' });
      expect(String(body.message)).toContain('«caja.anular»');
      expect(users.update).not.toHaveBeenCalled();
      await http()
        .patch(`/users/${ADMIN_BAJO}`)
        .set(actor)
        .send({ full_name: 'Ana' })
        .expect(200);
    });

    it('un admin sin administradores.gestionar no edita a otro admin (403 PERMISSION_DENIED)', async () => {
      const body = cuerpoDe(
        await http()
          .patch(`/users/${ADMIN_BAJO}`)
          .set(como(RoleType.ADMIN, ['pedidos.ver', 'personal.gestionar']))
          .send({ full_name: 'Ana' })
          .expect(403),
      );
      expect(body).toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it('un chofer pide personal.gestionar (también para su contraseña)', async () => {
      const body = cuerpoDe(
        await http()
          .patch(`/users/${CHOFER}`)
          .set(como(RoleType.ADMIN, ['clientes.gestionar']))
          .send({ password: 'NuevaClave1' })
          .expect(403),
      );
      expect(body).toMatchObject({ code: 'PERMISSION_DENIED' });
      await http()
        .patch(`/users/${CHOFER}`)
        .set(como(RoleType.ADMIN, ['personal.gestionar']))
        .send({ password: 'NuevaClave1' })
        .expect(200);
    });

    it('la cuenta propia no pide permisos', async () => {
      await http()
        .patch(`/users/${YO}`)
        .set(como(RoleType.ADMIN, []))
        .send({ full_name: 'Yo' })
        .expect(200);
    });

    it('una cuenta de otra distribuidora es 404', async () => {
      await http()
        .patch(`/users/${AJENO}`)
        .set(como(RoleType.ADMIN, 'todos'))
        .send({ full_name: 'Ana' })
        .expect(404);
    });
  });

  describe('DELETE /users/:id y PATCH /users/:id/block', () => {
    it('al admin con el rol de sistema sólo lo da de baja o bloquea quien tiene todos', async () => {
      const actor = como(RoleType.ADMIN, [
        'administradores.gestionar',
        'caja.anular',
        'pedidos.ver',
      ]);
      const baja = await http()
        .delete(`/users/${ADMIN_SISTEMA}`)
        .set(actor)
        .expect(403);
      expect(baja.body).toMatchObject({ code: 'STAFF_ROLE_TARGET_OUTRANKS' });
      const bloqueo = await http()
        .patch(`/users/${ADMIN_SISTEMA}/block`)
        .set(actor)
        .send({ block: true })
        .expect(403);
      expect(bloqueo.body).toMatchObject({
        code: 'STAFF_ROLE_TARGET_OUTRANKS',
      });
      expect(users.remove).not.toHaveBeenCalled();
      expect(users.toggleBlockUser).not.toHaveBeenCalled();
      await http()
        .delete(`/users/${ADMIN_SISTEMA}`)
        .set(como(RoleType.ADMIN, 'todos'))
        .expect(200);
    });

    it('al admin con más permisos no lo bloquea; al que cubre, sí', async () => {
      const actor = como(RoleType.ADMIN, [
        'administradores.gestionar',
        'pedidos.ver',
      ]);
      await http()
        .patch(`/users/${ADMIN_ALTO}/block`)
        .set(actor)
        .send({ block: true })
        .expect(403);
      await http()
        .patch(`/users/${ADMIN_BAJO}/block`)
        .set(actor)
        .send({ block: true })
        .expect(200);
    });

    it('un chofer se bloquea y da de baja con personal.gestionar; con clientes.gestionar no', async () => {
      await http()
        .patch(`/users/${CHOFER}/block`)
        .set(como(RoleType.ADMIN, ['personal.gestionar']))
        .send({ block: true })
        .expect(200);
      const body = cuerpoDe(
        await http()
          .delete(`/users/${CHOFER}`)
          .set(como(RoleType.ADMIN, ['clientes.gestionar']))
          .expect(403),
      );
      expect(body).toMatchObject({ code: 'PERMISSION_DENIED' });
      await http()
        .delete(`/users/${CHOFER}`)
        .set(como(RoleType.ADMIN, ['personal.gestionar']))
        .expect(200);
    });

    it('sin ninguno de los tres permisos, el guard corta antes de buscar la cuenta', async () => {
      const body = cuerpoDe(
        await http()
          .delete(`/users/${CHOFER}`)
          .set(como(RoleType.ADMIN, ['pedidos.ver']))
          .expect(403),
      );
      expect(body).toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(users.findAlcance).not.toHaveBeenCalled();
    });

    it('un chofer de la app no da de baja a nadie (403 del rol)', async () => {
      await http()
        .delete(`/users/${ADMIN_BAJO}`)
        .set(como(RoleType.DELIVERY))
        .expect(403);
    });

    it('el super admin pasa siempre', async () => {
      await http()
        .patch(`/users/${ADMIN_SISTEMA}/block`)
        .set(como(RoleType.SUPER_ADMIN))
        .send({ block: true })
        .expect(200);
    });
  });

  describe('POST /employees/:id/account (CU-182)', () => {
    const cuerpo = { email: 'chofer@splg.com', password: 'Clave123' };

    it('con personal.gestionar entra (el caso de uso decide: acá, 409)', async () => {
      await http()
        .post(`/employees/${EMPLEADO}/account`)
        .set(como(RoleType.ADMIN, ['personal.gestionar']))
        .send(cuerpo)
        .expect(409);
      expect(grant.execute).toHaveBeenCalled();
    });

    it('con sólo administradores.gestionar no entra: hoy sólo se otorgan cuentas de chofer', async () => {
      const body = cuerpoDe(
        await http()
          .post(`/employees/${EMPLEADO}/account`)
          .set(como(RoleType.ADMIN, ['administradores.gestionar']))
          .send(cuerpo)
          .expect(403),
      );
      expect(body).toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(grant.execute).not.toHaveBeenCalled();
    });

    it('sin ninguno de los dos, 403 PERMISSION_DENIED y no llega al caso de uso', async () => {
      const body = cuerpoDe(
        await http()
          .post(`/employees/${EMPLEADO}/account`)
          .set(como(RoleType.ADMIN, ['clientes.gestionar']))
          .send(cuerpo)
          .expect(403),
      );
      expect(body).toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(grant.execute).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /customers/:id y /location (H2)', () => {
    it('un admin sin clientes.gestionar: 403 PERMISSION_DENIED y no llega al servicio', async () => {
      for (const ruta of [
        `/customers/${CLIENTE}`,
        `/customers/${CLIENTE}/location`,
      ]) {
        const body = cuerpoDe(
          await http()
            .patch(ruta)
            .set(como(RoleType.ADMIN, ['clientes.ver', 'personal.gestionar']))
            .send(ruta.endsWith('location') ? { latLng: '-27.36,-55.89' } : {})
            .expect(403),
        );
        expect(body).toMatchObject({ code: 'PERMISSION_DENIED' });
      }
      expect(clientes.update).not.toHaveBeenCalled();
      expect(clientes.updateLocation).not.toHaveBeenCalled();
    });

    it('con clientes.gestionar entra (el servicio decide: acá, 404)', async () => {
      await http()
        .patch(`/customers/${CLIENTE}`)
        .set(como(RoleType.ADMIN, ['clientes.gestionar']))
        .send({})
        .expect(404);
      await http()
        .patch(`/customers/${CLIENTE}/location`)
        .set(como(RoleType.ADMIN, ['clientes.gestionar']))
        .send({ latLng: '-27.36,-55.89' })
        .expect(404);
      expect(clientes.update).toHaveBeenCalled();
    });

    it('el cliente sigue editando lo suyo (el guard de permisos no lo mira)', async () => {
      await http()
        .patch(`/customers/${CLIENTE}`)
        .set(como(RoleType.CUSTOMER))
        .send({})
        .expect(404);
      expect(clientes.update).toHaveBeenCalled();
    });

    it('sin token, 401', async () => {
      await http().patch(`/customers/${CLIENTE}`).send({}).expect(401);
    });
  });
});
