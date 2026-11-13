import { INestApplication, VersioningType } from '@nestjs/common';
import { VERSION_NEUTRAL } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import {
  AdminStaffRoleController,
  StaffRoleController,
} from './staff-role.controller';
import {
  MyPermissionsController,
  PermissionsController,
} from './permissions.controller';
import type { StaffRoleService } from './staff-role.service';
import type { StaffPermissionsService } from './staff-permissions.service';
import type { StaffRole } from './entities/staff-role.entity';
import { PERMISOS } from '../common/permisos/catalogo';
import { RoleType } from '../common/constants/role-type.enum';
import { PERMISO_KEY } from '../common/decorators/permiso.decorator';
import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import { soloRutasVersionadas } from '../common/config/documentacion';

const D = 'd-1';
const YO = {
  user_id: 'u-yo',
  email: 'yo@splg.local',
  role: RoleType.ADMIN,
};

/** El handler de un controller, sin desligar `this` (para leer su metadata). */
const handler = (clase: { prototype: object }, nombre: string): object =>
  (clase.prototype as Record<string, object>)[nombre];

function rol(parcial: Partial<StaffRole> = {}): StaffRole {
  return {
    staffRoleId: 'r-1',
    distributorId: D,
    name: 'Depósito',
    description: 'Stock',
    permissions: ['stock.gestionar', 'pedidos.ver', 'viejo.x'],
    isSystem: false,
    createdAt: new Date('2026-11-12T00:00:00Z'),
    updatedAt: new Date('2026-11-12T00:00:00Z'),
    deletedAt: null,
    ...parcial,
  };
}

describe('controllers de roles del personal', () => {
  const servicio = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    asignar: jest.fn(),
  };
  const roles = new StaffRoleController(
    servicio as unknown as StaffRoleService,
  );

  it('lista con el DTO: permisos elegidos en orden del catálogo, sin los que ya no existen', async () => {
    servicio.findAll.mockResolvedValue([
      {
        rol: rol({ isSystem: true, name: 'Administrador', permissions: [] }),
        adminCount: 2,
      },
      { rol: rol(), adminCount: 0 },
    ]);
    const lista = await roles.findAll(D);
    expect(lista[0]).toMatchObject({
      name: 'Administrador',
      isSystem: true,
      adminCount: 2,
      permissions: [...PERMISOS],
    });
    expect(lista[1]).toEqual({
      staffRoleId: 'r-1',
      name: 'Depósito',
      description: 'Stock',
      isSystem: false,
      permissions: ['pedidos.ver', 'stock.gestionar'],
      adminCount: 0,
      createdAt: new Date('2026-11-12T00:00:00Z'),
      updatedAt: new Date('2026-11-12T00:00:00Z'),
    });
    expect(servicio.findAll).toHaveBeenCalledWith(D);
  });

  it('crear, ficha, editar y baja delegan en el servicio con la distribuidora', async () => {
    servicio.create.mockResolvedValue({ rol: rol(), adminCount: 0 });
    servicio.findOne.mockResolvedValue({ rol: rol(), adminCount: 1 });
    servicio.update.mockResolvedValue({ rol: rol(), adminCount: 1 });
    servicio.remove.mockResolvedValue({ message: 'Rol dado de baja' });
    const dto = { name: 'Depósito', permissions: ['stock.gestionar'] };
    await expect(roles.create(dto, D, YO)).resolves.toMatchObject({
      adminCount: 0,
    });
    await expect(roles.findOne('r-1', D)).resolves.toMatchObject({
      adminCount: 1,
    });
    await expect(
      roles.update('r-1', { name: 'X' }, D, YO),
    ).resolves.toMatchObject({
      staffRoleId: 'r-1',
    });
    await expect(roles.remove('r-1', D)).resolves.toEqual({
      message: 'Rol dado de baja',
    });
    expect(servicio.create).toHaveBeenCalledWith(dto, D, YO);
    expect(servicio.update).toHaveBeenCalledWith('r-1', { name: 'X' }, D, YO);
  });

  it('asignar responde el admin con el resumen de su rol', async () => {
    servicio.asignar.mockResolvedValue({
      adminId: 'a-1',
      userId: 'u-1',
      rol: rol(),
    });
    const controller = new AdminStaffRoleController(
      servicio as unknown as StaffRoleService,
    );
    await expect(
      controller.assign('a-1', { staffRoleId: 'r-1' }, D, YO),
    ).resolves.toEqual({
      adminId: 'a-1',
      userId: 'u-1',
      staffRole: { staffRoleId: 'r-1', name: 'Depósito', isSystem: false },
    });
    expect(servicio.asignar).toHaveBeenCalledWith('a-1', 'r-1', D, YO);
  });

  it('el catálogo sale agrupado por módulo, con lo que implica cada permiso', () => {
    const catalogo = new PermissionsController().findAll();
    expect(catalogo[0]).toMatchObject({
      key: 'pedidos',
      label: 'Pedidos y despacho',
    });
    expect(catalogo[0].permissions[1]).toEqual({
      key: 'pedidos.gestionar',
      label: 'gestionar los pedidos',
      description: 'Crear, editar, cancelar y cobrar pedidos.',
      implies: ['pedidos.ver'],
    });
    expect(catalogo.flatMap((m) => m.permissions.map((p) => p.key))).toEqual([
      ...PERMISOS,
    ]);
  });

  it('mis permisos: rol, si los tiene todos y la lista efectiva', async () => {
    const deUsuario = jest.fn().mockResolvedValue({
      todos: false,
      rol: { staffRoleId: 'r-1', name: 'Depósito', isSystem: false },
      permisos: ['stock.ver', 'stock.gestionar'],
    });
    const controller = new MyPermissionsController({
      deUsuario,
    } as unknown as StaffPermissionsService);
    await expect(
      controller.mine({ user_id: 'u-1', email: 'a@b.c', role: RoleType.ADMIN }),
    ).resolves.toEqual({
      role: 'admin',
      allPermissions: false,
      staffRole: { staffRoleId: 'r-1', name: 'Depósito', isSystem: false },
      permissions: ['stock.ver', 'stock.gestionar'],
    });
    deUsuario.mockResolvedValue({ todos: true, rol: null, permisos: [] });
    await expect(
      controller.mine({
        user_id: 's',
        email: 's@b.c',
        role: RoleType.SUPER_ADMIN,
      }),
    ).resolves.toMatchObject({ allPermissions: true, staffRole: null });
  });

  it('los endpoints de roles exigen roles.gestionar y la asignación administradores.gestionar', () => {
    expect(Reflect.getMetadata(PERMISO_KEY, StaffRoleController)).toEqual([
      'roles.gestionar',
    ]);
    expect(
      Reflect.getMetadata(
        PERMISO_KEY,
        handler(AdminStaffRoleController, 'assign'),
      ),
    ).toEqual(['administradores.gestionar']);
    expect(
      Reflect.getMetadata(PERMISO_KEY, PermissionsController),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(PERMISO_KEY, MyPermissionsController),
    ).toBeUndefined();
  });

  it.each([
    [handler(StaffRoleController, 'create')],
    [handler(StaffRoleController, 'update')],
    [handler(StaffRoleController, 'remove')],
    [handler(AdminStaffRoleController, 'assign')],
  ])('las escrituras son @Idempotent()', (handler) => {
    expect(Reflect.getMetadata(IDEMPOTENT_KEY, handler)).toBe(true);
  });
});

describe('Swagger de los roles del personal', () => {
  let app: INestApplication;
  let documento: OpenAPIObject;

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [
        StaffRoleController,
        AdminStaffRoleController,
        PermissionsController,
        MyPermissionsController,
      ],
    })
      .useMocker(() => ({}))
      .compile();
    app = modulo.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    documento = soloRutasVersionadas(
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('t').build(),
      ),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const codigos = (metodo: string, ruta: string): string[] => {
    const operacion = (
      documento.paths[ruta] as
        | Record<string, { responses?: Record<string, unknown> }>
        | undefined
    )?.[metodo];
    if (!operacion) throw new Error(`Swagger no lista ${metodo} ${ruta}`);
    return Object.keys(operacion.responses ?? {}).sort();
  };

  it.each([
    ['get', '/api/v2/staff-roles', ['200', '400', '401', '403']],
    ['post', '/api/v2/staff-roles', ['201', '400', '401', '403', '409', '422']],
    ['get', '/api/v2/staff-roles/{id}', ['200', '400', '401', '403', '404']],
    [
      'patch',
      '/api/v2/staff-roles/{id}',
      ['200', '400', '401', '403', '404', '409', '422'],
    ],
    [
      'delete',
      '/api/v2/staff-roles/{id}',
      ['200', '400', '401', '403', '404', '409'],
    ],
    [
      'put',
      '/api/v2/admins/{id}/staff-role',
      ['200', '400', '401', '403', '404', '409', '422'],
    ],
    ['get', '/api/v2/permissions', ['200', '401', '403']],
    ['get', '/api/v2/me/permissions', ['200', '401', '403']],
  ])('%s %s documenta %j', (metodo, ruta, esperados) => {
    expect(codigos(metodo, ruta)).toEqual(esperados);
  });

  it('el 403 de los endpoints con permiso nombra el permiso', () => {
    const r = (
      documento.paths['/api/v2/staff-roles']?.get as {
        responses: Record<string, { description: string }>;
      }
    ).responses;
    expect(r['403'].description).toContain('roles.gestionar');
    const put = (
      documento.paths['/api/v2/admins/{id}/staff-role']?.put as {
        responses: Record<string, { description: string }>;
      }
    ).responses;
    expect(put['403'].description).toContain('administradores.gestionar');
  });
});
