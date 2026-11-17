import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import {
  assertQuedaQuienGestioneRoles,
  StaffRoleService,
  validarPermisos,
} from './staff-role.service';
import { StaffRole } from './entities/staff-role.entity';
import { Admin } from './entities/admin.entity';
import type {
  PermisosDelUsuario,
  StaffPermissionsService,
} from './staff-permissions.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { Actor } from './staff-role.service';
import type { Permiso } from '../common/permisos/catalogo';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  EVENTO_PERMISOS_CAMBIADOS,
  PermisosCambiadosEvent,
} from '../common/events/permisos-cambiados.event';

/** Quien pide: por defecto el super admin (tiene todo). */
const SUPER: Actor = { user_id: 'su', role: RoleType.SUPER_ADMIN };
const ADMIN: Actor = { user_id: 'u-actor', role: RoleType.ADMIN };

const D = 'd-1';

function rol(parcial: Partial<StaffRole> = {}): StaffRole {
  return {
    staffRoleId: 'r-1',
    distributorId: D,
    name: 'Depósito',
    description: null,
    permissions: ['stock.gestionar'],
    isSystem: false,
    createdAt: new Date('2026-11-12T00:00:00Z'),
    updatedAt: new Date('2026-11-12T00:00:00Z'),
    deletedAt: null,
    ...parcial,
  };
}

function cuerpo(error: unknown): Record<string, unknown> {
  return (error as HttpException).getResponse() as Record<string, unknown>;
}

describe('reglas puras de los roles', () => {
  it('siempre queda alguien que gestione los roles', () => {
    expect(() => assertQuedaQuienGestioneRoles(1, 0)).toThrow(
      ConflictException,
    );
    expect(() => assertQuedaQuienGestioneRoles(2, 1)).not.toThrow();
    // Si ya no había nadie, el cambio no empeora nada.
    expect(() => assertQuedaQuienGestioneRoles(0, 0)).not.toThrow();
  });

  it('un permiso fuera del catálogo es 400 con su nombre; los válidos salen ordenados', () => {
    let error: unknown;
    try {
      validarPermisos(['pedidos.ver', 'pedidos.borrar']);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    expect(cuerpo(error)).toMatchObject({
      code: 'UNKNOWN_PERMISSION',
      message: expect.stringContaining('«pedidos.borrar»') as string,
    });
    expect(() => validarPermisos(['a.b', 'c.d'])).toThrow(
      /Permisos desconocidos: «a\.b», «c\.d»/,
    );
    expect(validarPermisos(['roles.gestionar', 'pedidos.ver'])).toEqual([
      'pedidos.ver',
      'roles.gestionar',
    ]);
  });
});

describe('StaffRoleService', () => {
  /** Lo que devuelve cada consulta del fake. */
  let estado: {
    rol: StaffRole | null;
    nombreTomado: boolean;
    gestores: number[];
    adminsPorRol: number;
    admin: Partial<Admin> | null;
    /** El rol que el administrador tiene hoy (lo busca el control de «no bajar a quien tiene más»). */
    rolActual: StaffRole | null;
    /** El perfil de admin de la cuenta destino (regla sobre cuentas). */
    perfilDestino: Partial<Admin> | null;
  };
  let consultas: string[];
  let guardados: StaffRole[];
  let bajas: StaffRole[];
  let actualizaciones: unknown[];
  let emitidos: [string, unknown][];
  let deUsuario: jest.Mock<Promise<PermisosDelUsuario>, [string, RoleType]>;
  /** Los permisos del actor admin (ADMIN) y el id de su rol. */
  let delActor: { permisos: Permiso[]; todos: boolean; rolId: string };
  let service: StaffRoleService;

  beforeEach(() => {
    estado = {
      rol: rol(),
      nombreTomado: false,
      gestores: [1, 1],
      adminsPorRol: 0,
      admin: { adminId: 'a-1', userId: 'u-9', staffRoleId: 'r-0' },
      rolActual: null,
      perfilDestino: null,
    };
    consultas = [];
    guardados = [];
    bajas = [];
    actualizaciones = [];
    emitidos = [];
    delActor = { permisos: [], todos: true, rolId: 'r-actor' };
    deUsuario = jest.fn((userId: string, role: RoleType) =>
      Promise.resolve(
        role === RoleType.SUPER_ADMIN
          ? { todos: true, rol: null, permisos: [] }
          : {
              todos: delActor.todos,
              rol: { staffRoleId: delActor.rolId, name: 'X', isSystem: false },
              permisos: delActor.permisos,
            },
      ),
    );

    const qbExiste = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getExists: jest.fn(() => Promise.resolve(estado.nombreTomado)),
    };
    const qbAdmin = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(estado.admin)),
    };
    const repoRol = {
      findOne: jest.fn((opciones: { where: { staffRoleId: string } }) =>
        Promise.resolve(
          estado.rolActual &&
            opciones.where.staffRoleId === estado.rolActual.staffRoleId
            ? estado.rolActual
            : estado.rol,
        ),
      ),
      find: jest.fn(() => Promise.resolve(estado.rol ? [estado.rol] : [])),
      create: jest.fn((v: Partial<StaffRole>) => rol({ ...v })),
      save: jest.fn((r: StaffRole) => {
        guardados.push({ ...r });
        return Promise.resolve(r);
      }),
      softRemove: jest.fn((r: StaffRole) => {
        bajas.push(r);
        return Promise.resolve(r);
      }),
      createQueryBuilder: jest.fn(() => qbExiste),
    };
    const repoAdmin = {
      createQueryBuilder: jest.fn(() => qbAdmin),
      findOne: jest.fn(() => Promise.resolve(estado.perfilDestino)),
      find: jest.fn(() =>
        Promise.resolve([{ userId: 'u-7' }, { userId: 'u-8' }]),
      ),
      update: jest.fn((criterio: unknown, cambios: unknown) => {
        actualizaciones.push([criterio, cambios]);
        return Promise.resolve();
      }),
    };
    const manager = {
      getRepository: (clase: unknown) =>
        clase === StaffRole ? repoRol : repoAdmin,
      query: jest.fn((sql: string) => {
        consultas.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
        if (sql.includes('"is_system" OR')) {
          return Promise.resolve([{ n: estado.gestores.shift() ?? 0 }]);
        }
        if (sql.includes('GROUP BY')) {
          return Promise.resolve(
            estado.adminsPorRol > 0 && estado.rol
              ? [
                  {
                    staff_role_id: estado.rol.staffRoleId,
                    n: estado.adminsPorRol,
                  },
                ]
              : [],
          );
        }
        return Promise.reject(new Error(`consulta no esperada: ${sql}`));
      }),
    } as unknown as EntityManager;
    const dataSource = {
      manager,
      transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    } as unknown as DataSource;

    service = new StaffRoleService(
      repoRol as unknown as Repository<StaffRole>,
      dataSource,
      { deUsuario } as unknown as StaffPermissionsService,
      {
        emit: (evento: string, cuerpo: unknown) => {
          emitidos.push([evento, cuerpo]);
          return true;
        },
      } as unknown as EventEmitter2,
    );
  });

  describe('listar y ficha', () => {
    it('lista con la cantidad de admins de cada rol', async () => {
      estado.adminsPorRol = 3;
      const lista = await service.findAll(D);
      expect(lista).toEqual([{ rol: estado.rol, adminCount: 3 }]);
    });

    it('sin roles no cuenta nada', async () => {
      estado.rol = null;
      await expect(service.findAll(D)).resolves.toEqual([]);
      expect(consultas).toEqual([]);
    });

    it('la ficha de un rol que no es de la distribuidora es 404', async () => {
      estado.rol = null;
      await expect(service.findOne('r-x', D)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('la ficha trae su cantidad de admins', async () => {
      await expect(service.findOne('r-1', D)).resolves.toMatchObject({
        adminCount: 0,
      });
    });
  });

  describe('crear', () => {
    it('guarda los permisos ordenados y sin descripción si no viene', async () => {
      const { rol: creado, adminCount } = await service.create(
        { name: 'Caja', permissions: ['caja.anular', 'finanzas.ver'] },
        D,
        SUPER,
      );
      expect(adminCount).toBe(0);
      expect(creado).toMatchObject({
        distributorId: D,
        name: 'Caja',
        description: null,
        isSystem: false,
        permissions: ['finanzas.ver', 'caja.anular'],
      });
    });

    it('un permiso desconocido es 400 antes de tocar la base', async () => {
      await expect(
        service.create({ name: 'X', permissions: ['nada.ver'] }, D, SUPER),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(guardados).toEqual([]);
    });

    it('el nombre repetido es 409 STAFF_ROLE_NAME_TAKEN', async () => {
      estado.nombreTomado = true;
      const error = await service
        .create({ name: 'administrador', permissions: [] }, D, SUPER)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(cuerpo(error)).toMatchObject({ code: 'STAFF_ROLE_NAME_TAKEN' });
    });

    it('un choque con el único de la base (carrera) sale como 409, no 500', async () => {
      const repo = (service as unknown as { roles: { save: jest.Mock } }).roles;
      repo.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'UQ_staff_role_nombre_vigente',
        }),
      );
      await expect(
        service.create({ name: 'Caja', permissions: [] }, D, SUPER),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('editar', () => {
    it('cambia nombre, descripción y permisos, bloquea la distribuidora (bajas y luego roles)', async () => {
      const { rol: editado } = await service.update(
        'r-1',
        {
          name: 'Depósito y compras',
          description: 'Stock',
          permissions: ['compras.gestionar', 'stock.gestionar'],
        },
        D,
        SUPER,
      );
      expect(editado).toMatchObject({
        name: 'Depósito y compras',
        description: 'Stock',
        permissions: ['stock.gestionar', 'compras.gestionar'],
      });
      expect(consultas.slice(0, 2)).toEqual([
        expect.stringContaining('pg_advisory_xact_lock') as string,
        expect.stringContaining('pg_advisory_xact_lock') as string,
      ]);
    });

    it('cambiar los permisos avisa a todos los que tienen ese rol', async () => {
      await service.update(
        'r-1',
        { permissions: ['stock.gestionar'] },
        D,
        SUPER,
      );
      expect(emitidos).toEqual([
        [EVENTO_PERMISOS_CAMBIADOS, new PermisosCambiadosEvent(['u-7', 'u-8'])],
      ]);
    });

    it('cambiar sólo el nombre no avisa', async () => {
      await service.update('r-1', { name: 'Otro nombre' }, D, SUPER);
      expect(emitidos).toEqual([]);
    });

    it('sin permisos en el cuerpo no toca la lista', async () => {
      const { rol: editado } = await service.update(
        'r-1',
        { description: null },
        D,
        SUPER,
      );
      expect(editado.permissions).toEqual(['stock.gestionar']);
      expect(editado.description).toBeNull();
    });

    it('el rol de sistema no se edita (409 STAFF_ROLE_IS_SYSTEM)', async () => {
      estado.rol = rol({ isSystem: true, name: 'Administrador' });
      const error = await service
        .update('r-1', { name: 'Otro' }, D, SUPER)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(cuerpo(error)).toMatchObject({ code: 'STAFF_ROLE_IS_SYSTEM' });
      expect(guardados).toEqual([]);
    });

    it('quitarle roles.gestionar al último que lo tiene es 409 LAST_ROLES_MANAGER', async () => {
      estado.rol = rol({ permissions: ['roles.gestionar'] });
      estado.gestores = [1, 0];
      const error = await service
        .update('r-1', { permissions: ['pedidos.ver'] }, D, SUPER)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(cuerpo(error)).toMatchObject({ code: 'LAST_ROLES_MANAGER' });
    });

    it('renombrar a un nombre tomado es 409', async () => {
      estado.nombreTomado = true;
      await expect(
        service.update('r-1', { name: 'Caja' }, D, SUPER),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('el rol de otra distribuidora es 404', async () => {
      estado.rol = null;
      await expect(
        service.update('r-x', { name: 'Caja' }, D, SUPER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('dar de baja', () => {
    it('baja lógica de un rol sin admins', async () => {
      await expect(service.remove('r-1', D)).resolves.toEqual({
        message: 'Rol dado de baja',
      });
      expect(bajas).toHaveLength(1);
    });

    it('con admins asignados es 409 STAFF_ROLE_HAS_ADMINS', async () => {
      estado.adminsPorRol = 2;
      const error = await service.remove('r-1', D).catch((e: unknown) => e);
      expect(cuerpo(error)).toMatchObject({
        statusCode: 409,
        code: 'STAFF_ROLE_HAS_ADMINS',
      });
      expect(bajas).toEqual([]);
    });

    it('el de sistema no se da de baja', async () => {
      estado.rol = rol({ isSystem: true });
      await expect(service.remove('r-1', D)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(bajas).toEqual([]);
    });
  });

  describe('asignar', () => {
    it('asigna y verifica la regla', async () => {
      const r = await service.asignar('a-1', 'r-1', D, SUPER);
      expect(r).toEqual({ adminId: 'a-1', userId: 'u-9', rol: estado.rol });
      expect(actualizaciones).toEqual([
        [{ adminId: 'a-1' }, { staffRoleId: 'r-1' }],
      ]);
    });

    it('avisa el cambio de permisos de esa persona (el socket reevalúa sus salas)', async () => {
      await service.asignar('a-1', 'r-1', D, SUPER);
      expect(emitidos).toEqual([
        [EVENTO_PERMISOS_CAMBIADOS, new PermisosCambiadosEvent(['u-9'])],
      ]);
    });

    it('si falla no avisa nada', async () => {
      estado.admin = null;
      await service.asignar('a-x', 'r-1', D, SUPER).catch(() => undefined);
      expect(emitidos).toEqual([]);
    });

    it('repetir la misma asignación no escribe', async () => {
      estado.admin = { adminId: 'a-1', userId: 'u-9', staffRoleId: 'r-1' };
      await service.asignar('a-1', 'r-1', D, SUPER);
      expect(actualizaciones).toEqual([]);
    });

    it('un admin de otra distribuidora (o super admin, o dado de baja) es 404', async () => {
      estado.admin = null;
      await expect(service.asignar('a-x', 'r-1', D, SUPER)).rejects.toThrow(
        'Administrador no encontrado',
      );
    });

    it('un rol de otra distribuidora es 404', async () => {
      estado.rol = null;
      await expect(service.asignar('a-1', 'r-x', D, SUPER)).rejects.toThrow(
        'Rol no encontrado',
      );
    });

    it('sacarse a uno mismo el último roles.gestionar es 409', async () => {
      estado.gestores = [1, 0];
      const error = await service
        .asignar('a-1', 'r-1', D, SUPER)
        .catch((e: unknown) => e);
      expect(cuerpo(error)).toMatchObject({ code: 'LAST_ROLES_MANAGER' });
    });
  });

  describe('nadie le cambia el rol a quien tiene más permisos', () => {
    const codigo = (p: Promise<unknown>) =>
      p.then(
        () => 'pasó',
        (e: unknown) => String(cuerpo(e).code),
      );

    beforeEach(() => {
      delActor = {
        todos: false,
        permisos: [
          'pedidos.ver',
          'stock.gestionar',
          'administradores.gestionar',
        ],
        rolId: 'r-actor',
      };
      estado.rol = rol({ staffRoleId: 'r-1', permissions: ['pedidos.ver'] });
    });

    it('si el rol actual tiene un permiso que el actor no tiene, es 403 nombrándolo y no escribe', async () => {
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        permissions: ['pedidos.ver', 'caja.anular'],
      });
      const error = await service
        .asignar('a-1', 'r-1', D, ADMIN)
        .catch((e: unknown) => e);
      expect(cuerpo(error)).toMatchObject({
        code: 'STAFF_ROLE_TARGET_OUTRANKS',
        message: expect.stringContaining('«caja.anular»') as string,
      });
      expect(actualizaciones).toEqual([]);
    });

    it('al que tiene el rol de sistema sólo lo cambia quien tiene todos los permisos', async () => {
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        isSystem: true,
        permissions: [],
      });
      await expect(
        codigo(service.asignar('a-1', 'r-1', D, ADMIN)),
      ).resolves.toBe('STAFF_ROLE_TARGET_OUTRANKS');
      await expect(
        codigo(service.asignar('a-1', 'r-1', D, SUPER)),
      ).resolves.toBe('pasó');
    });

    it('si el actor tiene todo lo del rol actual, pasa', async () => {
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        permissions: ['stock.gestionar'],
      });
      await expect(
        codigo(service.asignar('a-1', 'r-1', D, ADMIN)),
      ).resolves.toBe('pasó');
      expect(actualizaciones).toEqual([
        [{ adminId: 'a-1' }, { staffRoleId: 'r-1' }],
      ]);
    });

    it('sin cambio de rol no controla nada ni escribe (no da un 403 engañoso)', async () => {
      estado.admin = { adminId: 'a-1', userId: 'u-9', staffRoleId: 'r-1' };
      estado.rol = rol({ staffRoleId: 'r-1', isSystem: true, permissions: [] });
      await expect(
        codigo(service.asignar('a-1', 'r-1', D, ADMIN)),
      ).resolves.toBe('pasó');
      expect(actualizaciones).toEqual([]);
    });
  });

  describe('alta de un admin: el rol del personal', () => {
    const codigo = (p: Promise<unknown>) =>
      p.then(
        (v) => `pasó:${String(v)}`,
        (e: unknown) => String(cuerpo(e).code),
      );

    it('sin administradores.gestionar es 403', async () => {
      delActor = {
        todos: false,
        permisos: ['clientes.gestionar'],
        rolId: 'r-actor',
      };
      await expect(
        codigo(service.rolParaElAlta(ADMIN, D, undefined)),
      ).resolves.toBe('PERMISSION_DENIED');
    });

    it('sin rol elegido: el de sistema sólo lo da quien tiene todos (400 si no)', async () => {
      delActor = {
        todos: false,
        permisos: ['administradores.gestionar'],
        rolId: 'r-actor',
      };
      await expect(
        codigo(service.rolParaElAlta(ADMIN, D, undefined)),
      ).resolves.toBe('STAFF_ROLE_REQUIRED');
      await expect(
        codigo(service.rolParaElAlta(SUPER, D, undefined)),
      ).resolves.toBe('pasó:null');
    });

    it('con un rol que el actor puede dar, lo devuelve; si no, 403', async () => {
      delActor = {
        todos: false,
        permisos: ['administradores.gestionar', 'pedidos.ver'],
        rolId: 'r-actor',
      };
      estado.rol = rol({ staffRoleId: 'r-1', permissions: ['pedidos.ver'] });
      await expect(
        codigo(service.rolParaElAlta(ADMIN, D, 'r-1')),
      ).resolves.toBe('pasó:r-1');
      estado.rol = rol({ staffRoleId: 'r-1', permissions: ['caja.anular'] });
      await expect(
        codigo(service.rolParaElAlta(ADMIN, D, 'r-1')),
      ).resolves.toBe('STAFF_ROLE_PERMISSION_NOT_HELD');
    });
  });

  describe('el alta de un admin se re-valida en la transacción, con el cerrojo de los roles', () => {
    const codigo = (p: Promise<unknown>) =>
      p.then(
        () => 'pasó',
        (e: unknown) => String(cuerpo(e).code),
      );

    it('toma el cerrojo de la distribuidora antes de volver a decidir', async () => {
      const manager = (
        service as unknown as { dataSource: { manager: EntityManager } }
      ).dataSource.manager;
      await service.confirmarRolDelAlta(manager, SUPER, D, null);
      expect(consultas.filter((c) => c.includes('pg_advisory'))).toHaveLength(
        2,
      );
      expect(deUsuario).toHaveBeenCalledWith(
        'su',
        RoleType.SUPER_ADMIN,
        manager,
        false,
      );
    });

    it('si al actor le sacaron administradores.gestionar en el medio, es 403', async () => {
      const manager = (
        service as unknown as { dataSource: { manager: EntityManager } }
      ).dataSource.manager;
      delActor = { todos: false, permisos: ['pedidos.ver'], rolId: 'r-actor' };
      await expect(
        codigo(service.confirmarRolDelAlta(manager, ADMIN, D, 'r-1')),
      ).resolves.toBe('PERMISSION_DENIED');
    });

    it('si el rol elegido ahora tiene un permiso que el actor no tiene, es 403', async () => {
      const manager = (
        service as unknown as { dataSource: { manager: EntityManager } }
      ).dataSource.manager;
      delActor = {
        todos: false,
        permisos: ['administradores.gestionar', 'pedidos.ver'],
        rolId: 'r-actor',
      };
      estado.rol = rol({ staffRoleId: 'r-1', permissions: ['caja.anular'] });
      await expect(
        codigo(service.confirmarRolDelAlta(manager, ADMIN, D, 'r-1')),
      ).resolves.toBe('STAFF_ROLE_PERMISSION_NOT_HELD');
    });

    it('si el rol elegido se dio de baja en el medio, es 404', async () => {
      const manager = (
        service as unknown as { dataSource: { manager: EntityManager } }
      ).dataSource.manager;
      estado.rol = null;
      await expect(
        service.confirmarRolDelAlta(manager, ADMIN, D, 'r-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('nadie sube ni baja a quien tiene más permisos: cuentas de otros', () => {
    const codigo = (p: Promise<unknown>) =>
      p.then(
        () => 'pasó',
        (e: unknown) => String(cuerpo(e).code),
      );
    const otroAdmin = { userId: 'u-9', rol: RoleType.ADMIN };
    const chofer = { userId: 'u-c', rol: RoleType.DELIVERY };
    const cliente = { userId: 'u-k', rol: RoleType.CUSTOMER };

    beforeEach(() => {
      delActor = {
        todos: false,
        permisos: ['administradores.gestionar', 'pedidos.ver'],
        rolId: 'r-actor',
      };
      estado.perfilDestino = {
        userId: 'u-9',
        distributorId: D,
        staffRoleId: 'r-0',
      };
    });

    it('sobre un admin con un permiso que el actor no tiene, es 403 STAFF_ROLE_TARGET_OUTRANKS nombrándolo', async () => {
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        permissions: ['pedidos.ver', 'caja.anular'],
      });
      const error = await service
        .assertPuedeAdministrarA(ADMIN, otroAdmin, D)
        .catch((e: unknown) => e);
      expect(cuerpo(error)).toMatchObject({
        code: 'STAFF_ROLE_TARGET_OUTRANKS',
        message: expect.stringContaining('«caja.anular»') as string,
      });
    });

    it('sobre un admin con el rol de sistema, sólo quien tiene todos', async () => {
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        isSystem: true,
        permissions: [],
      });
      await expect(
        codigo(service.assertPuedeAdministrarA(ADMIN, otroAdmin, D)),
      ).resolves.toBe('STAFF_ROLE_TARGET_OUTRANKS');
      delActor.todos = true;
      await expect(
        codigo(service.assertPuedeAdministrarA(ADMIN, otroAdmin, D)),
      ).resolves.toBe('pasó');
    });

    it('dentro de la transacción, toma el cerrojo de roles antes de leer el rol del destino', async () => {
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        permissions: ['pedidos.ver'],
      });
      const afuera = (
        service as unknown as { dataSource: { manager: EntityManager } }
      ).dataSource.manager;
      const orden: string[] = [];
      const tx = {
        getRepository: (clase: unknown) => {
          const repo = afuera.getRepository(clase as never) as unknown as {
            findOne: (o: unknown) => Promise<unknown>;
          };
          return clase === Admin
            ? {
                ...repo,
                findOne: (o: unknown) => {
                  orden.push('perfil');
                  return repo.findOne(o);
                },
              }
            : repo;
        },
        query: jest.fn((sql: string) => {
          if (sql.includes('pg_advisory')) orden.push('cerrojo');
          return Promise.resolve([]);
        }),
      } as unknown as EntityManager;
      await service.assertPuedeAdministrarA(ADMIN, otroAdmin, D, {
        manager: tx,
      });
      expect(orden.indexOf('cerrojo')).toBeGreaterThanOrEqual(0);
      expect(orden.indexOf('perfil')).toBeGreaterThan(orden.indexOf('cerrojo'));
    });

    it('sobre un admin cuyo rol el actor cubre, pasa', async () => {
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        permissions: ['pedidos.ver'],
      });
      await expect(
        codigo(service.assertPuedeAdministrarA(ADMIN, otroAdmin, D)),
      ).resolves.toBe('pasó');
    });

    it('sobre un admin sin administradores.gestionar es 403 PERMISSION_DENIED, aunque lo cubra', async () => {
      delActor.permisos = ['pedidos.ver', 'personal.gestionar'];
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        permissions: ['pedidos.ver'],
      });
      await expect(
        codigo(service.assertPuedeAdministrarA(ADMIN, otroAdmin, D)),
      ).resolves.toBe('PERMISSION_DENIED');
    });

    it('la contraseña de otro admin no la cambia nadie más que el super admin, ni con todos los permisos', async () => {
      delActor.todos = true;
      const opciones = { cambiaContraseña: true };
      await expect(
        codigo(service.assertPuedeAdministrarA(ADMIN, otroAdmin, D, opciones)),
      ).resolves.toBe('ADMIN_PASSWORD_NOT_CHANGEABLE');
      await expect(
        codigo(service.assertPuedeAdministrarA(SUPER, otroAdmin, D, opciones)),
      ).resolves.toBe('pasó');
      // La empresa propia es el super admin operando su empresa.
      await expect(
        codigo(
          service.assertPuedeAdministrarA(
            { ...ADMIN, actuaComoEmpresaPropia: true },
            otroAdmin,
            D,
            opciones,
          ),
        ),
      ).resolves.toBe('pasó');
    });

    it('la contraseña de un chofer sí, con personal.gestionar', async () => {
      delActor.permisos = ['personal.gestionar'];
      await expect(
        codigo(
          service.assertPuedeAdministrarA(ADMIN, chofer, D, {
            cambiaContraseña: true,
          }),
        ),
      ).resolves.toBe('pasó');
    });

    it('un chofer pide personal.gestionar y un cliente clientes.gestionar', async () => {
      delActor.permisos = ['clientes.gestionar'];
      await expect(
        codigo(service.assertPuedeAdministrarA(ADMIN, chofer, D)),
      ).resolves.toBe('PERMISSION_DENIED');
      await expect(
        codigo(service.assertPuedeAdministrarA(ADMIN, cliente, D)),
      ).resolves.toBe('pasó');
      delActor.permisos = ['personal.gestionar'];
      await expect(
        codigo(service.assertPuedeAdministrarA(ADMIN, chofer, D)),
      ).resolves.toBe('pasó');
      await expect(
        codigo(service.assertPuedeAdministrarA(ADMIN, cliente, D)),
      ).resolves.toBe('PERMISSION_DENIED');
    });

    it('el super admin pasa siempre (también sobre el rol de sistema)', async () => {
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        isSystem: true,
        permissions: [],
      });
      await expect(
        codigo(service.assertPuedeAdministrarA(SUPER, otroAdmin, D)),
      ).resolves.toBe('pasó');
    });

    it('la cuenta propia no pasa por la regla', async () => {
      delActor.permisos = [];
      await expect(
        codigo(
          service.assertPuedeAdministrarA(
            ADMIN,
            { userId: 'U-ACTOR', rol: RoleType.ADMIN },
            D,
            { cambiaContraseña: true },
          ),
        ),
      ).resolves.toBe('pasó');
    });

    it('un super admin como destino, para quien no tiene todos, es 404', async () => {
      await expect(
        service.assertPuedeAdministrarA(
          ADMIN,
          { userId: 'su-2', rol: RoleType.SUPER_ADMIN },
          D,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('dentro de la transacción que escribe, sobre un admin: el cerrojo de roles antes de leer los permisos', async () => {
      const manager = (
        service as unknown as { dataSource: { manager: EntityManager } }
      ).dataSource.manager;
      const { query } = manager as unknown as { query: jest.Mock };
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        permissions: ['pedidos.ver', 'caja.anular'],
      });
      await expect(
        codigo(
          service.assertPuedeAdministrarA(ADMIN, otroAdmin, D, { manager }),
        ),
      ).resolves.toBe('STAFF_ROLE_TARGET_OUTRANKS');
      expect(consultas.filter((c) => c.includes('pg_advisory'))).toHaveLength(
        2,
      );
      expect(deUsuario).toHaveBeenCalledWith(
        'u-actor',
        RoleType.ADMIN,
        manager,
        false,
      );
      expect(query.mock.invocationCallOrder[0]).toBeLessThan(
        deUsuario.mock.invocationCallOrder[0],
      );
    });

    it('usa el manager de la transacción que escribe, no el de afuera', async () => {
      const afuera = (
        service as unknown as { dataSource: { manager: EntityManager } }
      ).dataSource.manager;
      const enTx: string[] = [];
      const tx = {
        getRepository: afuera.getRepository.bind(afuera),
        query: jest.fn((sql: string) => {
          enTx.push(sql);
          return Promise.resolve([]);
        }),
      } as unknown as EntityManager;
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        permissions: ['pedidos.ver'],
      });
      await service.assertPuedeAdministrarA(ADMIN, otroAdmin, D, {
        manager: tx,
      });
      expect(enTx.filter((c) => c.includes('pg_advisory'))).toHaveLength(2);
      expect(consultas).toEqual([]);
      expect(deUsuario).toHaveBeenCalledWith(
        'u-actor',
        RoleType.ADMIN,
        tx,
        false,
      );
    });

    it('fuera de una transacción (el control previo) no toma cerrojos', async () => {
      estado.rolActual = rol({
        staffRoleId: 'r-0',
        permissions: ['pedidos.ver'],
      });
      await service.assertPuedeAdministrarA(ADMIN, otroAdmin, D);
      expect(consultas).toEqual([]);
    });

    it('sobre un chofer no toma el cerrojo de roles (su regla no depende de rangos)', async () => {
      const manager = (
        service as unknown as { dataSource: { manager: EntityManager } }
      ).dataSource.manager;
      delActor.permisos = ['personal.gestionar'];
      await service.assertPuedeAdministrarA(ADMIN, chofer, D, { manager });
      expect(consultas).toEqual([]);
    });

    it('un admin sin rol de personal no tiene nada que proteger', async () => {
      estado.perfilDestino = {
        userId: 'u-9',
        distributorId: D,
        staffRoleId: null,
      };
      await expect(
        codigo(service.assertPuedeAdministrarA(ADMIN, otroAdmin, D)),
      ).resolves.toBe('pasó');
    });
  });

  describe('alta de clientes y choferes: el permiso de cada uno', () => {
    it('cliente pide clientes.gestionar y chofer personal.gestionar', async () => {
      delActor = {
        todos: false,
        permisos: ['clientes.gestionar'],
        rolId: 'r-actor',
      };
      await expect(
        service.assertPuedeDarDeAlta(ADMIN, RoleType.CUSTOMER),
      ).resolves.toBeUndefined();
      const error = await service
        .assertPuedeDarDeAlta(ADMIN, RoleType.DELIVERY)
        .catch((e: unknown) => e);
      expect(cuerpo(error)).toMatchObject({ code: 'PERMISSION_DENIED' });
    });
  });

  describe('editar un rol no le saca a sus administradores lo que el actor no tiene', () => {
    beforeEach(() => {
      delActor = {
        todos: false,
        permisos: ['stock.gestionar', 'roles.gestionar'],
        rolId: 'r-actor',
      };
      estado.rol = rol({
        staffRoleId: 'r-1',
        permissions: ['stock.gestionar', 'caja.anular'],
      });
    });

    it('con administradores asignados, sacar un permiso que el actor no tiene es 403', async () => {
      estado.adminsPorRol = 2;
      const error = await service
        .update('r-1', { permissions: ['stock.gestionar'] }, D, ADMIN)
        .catch((e: unknown) => e);
      expect(cuerpo(error)).toMatchObject({
        code: 'STAFF_ROLE_TARGET_OUTRANKS',
        message: expect.stringContaining('«caja.anular»') as string,
      });
      expect(guardados).toEqual([]);
    });

    it('sin administradores asignados se puede', async () => {
      estado.adminsPorRol = 0;
      await service.update(
        'r-1',
        { permissions: ['stock.gestionar'] },
        D,
        ADMIN,
      );
      expect(guardados).toHaveLength(1);
    });
  });

  describe('nadie da lo que no tiene', () => {
    const codigo = (p: Promise<unknown>) =>
      p.then(
        () => 'pasó',
        (e: unknown) => String(cuerpo(e).code),
      );

    beforeEach(() => {
      // El actor admin tiene un rol propio con pedidos.gestionar (y su ver).
      delActor = {
        todos: false,
        permisos: ['pedidos.ver', 'pedidos.gestionar', 'roles.gestionar'],
        rolId: 'r-actor',
      };
    });

    it('crear con permisos propios pasa; con uno que no tiene es 403 nombrándolo', async () => {
      await expect(
        codigo(
          service.create(
            { name: 'Lector', permissions: ['pedidos.ver'] },
            D,
            ADMIN,
          ),
        ),
      ).resolves.toBe('pasó');
      const error = await service
        .create(
          { name: 'Caja', permissions: ['pedidos.ver', 'caja.anular'] },
          D,
          ADMIN,
        )
        .catch((e: unknown) => e);
      expect(cuerpo(error)).toMatchObject({
        statusCode: 403,
        code: 'STAFF_ROLE_PERMISSION_NOT_HELD',
        message: 'No podés dar permisos que no tenés: «caja.anular»',
      });
      expect(guardados).toHaveLength(1);
    });

    it('editar sumando un permiso que no tiene es 403 y no guarda', async () => {
      await expect(
        codigo(
          service.update(
            'r-1',
            { permissions: ['finanzas.gestionar'] },
            D,
            ADMIN,
          ),
        ),
      ).resolves.toBe('STAFF_ROLE_PERMISSION_NOT_HELD');
      expect(guardados).toEqual([]);
    });

    it('editar el rol que uno tiene asignado es 403 STAFF_ROLE_OWN_ROLE, aunque no sume nada', async () => {
      delActor.rolId = 'r-1';
      await expect(
        codigo(service.update('r-1', { description: 'x' }, D, ADMIN)),
      ).resolves.toBe('STAFF_ROLE_OWN_ROLE');
      expect(guardados).toEqual([]);
    });

    it('el super admin y quien tiene todos editan y crean sin límite', async () => {
      await expect(
        codigo(
          service.update('r-1', { permissions: ['caja.anular'] }, D, SUPER),
        ),
      ).resolves.toBe('pasó');
      delActor.todos = true;
      await expect(
        codigo(
          service.create(
            { name: 'Caja', permissions: ['caja.anular'] },
            D,
            ADMIN,
          ),
        ),
      ).resolves.toBe('pasó');
    });

    it('cambiarse el propio rol es 403 STAFF_ROLE_SELF_ASSIGN', async () => {
      estado.admin = {
        adminId: 'a-1',
        userId: ADMIN.user_id,
        staffRoleId: 'r-actor',
      };
      await expect(
        codigo(service.asignar('a-1', 'r-1', D, ADMIN)),
      ).resolves.toBe('STAFF_ROLE_SELF_ASSIGN');
      expect(actualizaciones).toEqual([]);
    });

    it('asignar un rol con permisos que no tiene, o el de sistema, es 403', async () => {
      estado.rol = rol({ permissions: ['finanzas.ver'] });
      await expect(
        codigo(service.asignar('a-1', 'r-1', D, ADMIN)),
      ).resolves.toBe('STAFF_ROLE_PERMISSION_NOT_HELD');
      estado.rol = rol({ isSystem: true, permissions: [] });
      const error = await service
        .asignar('a-1', 'r-1', D, ADMIN)
        .catch((e: unknown) => e);
      expect(cuerpo(error)).toMatchObject({
        code: 'STAFF_ROLE_PERMISSION_NOT_HELD',
        message:
          'No podés dar el rol de sistema: tiene todos los permisos y vos no',
      });
      expect(actualizaciones).toEqual([]);
    });

    it('asignar un rol con permisos propios pasa', async () => {
      estado.rol = rol({ permissions: ['pedidos.ver'] });
      await expect(
        codigo(service.asignar('a-1', 'r-1', D, ADMIN)),
      ).resolves.toBe('pasó');
      expect(actualizaciones).toHaveLength(1);
    });
  });
});
