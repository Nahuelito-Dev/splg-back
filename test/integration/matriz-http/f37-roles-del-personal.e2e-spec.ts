/**
 * Roles y permisos del personal del panel (F37 E1): matriz de códigos de los
 * endpoints nuevos y el circuito completo (alta, uso, edición, reasignación,
 * baja) contra la app con Postgres y Redis efímeros.
 *
 * Escenario: la distribuidora A con su admin de sistema (`adminA`), un lector
 * (`pedidos.ver`), un gestor (`pedidos.gestionar`) y uno sin permisos; la B con
 * su admin; la C con un único admin cuyo rol propio es el único con
 * `roles.gestionar` (para la regla del último). Un controller de prueba con
 * `@Permiso` muestra el guard sobre un endpoint cualquiera.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Controller, Get } from '@nestjs/common';
import { Auth } from '../../../src/common/decorators/auth.decorator';
import { Permiso } from '../../../src/common/decorators/permiso.decorator';
import { RoleType } from '../../../src/common/constants/role-type.enum';
import { Distributor } from '../../../src/distributor/entities/distributor.entity';
import { PERMISOS } from '../../../src/common/permisos/catalogo';
import { TestEnv, createTestApp } from '../setup/test-env';
import {
  Cabeceras,
  Caso,
  Escenario,
  Persona,
  cabecerasDe_,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
  sembrarEscenario,
  sembrarPersona,
} from './matriz';

@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'prueba-permisos', version: '2' })
class PruebaPermisosController {
  @Get('ver')
  @Permiso('pedidos.ver')
  ver(): { ok: boolean } {
    return { ok: true };
  }

  @Get('gestionar')
  @Permiso('pedidos.gestionar')
  gestionar(): { ok: boolean } {
    return { ok: true };
  }
}

type ConAdmin = Persona & { adminId: string; cabeceras: Cabeceras };

interface Ctx extends Escenario {
  distC: { id: string; slug: string };
  adminLector: ConAdmin;
  adminGestor: ConAdmin;
  adminNada: ConAdmin;
  adminC: ConAdmin;
  adminAsignar: ConAdmin;
  rolSistemaA: string;
  rolSistemaB: string;
  rolSistemaC: string;
  rolLector: string;
  rolGestor: string;
  rolNada: string;
  rolEditar: string;
  rolB: string;
  rolGestorDeRolesC: string;
  rolSinRolesC: string;
  /** Admin de la A con un rol propio que gestiona roles y admins, y ve pedidos. */
  adminRoles: ConAdmin;
  rolDeRolesA: string;
  /** La D: `adminD1` (sistema, el único que gestiona roles) y `adminD2` (sin roles.gestionar). */
  distD: { id: string; slug: string };
  adminD1: ConAdmin;
  adminD2: ConAdmin;
}

/** Lo que importa de `GET /v2/staff-roles` para la A. */
const resumenDeLista = (
  cuerpo: unknown,
  x: { rolLector: string; rolB: string },
) => {
  const roles = cuerpo as Array<{
    staffRoleId: string;
    isSystem: boolean;
    name: string;
    adminCount: number;
  }>;
  const ids = roles.map((r) => r.staffRoleId);
  return {
    primero: roles[0]?.isSystem ? roles[0].name : null,
    conLector: ids.includes(x.rolLector),
    conRolB: ids.includes(x.rolB),
    adminsDelLector: roles.find((r) => r.staffRoleId === x.rolLector)
      ?.adminCount,
  };
};

const id = (cuerpo: unknown): string =>
  (cuerpo as { staffRoleId: string }).staffRoleId;

describe('Matriz HTTP F37: roles y permisos del personal (e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;

  /** Pide como un actor del escenario y exige el código (para preparar). */
  const pedir = async (
    metodo: 'get' | 'post' | 'patch' | 'put' | 'delete',
    ruta: string,
    actor: string,
    esperado: number,
    body?: object,
  ): Promise<unknown> => {
    const res = await llamar(ctx, metodo, ruta, actor, body);
    expect({ ruta, estado: res.status, cuerpo: res.body as unknown }).toEqual(
      expect.objectContaining({ estado: esperado }),
    );
    return res.body as unknown;
  };

  const crearRol = (actor: string, permissions: string[], nombre?: string) =>
    pedir('post', '/v2/staff-roles', actor, 201, {
      name: nombre ?? `Rol ${randomUUID().slice(0, 8)}`,
      permissions,
    }).then(id);

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp({ controllers: [PruebaPermisosController] });
    const e = await sembrarEscenario(env.app);
    const ds = env.app.get(DataSource);
    const sufijo = randomUUID().slice(0, 6);
    const c = (await ds.getRepository(Distributor).save({
      name: `Dist c ${sufijo}`,
      slug: `dist-c-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
    const distC = { id: c.distributorId, slug: c.slug };
    const dd = (await ds.getRepository(Distributor).save({
      name: `Dist d ${sufijo}`,
      slug: `dist-d-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
    const distD = { id: dd.distributorId, slug: dd.slug };
    const persona = async (n: string, dist: string): Promise<ConAdmin> => {
      const p = await sembrarPersona(env.app, 'admin', n, dist);
      const [fila] = await ds.query<Array<{ admin_id: string }>>(
        `SELECT admin_id FROM admin WHERE user_id = $1`,
        [p.userId],
      );
      return { ...p, adminId: fila.admin_id };
    };
    ctx = {
      ...e,
      distC,
      adminLector: await persona('admin-lector', e.distA.id),
      adminGestor: await persona('admin-gestor', e.distA.id),
      adminNada: await persona('admin-nada', e.distA.id),
      adminAsignar: await persona('admin-asignar', e.distA.id),
      adminC: await persona('admin-c', distC.id),
      adminRoles: await persona('admin-roles', e.distA.id),
      rolDeRolesA: '',
      distD,
      adminD1: await persona('admin-d1', distD.id),
      adminD2: await persona('admin-d2', distD.id),
      rolSistemaA: '',
      rolSistemaB: '',
      rolSistemaC: '',
      rolLector: '',
      rolGestor: '',
      rolNada: '',
      rolEditar: '',
      rolB: '',
      rolGestorDeRolesC: '',
      rolSinRolesC: '',
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    ctx.actores.adminLector = ctx.adminLector.cabeceras;
    ctx.actores.adminGestor = ctx.adminGestor.cabeceras;
    ctx.actores.adminNada = ctx.adminNada.cabeceras;
    ctx.actores.adminC = ctx.adminC.cabeceras;
    ctx.actores.adminRoles = ctx.adminRoles.cabeceras;
    ctx.actores.superEnD = cabecerasDe_(
      e.superAdmin.email,
      'panel-app',
      distD.slug,
    );
    ctx.actores.superEnC = cabecerasDe_(
      e.superAdmin.email,
      'panel-app',
      distC.slug,
    );

    const sistema = async (actor: string) =>
      id(
        (
          (await pedir('get', '/v2/staff-roles', actor, 200)) as Array<{
            isSystem: boolean;
          }>
        ).find((r) => r.isSystem),
      );
    ctx.rolSistemaA = await sistema('adminA');
    ctx.rolSistemaB = await sistema('adminB');
    ctx.rolSistemaC = await sistema('adminC');
    ctx.rolLector = await crearRol('adminA', ['pedidos.ver'], 'Lector');
    ctx.rolGestor = await crearRol('adminA', ['pedidos.gestionar'], 'Gestor');
    ctx.rolNada = await crearRol('adminA', [], 'Sin permisos');
    ctx.rolEditar = await crearRol('adminA', ['flota.ver'], 'Para editar');
    ctx.rolB = await crearRol('adminB', ['stock.ver'], 'De la B');
    ctx.rolGestorDeRolesC = await crearRol(
      'superEnC',
      ['roles.gestionar', 'administradores.gestionar'],
      'Gestor de roles',
    );
    ctx.rolSinRolesC = await crearRol('superEnC', ['pedidos.ver'], 'Ventas');
    const asignar = (actor: string, admin: ConAdmin, rol: string) =>
      pedir('put', `/v2/admins/${admin.adminId}/staff-role`, actor, 200, {
        staffRoleId: rol,
      });
    await asignar('adminA', ctx.adminLector, ctx.rolLector);
    await asignar('adminA', ctx.adminGestor, ctx.rolGestor);
    await asignar('adminA', ctx.adminNada, ctx.rolNada);
    // La C queda con su único admin en un rol propio que gestiona roles.
    await asignar('superEnC', ctx.adminC, ctx.rolGestorDeRolesC);
    ctx.rolDeRolesA = await crearRol(
      'adminA',
      ['roles.gestionar', 'administradores.gestionar', 'pedidos.ver'],
      'Gestor de roles A',
    );
    await asignar('adminA', ctx.adminRoles, ctx.rolDeRolesA);
    // En la D sólo `adminD1` (sistema) gestiona roles.
    await asignar(
      'superEnD',
      ctx.adminD2,
      await crearRol('superEnD', ['pedidos.ver'], 'Ventas D'),
    );
  }, 300000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const sinToken = { cabeceras: { 'X-Client-Source': 'panel-app' } };
  const SIN_PERMISO_ROLES =
    'No tenés permiso para gestionar los roles y permisos';
  const cuentasDeLasApps = <T extends Caso<Ctx>>(
    f: (
      c: string,
      a: string | undefined,
      e: number,
      x?: Partial<Caso<Ctx>>,
    ) => T,
    extra: Partial<Caso<Ctx>> = {},
  ): T[] => [
    f('cliente', 'clienteA', 403, extra),
    f('chofer', 'chofer', 403, extra),
  ];
  const nombre = () => `Rol ${randomUUID().slice(0, 8)}`;

  /** Para el 422: la misma clave ya usada con otro cuerpo. */
  const claveUsada = (
    ruta: (c: Ctx) => string,
    metodo: 'post' | 'patch' | 'put',
    cuerpo: (c: Ctx) => object,
  ) => {
    const clave = randomUUID();
    return {
      cabeceras: { 'Idempotency-Key': clave },
      antes: async (c: Ctx) => {
        await request(c.app.getHttpServer())
          [metodo](ruta(c))
          .set({ ...c.actores.adminA, 'Idempotency-Key': clave })
          .send(cuerpo(c))
          .expect((r) => expect(r.status).toBeLessThan(300));
      },
      code: 'IDEMPOTENCY_KEY_REUSED',
    };
  };

  // ======================================================= GET /v2/permissions
  const catalogo = endpoint<Ctx>('get', '/v2/permissions', '/v2/permissions');
  // ==================================================== GET /v2/me/permissions
  const mios = endpoint<Ctx>('get', '/v2/me/permissions', '/v2/me/permissions');
  // ======================================================= /v2/staff-roles
  const listar = endpoint<Ctx>('get', '/v2/staff-roles', '/v2/staff-roles');
  const crear = endpoint<Ctx>('post', '/v2/staff-roles', '/v2/staff-roles');
  const ficha = endpoint<Ctx>(
    'get',
    '/v2/staff-roles/{id}',
    (c) => `/v2/staff-roles/${c.rolLector}`,
  );
  const editar = endpoint<Ctx>(
    'patch',
    '/v2/staff-roles/{id}',
    (c) => `/v2/staff-roles/${c.rolEditar}`,
  );
  const baja = endpoint<Ctx>(
    'delete',
    '/v2/staff-roles/{id}',
    (c) => `/v2/staff-roles/${c.rolEditar}`,
  );
  const asignar = endpoint<Ctx>(
    'put',
    '/v2/admins/{id}/staff-role',
    (c) => `/v2/admins/${c.adminAsignar.adminId}/staff-role`,
  );
  const prueba = endpoint<Ctx>(
    'get',
    '/v2/prueba-permisos/ver',
    '/v2/prueba-permisos/ver',
  );
  const pruebaGestionar = endpoint<Ctx>(
    'get',
    '/v2/prueba-permisos/gestionar',
    '/v2/prueba-permisos/gestionar',
  );

  // Bajas y bloqueos de admins: no dejan a la D sin nadie que gestione roles.
  const bajaAdmin = endpoint<Ctx>(
    'delete',
    '/admin/{id}',
    (c) => `/admin/${c.adminD1.adminId}`,
  );
  const bajaUsuario = endpoint<Ctx>(
    'delete',
    '/users/{id}',
    (c) => `/users/${c.adminD1.userId}`,
  );
  const bloquear = endpoint<Ctx>(
    'patch',
    '/users/{id}/block',
    (c) => `/users/${c.adminD1.userId}/block`,
  );

  const casos: Array<Caso<Ctx>> = [
    // ---------------------------------------------------------------- catálogo
    catalogo('sin token', undefined, 401, sinToken),
    ...cuentasDeLasApps(catalogo),
    catalogo('admin sin permisos lo ve igual', 'adminNada', 200, {
      verificar: (c) =>
        expect(
          (c as Array<{ permissions: Array<{ key: string }> }>).flatMap((m) =>
            m.permissions.map((p) => p.key),
          ),
        ).toEqual([...PERMISOS]),
    }),
    catalogo('super admin sin X-Distributor', 'super', 200),
    // -------------------------------------------------------------- mis permisos
    mios('sin token', undefined, 401, sinToken),
    ...cuentasDeLasApps(mios),
    mios('admin con el rol de sistema: todos', 'adminA', 200, {
      verificar: (c) =>
        expect(c).toMatchObject({
          role: 'admin',
          allPermissions: true,
          staffRole: { name: 'Administrador', isSystem: true },
          permissions: [...PERMISOS],
        }),
    }),
    mios('lector: sólo pedidos.ver', 'adminLector', 200, {
      verificar: (c) =>
        expect(c).toMatchObject({
          allPermissions: false,
          staffRole: { name: 'Lector', isSystem: false },
          permissions: ['pedidos.ver'],
        }),
    }),
    mios('gestor: gestionar trae ver', 'adminGestor', 200, {
      verificar: (c) =>
        expect(c).toMatchObject({
          permissions: ['pedidos.ver', 'pedidos.gestionar'],
        }),
    }),
    mios('super admin: todos, sin rol de personal', 'super', 200, {
      verificar: (c) =>
        expect(c).toMatchObject({
          role: 'super_admin',
          allPermissions: true,
          staffRole: null,
        }),
    }),
    mios(
      'super admin con una X-Distributor inexistente no falla',
      'super',
      200,
      {
        cabeceras: { 'X-Distributor': 'no-existe' },
      },
    ),
    // -------------------------------------------------------------- listar roles
    listar('sin token', undefined, 401, sinToken),
    ...cuentasDeLasApps(listar),
    listar('admin sin roles.gestionar', 'adminLector', 403, {
      code: 'PERMISSION_DENIED',
      mensajeExacto: SIN_PERMISO_ROLES,
    }),
    listar('admin de la A: sistema primero, sólo los de la A', 'adminA', 200, {
      verificar: (c, x) =>
        expect(resumenDeLista(c, x)).toEqual({
          primero: 'Administrador',
          conLector: true,
          conRolB: false,
          adminsDelLector: 1,
        }),
    }),
    listar('admin de la B no ve los de la A', 'adminB', 200, {
      verificar: (c, x) => expect(JSON.stringify(c)).not.toContain(x.rolLector),
    }),
    listar('super admin sin X-Distributor', 'super', 400, {
      code: 'MISSING_DISTRIBUTOR',
    }),
    listar('super admin viendo la A', 'superEnA', 200, {
      verificar: (c, x) => expect(JSON.stringify(c)).toContain(x.rolLector),
    }),
    // -------------------------------------------------------------- crear rol
    crear('sin token', undefined, 401, { ...sinToken, body: {} }),
    ...cuentasDeLasApps(crear, { body: {} }),
    crear('admin sin roles.gestionar', 'adminGestor', 403, {
      body: { name: 'X', permissions: [] },
      code: 'PERMISSION_DENIED',
    }),
    crear('sin nombre', 'adminA', 400, { body: { permissions: [] } }),
    crear('nombre de una letra', 'adminA', 400, {
      body: { name: ' x ', permissions: [] },
    }),
    crear('permisos que no son lista', 'adminA', 400, {
      body: { name: nombre(), permissions: 'pedidos.ver' },
    }),
    crear('permisos repetidos', 'adminA', 400, {
      body: { name: nombre(), permissions: ['pedidos.ver', 'pedidos.ver'] },
    }),
    crear('campo de más', 'adminA', 400, {
      body: { name: nombre(), permissions: [], isSystem: true },
    }),
    crear('permiso fuera del catálogo, con su nombre', 'adminA', 400, {
      body: { name: nombre(), permissions: ['pedidos.ver', 'pedidos.borrar'] },
      code: 'UNKNOWN_PERMISSION',
      mensaje: '«pedidos.borrar»',
    }),
    crear('super admin sin X-Distributor', 'super', 400, {
      body: { name: nombre(), permissions: [] },
      code: 'MISSING_DISTRIBUTOR',
    }),
    crear(
      'nombre del rol de sistema (sin distinguir mayúsculas)',
      'adminA',
      409,
      {
        body: { name: 'ADMINISTRADOR', permissions: [] },
        code: 'STAFF_ROLE_NAME_TAKEN',
      },
    ),
    crear('con un permiso que quien crea no tiene', 'adminRoles', 403, {
      body: { name: nombre(), permissions: ['pedidos.ver', 'caja.anular'] },
      code: 'STAFF_ROLE_PERMISSION_NOT_HELD',
      mensajeExacto: 'No podés dar permisos que no tenés: «caja.anular»',
    }),
    crear('con permisos que quien crea sí tiene', 'adminRoles', 201, {
      body: { name: nombre(), permissions: ['pedidos.ver'] },
    }),
    crear('admin de la A', 'adminA', 201, {
      body: {
        name: nombre(),
        description: '  Depósito  ',
        permissions: ['compras.gestionar', 'stock.gestionar'],
      },
      verificar: (c) =>
        expect(c).toMatchObject({
          description: 'Depósito',
          isSystem: false,
          adminCount: 0,
          permissions: ['stock.gestionar', 'compras.gestionar'],
        }),
    }),
    crear('el mismo nombre en otra distribuidora sí', 'adminB', 201, {
      body: { name: 'Lector', permissions: [] },
    }),
    crear('super admin viendo la A', 'superEnA', 201, {
      body: { name: nombre(), permissions: ['reportes.ver'] },
    }),
    crear('Idempotency-Key repetida con otro cuerpo', 'adminA', 422, {
      body: { name: nombre(), permissions: [] },
      ...claveUsada(
        () => '/v2/staff-roles',
        'post',
        () => ({ name: nombre(), permissions: [] }),
      ),
    }),
    // --------------------------------------------------------------- ficha
    ficha('sin token', undefined, 401, sinToken),
    ...cuentasDeLasApps(ficha),
    ficha('admin sin roles.gestionar', 'adminLector', 403, {
      code: 'PERMISSION_DENIED',
    }),
    ficha('id mal formado', 'adminA', 400, {
      ruta: '/v2/staff-roles/xx',
      code: 'INVALID_ID',
    }),
    ficha('no existe', 'adminA', 404, {
      ruta: (c) => `/v2/staff-roles/${c.inexistente}`,
    }),
    ficha('rol de otra distribuidora', 'adminB', 404),
    ficha('super admin sin X-Distributor', 'super', 400),
    ficha('admin de la A', 'adminA', 200, {
      verificar: (c, x) =>
        expect(c).toMatchObject({
          staffRoleId: x.rolLector,
          permissions: ['pedidos.ver'],
          adminCount: 1,
        }),
    }),
    ficha('el de sistema lista el catálogo entero', 'superEnA', 200, {
      ruta: (c) => `/v2/staff-roles/${c.rolSistemaA}`,
      verificar: (c) =>
        expect(c).toMatchObject({
          isSystem: true,
          permissions: [...PERMISOS],
        }),
    }),
    // --------------------------------------------------------------- editar
    editar('sin token', undefined, 401, { ...sinToken, body: {} }),
    ...cuentasDeLasApps(editar, { body: {} }),
    editar('admin sin roles.gestionar', 'adminGestor', 403, {
      body: { name: 'X' },
      code: 'PERMISSION_DENIED',
    }),
    editar('id mal formado', 'adminA', 400, {
      ruta: '/v2/staff-roles/xx',
      body: {},
    }),
    editar('permiso fuera del catálogo', 'adminA', 400, {
      body: { permissions: ['flota.borrar'] },
      code: 'UNKNOWN_PERMISSION',
    }),
    editar('rol de otra distribuidora', 'adminB', 404, {
      body: { name: 'Otro nombre' },
    }),
    editar('el rol de sistema', 'adminA', 409, {
      ruta: (c) => `/v2/staff-roles/${c.rolSistemaA}`,
      body: { permissions: ['pedidos.ver'] },
      code: 'STAFF_ROLE_IS_SYSTEM',
    }),
    editar('nombre de otro rol', 'adminA', 409, {
      body: { name: 'lector' },
      code: 'STAFF_ROLE_NAME_TAKEN',
    }),
    editar('el propio rol (aunque gestione roles)', 'adminC', 403, {
      ruta: (c) => `/v2/staff-roles/${c.rolGestorDeRolesC}`,
      body: { description: 'Me sumo algo' },
      code: 'STAFF_ROLE_OWN_ROLE',
    }),
    editar('sumarse permisos editando el propio rol', 'adminRoles', 403, {
      ruta: (c) => `/v2/staff-roles/${c.rolDeRolesA}`,
      body: { permissions: ['roles.gestionar', 'caja.anular'] },
      code: 'STAFF_ROLE_OWN_ROLE',
    }),
    editar('dar a otro rol un permiso que no tiene', 'adminRoles', 403, {
      ruta: (c) => `/v2/staff-roles/${c.rolLector}`,
      body: { permissions: ['pedidos.ver', 'finanzas.gestionar'] },
      code: 'STAFF_ROLE_PERMISSION_NOT_HELD',
      mensaje: '«finanzas.gestionar»',
    }),
    editar('otro rol con permisos que sí tiene', 'adminRoles', 200, {
      ruta: (c) => `/v2/staff-roles/${c.rolLector}`,
      body: { permissions: ['pedidos.ver'] },
    }),
    editar(
      'quitarle roles.gestionar al último que lo tiene (C)',
      'superEnC',
      409,
      {
        ruta: (c) => `/v2/staff-roles/${c.rolGestorDeRolesC}`,
        body: { permissions: ['administradores.gestionar'] },
        code: 'LAST_ROLES_MANAGER',
      },
    ),
    editar('admin de la A', 'adminA', 200, {
      body: { description: 'Flota', permissions: ['flota.gestionar'] },
      verificar: (c) =>
        expect(c).toMatchObject({
          description: 'Flota',
          permissions: ['flota.gestionar'],
        }),
    }),
    editar('Idempotency-Key repetida con otro cuerpo', 'adminA', 422, {
      body: { description: 'otra' },
      ...claveUsada(
        (c) => `/v2/staff-roles/${c.rolEditar}`,
        'patch',
        () => ({ description: 'una' }),
      ),
    }),
    // ----------------------------------------------------------------- baja
    baja('sin token', undefined, 401, sinToken),
    ...cuentasDeLasApps(baja),
    baja('admin sin roles.gestionar', 'adminLector', 403, {
      code: 'PERMISSION_DENIED',
    }),
    baja('id mal formado', 'adminA', 400, { ruta: '/v2/staff-roles/xx' }),
    baja('rol de otra distribuidora', 'adminB', 404),
    baja('el rol de sistema', 'adminA', 409, {
      ruta: (c) => `/v2/staff-roles/${c.rolSistemaA}`,
      code: 'STAFF_ROLE_IS_SYSTEM',
    }),
    baja('con administradores asignados', 'adminA', 409, {
      ruta: (c) => `/v2/staff-roles/${c.rolLector}`,
      code: 'STAFF_ROLE_HAS_ADMINS',
    }),
    baja('admin de la A', 'adminA', 200, {
      ruta: (c) => `/v2/staff-roles/${c.rolEditar}`,
      verificar: (c) => expect(c).toEqual({ message: 'Rol dado de baja' }),
    }),
    baja('ya dado de baja', 'adminA', 404, {
      ruta: (c) => `/v2/staff-roles/${c.rolEditar}`,
    }),
    // -------------------------------------------------------------- asignar
    asignar('sin token', undefined, 401, { ...sinToken, body: {} }),
    ...cuentasDeLasApps(asignar, { body: {} }),
    asignar('admin sin administradores.gestionar', 'adminLector', 403, {
      body: (c) => ({ staffRoleId: c.rolGestor }),
      code: 'PERMISSION_DENIED',
      mensaje: 'gestionar los administradores',
    }),
    asignar('sin staffRoleId', 'adminA', 400, { body: {} }),
    asignar('staffRoleId que no es uuid', 'adminA', 400, {
      body: { staffRoleId: 'x' },
    }),
    asignar('id mal formado', 'adminA', 400, {
      ruta: '/v2/admins/xx/staff-role',
      body: (c) => ({ staffRoleId: c.rolGestor }),
    }),
    asignar('admin de otra distribuidora', 'adminA', 404, {
      ruta: (c) => `/v2/admins/${c.adminB.adminId}/staff-role`,
      body: (c) => ({ staffRoleId: c.rolGestor }),
    }),
    asignar('a un super admin', 'superEnA', 404, {
      ruta: (c) => `/v2/admins/${c.superAdmin.adminId}/staff-role`,
      body: (c) => ({ staffRoleId: c.rolGestor }),
    }),
    asignar('rol de otra distribuidora', 'adminA', 404, {
      body: (c) => ({ staffRoleId: c.rolB }),
      mensaje: 'Rol no encontrado',
    }),
    asignar('super admin sin X-Distributor', 'super', 400, {
      body: (c) => ({ staffRoleId: c.rolGestor }),
      code: 'MISSING_DISTRIBUTOR',
    }),
    asignar('cambiarse el propio rol', 'adminC', 403, {
      ruta: (c) => `/v2/admins/${c.adminC.adminId}/staff-role`,
      body: (c) => ({ staffRoleId: c.rolSistemaC }),
      code: 'STAFF_ROLE_SELF_ASSIGN',
    }),
    asignar('autoasignarse el rol de sistema', 'adminRoles', 403, {
      ruta: (c) => `/v2/admins/${c.adminRoles.adminId}/staff-role`,
      body: (c) => ({ staffRoleId: c.rolSistemaA }),
      code: 'STAFF_ROLE_SELF_ASSIGN',
    }),
    asignar('dar el rol de sistema sin tener todos', 'adminRoles', 403, {
      body: (c) => ({ staffRoleId: c.rolSistemaA }),
      code: 'STAFF_ROLE_PERMISSION_NOT_HELD',
    }),
    asignar('dar un rol con permisos que no tiene', 'adminRoles', 403, {
      body: (c) => ({ staffRoleId: c.rolGestor }),
      code: 'STAFF_ROLE_PERMISSION_NOT_HELD',
      mensaje: '«pedidos.gestionar»',
    }),
    asignar('dar un rol con permisos que sí tiene', 'adminRoles', 200, {
      body: (c) => ({ staffRoleId: c.rolLector }),
    }),
    asignar(
      'sacarle el último roles.gestionar a la C (super admin)',
      'superEnC',
      409,
      {
        ruta: (c) => `/v2/admins/${c.adminC.adminId}/staff-role`,
        body: (c) => ({ staffRoleId: c.rolSinRolesC }),
        code: 'LAST_ROLES_MANAGER',
      },
    ),
    asignar('admin de la A', 'adminA', 200, {
      body: (c) => ({ staffRoleId: c.rolGestor }),
      verificar: (c, x) =>
        expect(c).toEqual({
          adminId: x.adminAsignar.adminId,
          userId: x.adminAsignar.userId,
          staffRole: {
            staffRoleId: x.rolGestor,
            name: 'Gestor',
            isSystem: false,
          },
        }),
    }),
    asignar('super admin viendo la A', 'superEnA', 200, {
      body: (c) => ({ staffRoleId: c.rolSistemaA }),
    }),
    asignar('Idempotency-Key repetida con otro cuerpo', 'adminA', 422, {
      body: (c) => ({ staffRoleId: c.rolLector }),
      ...claveUsada(
        (c) => `/v2/admins/${c.adminAsignar.adminId}/staff-role`,
        'put',
        (c) => ({ staffRoleId: c.rolSistemaA }),
      ),
    }),
    // ------------------------------------- endpoint cualquiera con @Permiso
    prueba('sin token', undefined, 401, sinToken),
    prueba('cliente (lo frena @Auth)', 'clienteA', 403),
    prueba('rol de sistema', 'adminA', 200),
    prueba('rol con pedidos.ver', 'adminLector', 200),
    prueba('gestionar implica ver', 'adminGestor', 200),
    prueba('rol sin permisos', 'adminNada', 403, {
      code: 'PERMISSION_DENIED',
      mensajeExacto: 'No tenés permiso para ver los pedidos',
    }),
    prueba('super admin', 'super', 200),
    pruebaGestionar('ver no implica gestionar', 'adminLector', 403, {
      code: 'PERMISSION_DENIED',
      mensajeExacto: 'No tenés permiso para gestionar los pedidos',
    }),
    pruebaGestionar('rol con pedidos.gestionar', 'adminGestor', 200),
    // ----------------------------- bajas y bloqueos: el último gestor de roles
    bajaAdmin('el único que gestiona los roles de la D', 'superEnD', 409, {
      code: 'LAST_ROLES_MANAGER',
      mensajeExacto:
        'Tiene que quedar al menos un administrador activo con permiso para gestionar los roles y permisos: asigná ese permiso a otro antes',
    }),
    bajaUsuario('el único que gestiona los roles de la D', 'superEnD', 409, {
      code: 'LAST_ROLES_MANAGER',
    }),
    bloquear('el único que gestiona los roles de la D', 'superEnD', 409, {
      body: { block: true },
      code: 'LAST_ROLES_MANAGER',
    }),
    bloquear('otro admin de la D que no gestiona roles', 'superEnD', 200, {
      ruta: (c) => `/users/${c.adminD2.userId}/block`,
      body: { block: true },
    }),
  ];

  correrMatriz('casos', ver, casos);

  describe('circuito', () => {
    it('sin caché: un permiso revocado en la base vale en la request siguiente', async () => {
      const yo = await sembrarPersona(
        env.app,
        'admin',
        'admin-sin-cache',
        ctx.distA.id,
      );
      ctx.actores.adminSinCache = yo.cabeceras;
      const rol = await crearRol('adminA', ['pedidos.ver']);
      const ds = env.app.get(DataSource);
      await ds.query(`UPDATE admin SET staff_role_id = $2 WHERE user_id = $1`, [
        yo.userId,
        rol,
      ]);
      await pedir('get', '/v2/prueba-permisos/ver', 'adminSinCache', 200);
      // Otra instancia (o un cambio que no pasó por esta) revoca el permiso:
      // no hay invalidación que esperar, la request siguiente ya lo ve.
      await ds.query(
        `UPDATE staff_role SET permissions = '{}' WHERE staff_role_id = $1`,
        [rol],
      );
      await pedir('get', '/v2/prueba-permisos/ver', 'adminSinCache', 403);
      await pedir('get', '/v2/me/permissions', 'adminSinCache', 200).then((c) =>
        expect(c).toMatchObject({ permissions: [] }),
      );
    });

    it('reasignar o editar el rol cambia los permisos en la request siguiente', async () => {
      const yo = await sembrarPersona(
        env.app,
        'admin',
        'admin-cache',
        ctx.distA.id,
      );
      ctx.actores.adminCache = yo.cabeceras;
      const [{ admin_id }] = await env.app
        .get(DataSource)
        .query<
          Array<{ admin_id: string }>
        >(`SELECT admin_id FROM admin WHERE user_id = $1`, [yo.userId]);
      // Con «Administrador» entra (y queda en la caché).
      await pedir('get', '/v2/staff-roles', 'adminCache', 200);
      await pedir('get', '/v2/staff-roles', 'adminCache', 200);
      const rol = await crearRol('adminA', ['pedidos.ver']);
      await pedir('put', `/v2/admins/${admin_id}/staff-role`, 'adminA', 200, {
        staffRoleId: rol,
      });
      await pedir('get', '/v2/staff-roles', 'adminCache', 403);
      await pedir('get', '/v2/prueba-permisos/ver', 'adminCache', 200);
      // Editar el rol también invalida a quien lo tiene.
      await pedir('patch', `/v2/staff-roles/${rol}`, 'adminA', 200, {
        permissions: ['roles.gestionar'],
      });
      await pedir('get', '/v2/staff-roles', 'adminCache', 200);
      await pedir('get', '/v2/prueba-permisos/ver', 'adminCache', 403);
      // Alta → uso → baja: se le devuelve el de sistema y el rol se da de baja.
      await pedir('put', `/v2/admins/${admin_id}/staff-role`, 'adminA', 200, {
        staffRoleId: ctx.rolSistemaA,
      });
      await pedir('delete', `/v2/staff-roles/${rol}`, 'adminA', 200);
      await pedir('get', `/v2/staff-roles/${rol}`, 'adminA', 404);
      // Un nombre dado de baja se puede volver a usar.
      const lista = (await pedir(
        'get',
        '/v2/staff-roles',
        'adminA',
        200,
      )) as Array<{
        staffRoleId: string;
      }>;
      expect(lista.map((r) => r.staffRoleId)).not.toContain(rol);
    });

    it('con otro admin con roles.gestionar, quitárselo al rol propio de la C pasa', async () => {
      // Un segundo admin de la C queda con «Administrador» (alta sin rol).
      await sembrarPersona(env.app, 'admin', 'admin-c2', ctx.distC.id);
      const editado = await pedir(
        'patch',
        `/v2/staff-roles/${ctx.rolGestorDeRolesC}`,
        'superEnC',
        200,
        { permissions: ['administradores.gestionar'] },
      );
      expect(editado).toMatchObject({
        permissions: ['administradores.gestionar'],
      });
      await pedir('get', '/v2/staff-roles', 'adminC', 403);
    });

    it('la auditoría asienta el alta del rol y la reasignación con el usuario que las hizo', async () => {
      const filas = await env.app
        .get(DataSource)
        .query<Array<{ entity: string; user_id: string | null }>>(
          `SELECT entity, user_id FROM audit
          WHERE table_name IN ('staff_role', 'admin') AND user_id = $1
          GROUP BY entity, user_id ORDER BY entity`,
          [ctx.adminA.userId],
        );
      expect(filas.map((f) => f.entity)).toEqual(['Admin', 'StaffRole']);
    });
  });
});
