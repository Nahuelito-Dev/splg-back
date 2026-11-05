/**
 * Matriz HTTP T1 (3/4): Admin y Role. Cada caso es una fila de la tabla (ver
 * `matriz.ts`). Roles y administradores: se siembran personas aparte para cada
 * caso que da de baja o modifica.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { FirebaseAuthPort } from '../../../src/firebase/ports/firebase-auth.port';
import { Role } from '../../../src/role/entities/role.entity';
import { User } from '../../../src/users/entities/user.entity';
import { TestEnv, createTestApp, telefonoDePrueba } from '../setup/test-env';
import {
  Caso,
  Escenario,
  Persona,
  cabecerasDe_,
  correrMatriz,
  endpoint,
  sembrarEscenario,
  sembrarPersona,
  llamar,
  reiniciarCuposDelThrottler,
} from './matriz';

interface Ctx extends Escenario {
  adminEditar: Persona & { adminId: string };
  adminBaja: Persona & { adminId: string };
  adminBaja2: Persona & { adminId: string };
  /** Usuarios con rol administrador pero sin perfil, para `POST /admin`. */
  sinPerfilAdmin: Persona;
  sinPerfilAdmin2: Persona;
  sinPerfilCliente: Persona;
  sinPerfilSuper: Persona;
  rolEditar: string;
  rolBaja: string;
  rolBaja2: string;
  rolConUsuarios: string;
  rolSistema: string;
}

const MENSAJE_ROL_DEL_SISTEMA = (accion: string) =>
  `El rol «administrador» es parte del sistema y no se puede ${accion}: lo usan el registro de usuarios y los permisos.`;

describe('Matriz HTTP T1: Admin y Role (e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    const e = await sembrarEscenario(env.app);
    const ds = env.app.get(DataSource);
    const adminPersona = async (n: string) => {
      const p = await sembrarPersona(env.app, 'admin', n, e.distA.id);
      const [fila] = await ds.query<Array<{ admin_id: string }>>(
        `SELECT admin_id FROM admin WHERE user_id = $1`,
        [p.userId],
      );
      return { ...p, adminId: fila.admin_id };
    };
    const sinPerfil = async (tipo: string, n: string): Promise<Persona> => {
      const rol = await ds.getRepository(Role).findOneByOrFail({ type: tipo });
      const email = `${n}.${randomUUID().slice(0, 6)}@splg.local`;
      const phone = telefonoDePrueba();
      const u = (await ds.getRepository(User).save({
        email,
        fullName: `Test ${n}`,
        phoneNumber: phone,
        roleId: rol.roleId,
      } as Partial<User>)) as User;
      return { userId: u.userId, email, phone };
    };
    const rol = async (type: string) =>
      (await ds.getRepository(Role).save({ type } as Partial<Role>)).roleId;
    const rolConUsuarios = await rol(`conusuarios${randomUUID().slice(0, 6)}`);
    await ds.query(`UPDATE "user" SET role_id = $2 WHERE user_id = $1`, [
      (await sinPerfil('admin', 'huesped')).userId,
      rolConUsuarios,
    ]);
    ctx = {
      ...e,
      adminEditar: await adminPersona('admin-editar'),
      adminBaja: await adminPersona('admin-baja'),
      adminBaja2: await adminPersona('admin-baja2'),
      sinPerfilAdmin: await sinPerfil('admin', 'sin-perfil'),
      sinPerfilAdmin2: await sinPerfil('admin', 'sin-perfil2'),
      sinPerfilCliente: await sinPerfil('customer', 'sin-perfil-cli'),
      sinPerfilSuper: await sinPerfil('super_admin', 'sin-perfil-super'),
      rolEditar: await rol(`editar_${randomUUID().slice(0, 6)}`),
      rolBaja2: await rol(`baja2${randomUUID().slice(0, 6)}`),
      rolBaja: await rol(`baja_${randomUUID().slice(0, 6)}`),
      rolConUsuarios,
      rolSistema: (
        await ds.getRepository(Role).findOneByOrFail({ type: 'admin' })
      ).roleId,
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    jest
      .spyOn(env.app.get(FirebaseAuthPort), 'updateUser')
      .mockImplementation((uid) => Promise.resolve({ uid } as never));
    ctx.actores.adminEditar = cabecerasDe_(ctx.adminEditar.email, 'panel-app');
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  const sinToken = { cabeceras: { 'X-Client-Source': 'panel-app' } };
  const sinPermiso = <T extends Caso<Ctx>>(
    f: (
      caso: string,
      actor: string | undefined,
      esp: number,
      extra?: Partial<Caso<Ctx>>,
    ) => T,
    extra: Partial<Caso<Ctx>> = {},
  ): T[] => [
    f('cliente', 'clienteA', 403, extra),
    f('chofer', 'chofer', 403, extra),
  ];
  const ADMIN_Y_SUPER = 'No tenés permiso para esta operación';

  // ============================================================== /admin
  const crear = endpoint<Ctx>('post', '/admin', '/admin');
  const casosCrear: Array<Caso<Ctx>> = [
    crear(
      'admin de empresa con X-Distributor y su distribuidora',
      'super',
      201,
      {
        cabeceras: (c) => ({ 'X-Distributor': c.distA.slug }),
        body: (c) => ({
          user_id: c.sinPerfilAdmin.userId,
          distributor_id: c.distA.id,
        }),
      },
    ),
    crear('super admin sin distribuidora', 'super', 201, {
      body: (c) => ({ user_id: c.sinPerfilSuper.userId }),
    }),
    crear('sin user_id', 'super', 400, { body: {} }),
    crear('user_id que no es uuid', 'super', 400, { body: { user_id: 'x' } }),
    crear('distributor_id que no es uuid', 'super', 400, {
      body: (c) => ({ user_id: c.sinPerfilAdmin2.userId, distributor_id: 'x' }),
    }),
    crear('campo de más', 'super', 400, {
      body: (c) => ({ user_id: c.sinPerfilAdmin2.userId, rol: 'admin' }),
    }),
    crear('el usuario no es administrador', 'super', 400, {
      body: (c) => ({ user_id: c.sinPerfilCliente.userId }),
    }),
    crear('admin de empresa sin distribuidora en el cuerpo', 'super', 400, {
      cabeceras: (c) => ({ 'X-Distributor': c.distA.slug }),
      body: (c) => ({ user_id: c.sinPerfilAdmin2.userId }),
    }),
    crear('admin de empresa sin X-Distributor', 'super', 400, {
      body: (c) => ({
        user_id: c.sinPerfilAdmin2.userId,
        distributor_id: c.distA.id,
      }),
      code: 'MISSING_DISTRIBUTOR',
    }),
    crear('X-Distributor distinta a la del cuerpo', 'super', 400, {
      cabeceras: (c) => ({ 'X-Distributor': c.distB.slug }),
      body: (c) => ({
        user_id: c.sinPerfilAdmin2.userId,
        distributor_id: c.distA.id,
      }),
    }),
    crear('sin token', undefined, 401, { ...sinToken, body: {} }),
    crear('admin de empresa', 'adminA', 403, {
      body: {},
      mensaje: ADMIN_Y_SUPER,
    }),
    ...sinPermiso(crear, { body: {} }),
    crear('el usuario no existe', 'super', 404, {
      body: (c) => ({ user_id: c.inexistente }),
    }),
    crear('el usuario ya tiene perfil', 'super', 409, {
      cabeceras: (c) => ({ 'X-Distributor': c.distA.slug }),
      body: (c) => ({ user_id: c.adminA2.userId, distributor_id: c.distA.id }),
    }),
  ];

  const listar = endpoint<Ctx>('get', '/admin', '/admin');
  const casosListar: Array<Caso<Ctx>> = [
    listar('admin ve los de su empresa', 'adminA', 200, {
      verificar: (c, x) => {
        const t = JSON.stringify(c);
        expect(t).toContain(x.adminA.email);
        expect(t).not.toContain(x.adminB.email);
      },
    }),
    listar('super admin ve todos', 'super', 200, {
      verificar: (c, x) => {
        const t = JSON.stringify(c);
        expect(t).toContain(x.adminA.email);
        expect(t).toContain(x.adminB.email);
      },
    }),
    listar('super admin elige una distribuidora', 'super', 200, {
      ruta: (c) => `/admin?distributorId=${c.distB.id}`,
      verificar: (c, x) => {
        const t = JSON.stringify(c);
        expect(t).toContain(x.adminB.email);
        expect(t).not.toContain(x.adminA.email);
      },
    }),
    listar('admin pide la suya por distributorId', 'adminA', 200, {
      ruta: (c) => `/admin?distributorId=${c.distA.id}`,
      verificar: (c, x) => {
        const t = JSON.stringify(c);
        expect(t).toContain(x.adminA.email);
        expect(t).not.toContain(x.adminB.email);
      },
    }),
    listar('distributorId que no es uuid', 'super', 400, {
      ruta: '/admin?distributorId=x',
    }),
    listar('parámetro que no existe', 'super', 400, { ruta: '/admin?foo=1' }),
    listar('sin token', undefined, 401, sinToken),
    listar('admin pide los de otra empresa', 'adminA', 403, {
      ruta: (c) => `/admin?distributorId=${c.distB.id}`,
    }),
    ...sinPermiso(listar),
  ];

  const porTermino = endpoint<Ctx>(
    'get',
    '/admin/term/{term}',
    (c) => `/admin/term/${c.adminA.email}`,
  );
  const casosPorTermino: Array<Caso<Ctx>> = [
    porTermino('por correo', 'adminA', 200, {
      verificar: (c, x) => expect(JSON.stringify(c)).toContain(x.adminA.email),
    }),
    porTermino('por id de administrador', 'adminA', 200, {
      ruta: (c) => `/admin/term/${c.adminA.adminId}`,
      verificar: (c, x) => expect(JSON.stringify(c)).toContain(x.adminA.email),
    }),
    porTermino('super admin', 'super', 200),
    porTermino('sin token', undefined, 401, sinToken),
    ...sinPermiso(porTermino),
    porTermino('no existe', 'adminA', 404, {
      ruta: '/admin/term/nadie@splg.local',
    }),
    porTermino('de otra empresa', 'adminB', 404),
  ];

  const ficha = endpoint<Ctx>(
    'get',
    '/admin/{id}',
    (c) => `/admin/${c.adminA.adminId}`,
  );
  const casosFicha: Array<Caso<Ctx>> = [
    ficha('admin de la empresa', 'adminA', 200),
    ficha('super admin', 'super', 200),
    ficha('id mal formado', 'adminA', 400, {
      ruta: '/admin/no-es-uuid',
      code: 'INVALID_ID',
    }),
    ficha('sin token', undefined, 401, sinToken),
    ...sinPermiso(ficha),
    ficha('no existe', 'adminA', 404, {
      ruta: (c) => `/admin/${c.inexistente}`,
    }),
    ficha('de otra empresa', 'adminB', 404),
  ];

  const editar = endpoint<Ctx>(
    'patch',
    '/admin/{id}',
    (c) => `/admin/${c.adminEditar.adminId}`,
  );
  const casosEditar: Array<Caso<Ctx>> = [
    editar('admin edita nombre y teléfono', 'adminA', 200, {
      body: { fullName: 'Nombre Nuevo', phoneNumber: '+5493764999001' },
    }),
    editar('super admin con X-Distributor', 'super', 200, {
      cabeceras: (c) => ({ 'X-Distributor': c.distA.slug }),
      body: { fullName: 'Otro Nombre' },
    }),
    editar('cuerpo vacío', 'adminA', 200, { body: {} }),
    editar('fullName de 1 letra', 'adminA', 400, { body: { fullName: 'A' } }),
    editar('fullName que no es texto', 'adminA', 400, {
      body: { fullName: 5 },
    }),
    editar('teléfono fuera de E.164', 'adminA', 400, {
      body: { phoneNumber: '123' },
    }),
    editar('el correo no se edita', 'adminA', 400, {
      body: { email: 'x@splg.local' },
    }),
    editar('campo de más', 'adminA', 400, { body: { blocked: true } }),
    editar('id mal formado', 'adminA', 400, {
      ruta: '/admin/no-es-uuid',
      body: {},
      code: 'INVALID_ID',
    }),
    editar('super admin sin decir la distribuidora', 'super', 400, {
      body: { fullName: 'Ana' },
      code: 'MISSING_DISTRIBUTOR',
    }),
    editar('sin token', undefined, 401, { ...sinToken, body: {} }),
    ...sinPermiso(editar, { body: {} }),
    editar('admin se edita a sí mismo', 'adminA', 403, {
      ruta: (c) => `/admin/${c.adminA.adminId}`,
      body: { fullName: 'Ana' },
    }),
    editar('no existe', 'adminA', 404, {
      ruta: (c) => `/admin/${c.inexistente}`,
      body: {},
    }),
    editar('de otra empresa', 'adminB', 404, { body: { fullName: 'Ana' } }),
    editar('un super admin (para el admin de empresa)', 'adminA', 404, {
      ruta: (c) => `/admin/${c.superAdmin.adminId}`,
      body: { fullName: 'Ana' },
    }),
    editar('teléfono en uso por otra cuenta', 'adminA', 409, {
      body: (c) => ({ phoneNumber: c.clienteA.phone }),
    }),
  ];

  const baja = endpoint<Ctx>(
    'delete',
    '/admin/{id}',
    (c) => `/admin/${c.adminBaja.adminId}`,
  );
  const casosBaja: Array<Caso<Ctx>> = [
    baja('id mal formado', 'adminA', 400, {
      ruta: '/admin/no-es-uuid',
      code: 'INVALID_ID',
    }),
    baja('sin token', undefined, 401, sinToken),
    ...sinPermiso(baja),
    baja('admin se da de baja a sí mismo', 'adminA', 403, {
      ruta: (c) => `/admin/${c.adminA.adminId}`,
    }),
    baja('super admin se da de baja a sí mismo', 'super', 403, {
      ruta: (c) => `/admin/${c.superAdmin.adminId}`,
    }),
    baja('no existe', 'adminA', 404, {
      ruta: (c) => `/admin/${c.inexistente}`,
    }),
    baja('de otra empresa', 'adminB', 404),
    baja('último administrador de la empresa', 'super', 409, {
      ruta: (c) => `/admin/${c.adminB.adminId}`,
      cabeceras: (c) => ({ 'X-Distributor': c.distB.slug }),
    }),
    baja('admin da de baja a su par', 'adminA', 200, {
      verificar: (c) =>
        expect((c as { message: string }).message).toMatch(/baja/),
    }),
    baja('ya dado de baja', 'adminA', 404, {
      ruta: (c) => `/admin/${c.adminBaja2.adminId}`,
      antes: (x) =>
        llamar(x, 'delete', `/admin/${x.adminBaja2.adminId}`, 'adminA').then(
          () => undefined,
        ),
    }),
  ];

  // =============================================================== /role
  const nuevoRol = endpoint<Ctx>('post', '/role', '/role');
  const casosCrearRol: Array<Caso<Ctx>> = [
    nuevoRol('super admin crea un rol', 'super', 201, {
      body: { type: `qa_${randomUUID().slice(0, 6)}` },
    }),
    nuevoRol('sin type', 'super', 400, { body: {} }),
    nuevoRol('type vacío', 'super', 400, { body: { type: '' } }),
    nuevoRol('type que no es texto', 'super', 400, { body: { type: 5 } }),
    nuevoRol('campo de más', 'super', 400, {
      body: { type: 'x', permisos: [] },
    }),
    nuevoRol('sin token', undefined, 401, { ...sinToken, body: { type: 'x' } }),
    nuevoRol('admin de empresa', 'adminA', 403, {
      body: { type: 'x' },
      mensaje: 'super administrador',
    }),
    ...sinPermiso(nuevoRol, { body: { type: 'x' } }),
    nuevoRol('rol que ya existe', 'super', 409, {
      body: { type: 'admin' },
      mensajeExacto: 'Ya existe un registro con esos datos',
    }),
  ];

  const listarRoles = endpoint<Ctx>('get', '/role', '/role');
  const casosListarRoles: Array<Caso<Ctx>> = [
    listarRoles('super admin', 'super', 200, {
      verificar: (c) =>
        expect((c as unknown[]).length).toBeGreaterThanOrEqual(4),
    }),
    listarRoles('sin token', undefined, 401, sinToken),
    listarRoles('admin de empresa', 'adminA', 403),
    ...sinPermiso(listarRoles),
  ];

  const unRol = endpoint<Ctx>(
    'get',
    '/role/{id}',
    (c) => `/role/${c.rolEditar}`,
  );
  const casosUnRol: Array<Caso<Ctx>> = [
    unRol('super admin', 'super', 200),
    unRol('id mal formado', 'super', 400, {
      ruta: '/role/no-es-uuid',
      code: 'INVALID_ID',
    }),
    unRol('sin token', undefined, 401, sinToken),
    unRol('admin de empresa', 'adminA', 403),
    ...sinPermiso(unRol),
    unRol('no existe', 'super', 404, { ruta: (c) => `/role/${c.inexistente}` }),
  ];

  const editarRol = endpoint<Ctx>(
    'patch',
    '/role/{id}',
    (c) => `/role/${c.rolEditar}`,
  );
  const casosEditarRol: Array<Caso<Ctx>> = [
    editarRol('super admin renombra un rol propio', 'super', 200, {
      body: { type: `renombrado_${randomUUID().slice(0, 6)}` },
    }),
    editarRol('cuerpo vacío', 'super', 200, { body: {} }),
    editarRol('type vacío', 'super', 400, { body: { type: '' } }),
    editarRol('type que no es texto', 'super', 400, { body: { type: 5 } }),
    editarRol('campo de más', 'super', 400, { body: { x: 1 } }),
    editarRol('id mal formado', 'super', 400, {
      ruta: '/role/no-es-uuid',
      body: {},
      code: 'INVALID_ID',
    }),
    editarRol('sin token', undefined, 401, { ...sinToken, body: {} }),
    editarRol('admin de empresa', 'adminA', 403, { body: {} }),
    ...sinPermiso(editarRol, { body: {} }),
    editarRol('no existe', 'super', 404, {
      ruta: (c) => `/role/${c.inexistente}`,
      body: {},
    }),
    editarRol('rol del sistema', 'super', 409, {
      ruta: (c) => `/role/${c.rolSistema}`,
      body: { type: 'otro' },
      mensajeExacto: MENSAJE_ROL_DEL_SISTEMA('modificar'),
    }),
    editarRol('renombrar a un nombre que ya existe', 'super', 409, {
      body: { type: 'customer' },
    }),
  ];

  const bajaRol = endpoint<Ctx>(
    'delete',
    '/role/{id}',
    (c) => `/role/${c.rolBaja}`,
  );
  const casosBajaRol: Array<Caso<Ctx>> = [
    bajaRol('id mal formado', 'super', 400, {
      ruta: '/role/no-es-uuid',
      code: 'INVALID_ID',
    }),
    bajaRol('sin token', undefined, 401, sinToken),
    bajaRol('admin de empresa', 'adminA', 403),
    ...sinPermiso(bajaRol),
    bajaRol('no existe', 'super', 404, {
      ruta: (c) => `/role/${c.inexistente}`,
    }),
    bajaRol('rol del sistema', 'super', 409, {
      ruta: (c) => `/role/${c.rolSistema}`,
      mensajeExacto: MENSAJE_ROL_DEL_SISTEMA('dar de baja'),
    }),
    bajaRol('rol con usuarios', 'super', 409, {
      ruta: (c) => `/role/${c.rolConUsuarios}`,
    }),
    bajaRol('super admin da de baja un rol propio', 'super', 200),
    bajaRol('ya dado de baja', 'super', 404, {
      ruta: (c) => `/role/${c.rolBaja2}`,
      antes: (x) =>
        llamar(x, 'delete', `/role/${x.rolBaja2}`, 'super').then(
          () => undefined,
        ),
    }),
  ];

  const seed = endpoint<Ctx>('post', '/role/seed', '/role/seed');
  const casosSeed: Array<Caso<Ctx>> = [
    seed('super admin', 'super', 201),
    seed('otra vez (no duplica)', 'super', 201),
    seed('sin token', undefined, 401, sinToken),
    seed('admin de empresa', 'adminA', 403),
    ...sinPermiso(seed),
  ];

  correrMatriz('POST /admin', ver, casosCrear);
  correrMatriz('GET /admin', ver, casosListar);
  correrMatriz('GET /admin/term/{term}', ver, casosPorTermino);
  correrMatriz('GET /admin/{id}', ver, casosFicha);
  correrMatriz('PATCH /admin/{id}', ver, casosEditar);
  correrMatriz('DELETE /admin/{id}', ver, casosBaja);
  correrMatriz('POST /role', ver, casosCrearRol);
  correrMatriz('GET /role', ver, casosListarRoles);
  correrMatriz('GET /role/{id}', ver, casosUnRol);
  correrMatriz('PATCH /role/{id}', ver, casosEditarRol);
  correrMatriz('DELETE /role/{id}', ver, casosBajaRol);
  correrMatriz('POST /role/seed', ver, casosSeed);
});
