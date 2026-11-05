/**
 * Matriz HTTP T1 (2/4): Users, alta desde el panel (POST /users) y People.
 * Cada caso es una fila de la tabla (ver `matriz.ts`). Las fotos van contra un
 * MinIO efímero; el resto, contra Postgres y Redis efímeros.
 */
import request from 'supertest';
import { DataSource } from 'typeorm';
import { FirebaseAuthPort } from '../../../src/firebase/ports/firebase-auth.port';
import { TestEnv, createTestApp, telefonoDePrueba } from '../setup/test-env';
import { TestMinio, startMinio } from '../setup/minio';
import { PNG_REAL } from '../setup/imagenes';
import {
  Adjunto,
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
  verificarCastellano,
} from './matriz';

interface Ctx extends Escenario {
  /** Choferes de A para operaciones de a una (cada caso destructivo, el suyo). */
  choferEditar: Persona;
  choferBloquear: Persona;
  choferBaja: Persona;
  choferBaja2: Persona;
  choferFoto: Persona;
  choferSinCuenta: Persona;
  clienteBaja: Persona;
  clienteBaja2: Persona;
  /** Un cliente de A con el que se prueban los listados y las fichas. */
  clienteFicha: Persona;
}

/** Un número argentino válido para libphonenumber (los de prueba al azar no lo son). */
const TELEFONO_REAL = '+5493764123456';

const png: Adjunto = {
  campo: 'file',
  contenido: PNG_REAL,
  nombre: 'foto.png',
  tipo: 'image/png',
};
const htmlComoPng: Adjunto = {
  campo: 'file',
  contenido: Buffer.from('<html><script>alert(1)</script></html>'),
  nombre: 'foto.png',
  tipo: 'image/png',
};
const gigante: Adjunto = {
  campo: 'file',
  contenido: Buffer.concat([PNG_REAL, Buffer.alloc(6 * 1024 * 1024)]),
  nombre: 'foto.png',
  tipo: 'image/png',
};

describe('Matriz HTTP T1: Users, alta del panel y People (e2e)', () => {
  let env: TestEnv;
  let minio: TestMinio;
  let ctx: Ctx;
  const ver = () => ctx;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    minio = await startMinio();
    env = await createTestApp({ s3: minio.env });
    const e = await sembrarEscenario(env.app);
    const mas = (t: 'customer' | 'delivery' | 'admin', n: string) =>
      sembrarPersona(env.app, t, n, e.distA.id);
    const choferEditar = await mas('delivery', 'chofer-editar');
    const choferBloquear = await mas('delivery', 'chofer-bloquear');
    const choferBaja = await mas('delivery', 'chofer-baja');
    const choferBaja2 = await mas('delivery', 'chofer-baja2');
    const choferFoto = await mas('delivery', 'chofer-foto');
    const choferSinCuenta = await mas('delivery', 'chofer-sin-cuenta');
    const clienteBaja = await mas('customer', 'cliente-baja');
    const clienteBaja2 = await mas('customer', 'cliente-baja2');
    const clienteFicha = await mas('customer', 'cliente-ficha');
    await env.app
      .get(DataSource)
      .query(`UPDATE "user" SET firebase_uid = NULL WHERE user_id = $1`, [
        choferSinCuenta.userId,
      ]);
    await env.app
      .get(DataSource)
      .query(`UPDATE "user" SET phone_number = $2 WHERE user_id = $1`, [
        e.clienteA.userId,
        TELEFONO_REAL,
      ]);
    e.clienteA.phone = TELEFONO_REAL;
    // Con foto: para que el `null` del aislamiento de People pruebe algo.
    for (const id of [clienteFicha.userId, e.clienteB.userId]) {
      await env.app
        .get(DataSource)
        .query(`UPDATE "user" SET photo_key = $2 WHERE user_id = $1`, [
          id,
          `users/${id}/foto.jpg`,
        ]);
    }
    ctx = {
      ...e,
      choferEditar,
      choferBloquear,
      choferBaja,
      choferBaja2,
      choferFoto,
      choferSinCuenta,
      clienteBaja,
      clienteBaja2,
      clienteFicha,
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    ctx.actores.clienteBaja = cabecerasDe_(
      clienteBaja.email,
      'customer-app',
      e.distA.slug,
    );
    ctx.actores.clienteBaja2 = cabecerasDe_(
      clienteBaja2.email,
      'customer-app',
      e.distA.slug,
    );
    const firebase = env.app.get(FirebaseAuthPort);
    jest
      .spyOn(firebase, 'createUserSafe')
      .mockImplementation((datos) =>
        Promise.resolve({ uid: `uid-${datos.email}` } as never),
      );
    jest.spyOn(firebase, 'deleteUserSafe').mockResolvedValue();
    jest
      .spyOn(firebase, 'updateUser')
      .mockImplementation((uid) => Promise.resolve({ uid } as never));
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
    await minio.stop();
  });

  // =============================================================== listado
  const listar = endpoint<Ctx>('get', '/users', '/users');
  const q = (s: string) => ({ ruta: `/users${s}` });
  const usersDe = (c: unknown) => (c as { users: unknown[] }).users;
  const casosListado: Array<Caso<Ctx>> = [
    listar('admin de empresa', 'adminA', 200, {
      ruta: '/users?limit=100',
      verificar: (c, x) => {
        const correos = JSON.stringify(c);
        expect(correos).toContain(x.clienteA.email);
        expect(correos).not.toContain(x.clienteB.email);
      },
    }),
    listar('super admin sin distribuidora ve todo', 'super', 200, {
      ruta: '/users?limit=100',
      verificar: (c, x) => {
        const correos = JSON.stringify(c);
        expect(correos).toContain(x.clienteA.email);
        expect(correos).toContain(x.clienteB.email);
      },
    }),
    listar('super admin "viendo como" B', 'super', 200, {
      cabeceras: (x) => ({ 'X-Distributor': x.distB.slug }),
      ruta: '/users?limit=100',
      verificar: (c, x) => {
        const correos = JSON.stringify(c);
        expect(correos).toContain(x.clienteB.email);
        expect(correos).not.toContain(x.clienteA.email);
      },
    }),
    listar('filtra por role', 'adminA', 200, {
      ...q('?role=delivery'),
      verificar: (c) => expect(usersDe(c).length).toBeGreaterThan(0),
    }),
    listar('busca por term', 'adminA', 200, {
      ...q('?term=cliente-ficha'),
      verificar: (c) => expect(usersDe(c)).toHaveLength(1),
    }),
    listar('paginado', 'adminA', 200, {
      ...q('?limit=2&page=1&offset=0'),
      verificar: (c) => expect(usersDe(c)).toHaveLength(2),
    }),
    listar('role inválido', 'adminA', 400, q('?role=jefe')),
    listar('limit en cero', 'adminA', 400, q('?limit=0')),
    listar('limit mayor al máximo', 'adminA', 400, q('?limit=101')),
    listar('limit que no es número', 'adminA', 400, q('?limit=muchos')),
    listar('offset negativo', 'adminA', 400, q('?offset=-1')),
    listar('page en cero', 'adminA', 400, q('?page=0')),
    listar('parámetro que no existe', 'adminA', 400, q('?foo=1')),
    listar('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
    }),
    listar('token de un usuario inexistente', 'tokenInvalido', 401, {
      cabeceras: { Authorization: 'Bearer nadie@splg.local' },
    }),
    listar('cliente', 'clienteA', 403),
    listar('chofer', 'chofer', 403),
  ];

  // ============================================================ por correo
  const porEmail = endpoint<Ctx>(
    'get',
    '/users/email/{email}',
    (c) => `/users/email/${c.clienteFicha.email}`,
  );
  const casosPorEmail: Array<Caso<Ctx>> = [
    porEmail('admin de la empresa', 'adminA', 200),
    porEmail('super admin', 'super', 200),
    porEmail('el cliente a sí mismo', 'clienteA', 200, {
      ruta: (c) => `/users/email/${c.clienteA.email}`,
    }),
    porEmail('correo mal formado', 'adminA', 400, {
      ruta: '/users/email/no-es-correo',
    }),
    porEmail('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
    }),
    porEmail('cliente que pide a otro', 'clienteA', 403),
    porEmail('chofer que pide a otro', 'chofer', 403),
    porEmail('correo que no existe', 'adminA', 404, {
      ruta: '/users/email/nadie@splg.local',
    }),
    porEmail('cliente de otra distribuidora', 'adminB', 404),
  ];

  // =============================================================== por id
  const porId = endpoint<Ctx>(
    'get',
    '/users/{id}',
    (c) => `/users/${c.clienteFicha.userId}`,
  );
  const casosPorId: Array<Caso<Ctx>> = [
    porId('admin de la empresa', 'adminA', 200, {
      verificar: (c, x) =>
        expect((c as { email: string }).email).toBe(x.clienteFicha.email),
    }),
    porId('super admin sin distribuidora', 'super', 200),
    porId('el cliente a sí mismo', 'clienteA', 200, {
      ruta: (c) => `/users/${c.clienteA.userId}`,
    }),
    porId('id mal formado', 'adminA', 400, {
      ruta: '/users/no-es-uuid',
      code: 'INVALID_ID',
    }),
    porId('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
    }),
    porId('cliente que pide a otro', 'clienteA', 403),
    porId('chofer que pide a otro', 'chofer', 403),
    porId('id que no existe', 'adminA', 404, {
      ruta: (c) => `/users/${c.inexistente}`,
    }),
    porId('de otra distribuidora', 'adminB', 404),
    porId('super admin "viendo como" otra distribuidora', 'super', 404, {
      cabeceras: (c) => ({ 'X-Distributor': c.distB.slug }),
    }),
    porId('distribuidora del header que no existe', 'super', 401, {
      cabeceras: { 'X-Distributor': 'no-existe' },
    }),
  ];

  // ============================================================ por teléfono
  const porTelefono = endpoint<Ctx>(
    'get',
    '/users/phone/{phoneNumber}',
    (c) => `/users/phone/${encodeURIComponent(c.clienteFicha.phone)}`,
  );
  const casosPorTelefono: Array<Caso<Ctx>> = [
    porTelefono('admin de la empresa', 'adminA', 200, {
      verificar: (c, x) =>
        expect((c as { email: string }).email).toBe(x.clienteFicha.email),
    }),
    porTelefono('super admin', 'super', 200),
    porTelefono('nadie tiene ese teléfono (200 vacío)', 'adminA', 200, {
      ruta: '/users/phone/%2B5491100000000',
    }),
    porTelefono('formato que no es E.164', 'adminA', 400, {
      ruta: '/users/phone/12345',
    }),
    porTelefono('con letras', 'adminA', 400, { ruta: '/users/phone/abc' }),
    porTelefono('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
    }),
    porTelefono('cliente', 'clienteA', 403),
    porTelefono('chofer', 'chofer', 403),
    porTelefono('de otra distribuidora', 'adminB', 404),
  ];

  // ============================================================= PATCH :id
  const editar = endpoint<Ctx>(
    'patch',
    '/users/{id}',
    (c) => `/users/${c.choferEditar.userId}`,
  );
  const casosEditar: Array<Caso<Ctx>> = [
    editar('admin cambia nombre', 'adminA', 200, {
      body: { full_name: 'Nombre Nuevo' },
      verificar: (c) =>
        expect(
          (c as { full_name?: string; fullName?: string }).full_name ??
            (c as { fullName?: string }).fullName,
        ).toBe('Nombre Nuevo'),
    }),
    editar('admin cambia la contraseña', 'adminA', 200, {
      body: { password: 'Nueva1234' },
    }),
    editar('el cliente edita su nombre', 'clienteA', 200, {
      ruta: (c) => `/users/${c.clienteA.userId}`,
      body: { full_name: 'Cliente Editado' },
    }),
    editar('full_name de 1 letra', 'adminA', 400, { body: { full_name: 'A' } }),
    editar('full_name que no es texto', 'adminA', 400, {
      body: { full_name: 5 },
    }),
    editar('teléfono fuera de E.164', 'adminA', 400, {
      body: { phone_number: '123' },
    }),
    editar('blocked que no es booleano', 'adminA', 400, {
      body: { blocked: 'si' },
    }),
    editar('password de 5 caracteres', 'adminA', 400, {
      body: { password: '12345' },
    }),
    editar('el correo no se edita (campo de más)', 'adminA', 400, {
      body: { email: 'otro@splg.local' },
    }),
    editar('rol (campo de más)', 'adminA', 400, { body: { rol: 'admin' } }),
    editar('id mal formado', 'adminA', 400, {
      ruta: '/users/no-es-uuid',
      body: { full_name: 'Ana' },
      code: 'INVALID_ID',
    }),
    editar('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
      body: { full_name: 'Ana' },
    }),
    editar('cliente edita a otro', 'clienteA', 403, {
      body: { full_name: 'Ana' },
    }),
    editar('cliente intenta cambiar la contraseña', 'clienteA', 403, {
      ruta: (c) => `/users/${c.clienteA.userId}`,
      body: { password: 'Nueva1234' },
    }),
    editar('cliente intenta bloquearse', 'clienteA', 403, {
      ruta: (c) => `/users/${c.clienteA.userId}`,
      body: { blocked: true },
    }),
    editar('chofer edita a otro', 'chofer', 403, {
      body: { full_name: 'Ana' },
    }),
    editar('admin se bloquea a sí mismo', 'adminA', 403, {
      ruta: (c) => `/users/${c.adminA.userId}`,
      body: { blocked: true },
    }),
    editar('admin edita la cuenta de un cliente', 'adminA', 403, {
      ruta: (c) => `/users/${c.clienteFicha.userId}`,
      body: { full_name: 'Ana' },
    }),
    editar('id que no existe', 'adminA', 404, {
      ruta: (c) => `/users/${c.inexistente}`,
      body: { full_name: 'Ana' },
    }),
    editar('de otra distribuidora', 'adminB', 404, {
      body: { full_name: 'Ana' },
    }),
    editar('teléfono en uso por otro usuario', 'adminA', 409, {
      body: (c) => ({ phone_number: c.clienteA.phone }),
    }),
    editar('cuenta sin acceso (cambio de contraseña)', 'adminA', 409, {
      ruta: (c) => `/users/${c.choferSinCuenta.userId}`,
      body: { password: 'Nueva1234' },
    }),
  ];

  // ============================================================ PATCH block
  const bloquear = endpoint<Ctx>(
    'patch',
    '/users/{id}/block',
    (c) => `/users/${c.choferBloquear.userId}/block`,
  );
  const casosBloquear: Array<Caso<Ctx>> = [
    bloquear('admin bloquea', 'adminA', 200, {
      body: { block: true },
      verificar: (c) =>
        expect(c).toMatchObject({
          isBlocked: true,
          message: 'Usuario bloqueado',
        }),
    }),
    bloquear('admin desbloquea', 'adminA', 200, {
      body: { block: false },
      antes: (x) =>
        llamar(
          x,
          'patch',
          `/users/${x.choferBloquear.userId}/block`,
          'adminA',
          {
            block: true,
          },
        ).then(() => undefined),
      verificar: (c) =>
        expect(c).toMatchObject({
          isBlocked: false,
          message: 'Usuario desbloqueado',
        }),
    }),
    bloquear('block ausente', 'adminA', 400, { body: {} }),
    bloquear('block que no es booleano', 'adminA', 400, {
      body: { block: 'si' },
    }),
    bloquear('campo de más', 'adminA', 400, {
      body: { block: true, motivo: 'x' },
    }),
    bloquear('id mal formado', 'adminA', 400, {
      ruta: '/users/no-es-uuid/block',
      body: { block: true },
      code: 'INVALID_ID',
    }),
    bloquear('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
      body: { block: true },
    }),
    bloquear('cliente', 'clienteA', 403, { body: { block: true } }),
    bloquear('chofer', 'chofer', 403, { body: { block: true } }),
    bloquear('admin bloquea una cuenta de cliente', 'adminA', 403, {
      ruta: (c) => `/users/${c.clienteFicha.userId}/block`,
      body: { block: true },
    }),
    bloquear('admin se bloquea a sí mismo', 'adminA', 403, {
      ruta: (c) => `/users/${c.adminA.userId}/block`,
      body: { block: true },
    }),
    bloquear('id que no existe', 'adminA', 404, {
      ruta: (c) => `/users/${c.inexistente}/block`,
      body: { block: true },
    }),
    bloquear('de otra distribuidora', 'adminB', 404, { body: { block: true } }),
    bloquear('último administrador de la empresa', 'super', 409, {
      ruta: (c) => `/users/${c.adminB.userId}/block`,
      cabeceras: (c) => ({ 'X-Distributor': c.distB.slug }),
      body: { block: true },
    }),
    bloquear('super admin sin decir en qué distribuidora actúa', 'super', 400, {
      body: { block: true },
      code: 'MISSING_DISTRIBUTOR',
    }),
  ];

  // ============================================================= DELETE :id
  const baja = endpoint<Ctx>(
    'delete',
    '/users/{id}',
    (c) => `/users/${c.choferBaja.userId}`,
  );
  const casosBaja: Array<Caso<Ctx>> = [
    baja('id mal formado', 'adminA', 400, {
      ruta: '/users/no-es-uuid',
      code: 'INVALID_ID',
    }),
    baja('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
    }),
    baja('cliente', 'clienteA', 403),
    baja('chofer', 'chofer', 403),
    baja('admin da de baja una cuenta de cliente', 'adminA', 403, {
      ruta: (c) => `/users/${c.clienteFicha.userId}`,
    }),
    baja('admin se da de baja a sí mismo', 'adminA', 403, {
      ruta: (c) => `/users/${c.adminA.userId}`,
    }),
    baja('id que no existe', 'adminA', 404, {
      ruta: (c) => `/users/${c.inexistente}`,
    }),
    baja('de otra distribuidora', 'adminB', 404),
    baja('último administrador de la empresa', 'super', 409, {
      ruta: (c) => `/users/${c.adminB.userId}`,
      cabeceras: (c) => ({ 'X-Distributor': c.distB.slug }),
    }),
    baja('chofer del admin', 'adminA', 200, {
      verificar: (c) =>
        expect((c as { message: string }).message).toMatch(/baja/),
    }),
    baja('ya dado de baja', 'adminA', 404, {
      ruta: (c) => `/users/${c.choferBaja2.userId}`,
      antes: (x) =>
        llamar(x, 'delete', `/users/${x.choferBaja2.userId}`, 'adminA').then(
          () => undefined,
        ),
    }),
  ];

  // ============================================================= DELETE me
  const bajaPropia = endpoint<Ctx>('delete', '/users/me', '/users/me');
  const casosBajaPropia: Array<Caso<Ctx>> = [
    bajaPropia('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'customer-app' },
    }),
    bajaPropia('chofer', 'chofer', 403),
    bajaPropia('admin', 'adminA', 403),
    bajaPropia('el cliente se da de baja', 'clienteBaja', 200),
    bajaPropia('con el token anterior la sesión terminó', 'clienteBaja2', 401, {
      antes: (x) =>
        llamar(x, 'delete', '/users/me', 'clienteBaja2').then(() => undefined),
    }),
  ];

  // ======================================================== fotos (propias)
  const miFoto = endpoint<Ctx>('put', '/users/me/photo', '/users/me/photo');
  const casosMiFoto: Array<Caso<Ctx>> = [
    miFoto('el cliente sube su foto', 'clienteA', 200, { adjunto: png }),
    miFoto('sin archivo', 'clienteA', 400),
    miFoto('el contenido no es una imagen', 'clienteA', 415, {
      adjunto: htmlComoPng,
    }),
    miFoto('foto de más de 5 MB', 'clienteA', 413, { adjunto: gigante }),
    miFoto('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'customer-app' },
      adjunto: png,
    }),
  ];
  const verMiFoto = endpoint<Ctx>('get', '/users/me/photo', '/users/me/photo');
  const casosVerMiFoto: Array<Caso<Ctx>> = [
    verMiFoto('con foto: enlace (modo=url)', 'clienteA', 200, {
      ruta: '/users/me/photo?modo=url',
      antes: (x) =>
        llamar(x, 'put', '/users/me/photo', 'clienteA', undefined, png).then(
          () => undefined,
        ),
      verificar: (c) =>
        expect(typeof (c as { url: string }).url).toBe('string'),
    }),
    verMiFoto('sin foto: url nula (modo=url)', 'chofer', 200, {
      ruta: '/users/me/photo?modo=url',
      verificar: (c) => expect((c as { url: unknown }).url).toBeNull(),
    }),
    verMiFoto('sin foto y sin modo', 'chofer', 404),
    verMiFoto('modo inválido', 'clienteA', 400, {
      ruta: '/users/me/photo?modo=otro',
    }),
    verMiFoto('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'customer-app' },
    }),
  ];
  const sacarMiFoto = endpoint<Ctx>(
    'delete',
    '/users/me/photo',
    '/users/me/photo',
  );
  const casosSacarMiFoto: Array<Caso<Ctx>> = [
    sacarMiFoto('el cliente saca su foto', 'clienteA', 200, {
      antes: (x) =>
        llamar(x, 'put', '/users/me/photo', 'clienteA', undefined, png).then(
          () => undefined,
        ),
    }),
    sacarMiFoto('sin foto (sigue en 200)', 'clienteA', 200, {
      antes: (x) =>
        llamar(x, 'delete', '/users/me/photo', 'clienteA').then(
          () => undefined,
        ),
    }),
    sacarMiFoto('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'customer-app' },
    }),
  ];

  // ===================================================== fotos (de un id)
  const subirFoto = endpoint<Ctx>(
    'put',
    '/users/{id}/photo',
    (c) => `/users/${c.choferFoto.userId}/photo`,
  );
  const casosSubirFoto: Array<Caso<Ctx>> = [
    subirFoto('admin sube la foto de su chofer', 'adminA', 200, {
      adjunto: png,
    }),
    subirFoto('admin sube la suya', 'adminA', 200, {
      ruta: (c) => `/users/${c.adminA.userId}/photo`,
      adjunto: png,
    }),
    subirFoto('sin archivo', 'adminA', 400),
    subirFoto('id mal formado', 'adminA', 400, {
      ruta: '/users/no-es-uuid/photo',
      adjunto: png,
      code: 'INVALID_ID',
    }),
    subirFoto('contenido que no es una imagen', 'adminA', 415, {
      adjunto: htmlComoPng,
    }),
    subirFoto('foto de más de 5 MB', 'adminA', 413, { adjunto: gigante }),
    subirFoto('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
      adjunto: png,
    }),
    subirFoto('cliente', 'clienteA', 403, { adjunto: png }),
    subirFoto('chofer', 'chofer', 403, { adjunto: png }),
    subirFoto('admin sube la foto de un cliente', 'adminA', 403, {
      ruta: (c) => `/users/${c.clienteFicha.userId}/photo`,
      adjunto: png,
    }),
    subirFoto('id que no existe', 'adminA', 404, {
      ruta: (c) => `/users/${c.inexistente}/photo`,
      adjunto: png,
    }),
    subirFoto('de otra distribuidora', 'adminB', 404, { adjunto: png }),
  ];
  const sacarFoto = endpoint<Ctx>(
    'delete',
    '/users/{id}/photo',
    (c) => `/users/${c.choferFoto.userId}/photo`,
  );
  const casosSacarFoto: Array<Caso<Ctx>> = [
    sacarFoto('admin saca la foto de su chofer', 'adminA', 200),
    sacarFoto('id mal formado', 'adminA', 400, {
      ruta: '/users/no-es-uuid/photo',
      code: 'INVALID_ID',
    }),
    sacarFoto('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
    }),
    sacarFoto('cliente', 'clienteA', 403),
    sacarFoto('chofer', 'chofer', 403),
    sacarFoto('admin saca la foto de un cliente', 'adminA', 403, {
      ruta: (c) => `/users/${c.clienteFicha.userId}/photo`,
    }),
    sacarFoto('id que no existe', 'adminA', 404, {
      ruta: (c) => `/users/${c.inexistente}/photo`,
    }),
    sacarFoto('de otra distribuidora', 'adminB', 404),
  ];
  const verFoto = endpoint<Ctx>(
    'get',
    '/users/{id}/photo',
    (c) => `/users/${c.adminA.userId}/photo?modo=url`,
  );
  const casosVerFoto: Array<Caso<Ctx>> = [
    verFoto('admin ve la suya (con foto)', 'adminA', 200, {
      antes: (x) =>
        llamar(
          x,
          'put',
          `/users/${x.adminA.userId}/photo`,
          'adminA',
          undefined,
          png,
        ).then(() => undefined),
      verificar: (c) =>
        expect(typeof (c as { url: string }).url).toBe('string'),
    }),
    verFoto('admin ve la de su chofer (sin foto: url nula)', 'adminA', 200, {
      ruta: (c) => `/users/${c.choferEditar.userId}/photo?modo=url`,
      verificar: (c) => expect((c as { url: unknown }).url).toBeNull(),
    }),
    verFoto(
      'el chofer ve la suya sin foto (modo=url: url nula)',
      'chofer',
      200,
      {
        ruta: (c) => `/users/${c.choferA.userId}/photo?modo=url`,
        verificar: (c) => expect((c as { url: unknown }).url).toBeNull(),
      },
    ),
    verFoto('el chofer ve la suya sin foto y sin modo', 'chofer', 404, {
      ruta: (c) => `/users/${c.choferA.userId}/photo`,
    }),
    verFoto('id mal formado', 'adminA', 400, {
      ruta: '/users/no-es-uuid/photo',
      code: 'INVALID_ID',
    }),
    verFoto('modo inválido', 'adminA', 400, {
      ruta: (c) => `/users/${c.adminA.userId}/photo?modo=otro`,
    }),
    verFoto('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
    }),
    verFoto('cliente pide la de otro', 'clienteA', 403),
    verFoto('chofer pide la de otro', 'chofer', 403),
    verFoto('id que no existe', 'adminA', 404, {
      ruta: (c) => `/users/${c.inexistente}/photo?modo=url`,
    }),
    verFoto('de otra distribuidora', 'adminB', 404),
    verFoto('sin foto y sin modo', 'adminA', 404, {
      ruta: (c) => `/users/${c.choferEditar.userId}/photo`,
    }),
  ];

  // ============================================================ check-exists
  const existe = endpoint<Ctx>(
    'post',
    '/users/check-exists',
    '/users/check-exists',
  );
  const casosExiste: Array<Caso<Ctx>> = [
    existe('correo que existe', undefined, 200, {
      body: (c) => ({ email: c.clienteA.email }),
      verificar: (c) => expect(JSON.stringify(c)).toContain('true'),
    }),
    existe('teléfono que existe', undefined, 200, {
      body: { phoneNumber: TELEFONO_REAL },
      verificar: (c) => expect(JSON.stringify(c)).toContain('true'),
    }),
    existe('correo y teléfono', undefined, 200, {
      body: (c) => ({ email: c.clienteA.email, phoneNumber: TELEFONO_REAL }),
    }),
    existe('nada existe', undefined, 200, {
      body: { email: 'nadie@splg.local' },
      verificar: (c) => expect(JSON.stringify(c)).not.toContain('true'),
    }),
    // La misma regla E.164 que el alta: un teléfono registrable no da 400 al preguntar.
    existe('teléfono E.164 que libphonenumber no reconoce', undefined, 200, {
      body: { phoneNumber: '+5491101234567' },
      verificar: (c) => expect(JSON.stringify(c)).not.toContain('true'),
    }),
    existe('sin correo ni teléfono', undefined, 400, { body: {} }),
    existe('los dos inválidos', undefined, 400, {
      body: { email: 'no', phoneNumber: 'basura' },
    }),
    existe('correo válido y teléfono inválido', undefined, 400, {
      body: { email: 'a@splg.local', phoneNumber: 'basura' },
    }),
    existe('correo inválido y teléfono válido', undefined, 400, {
      body: { email: 'no', phoneNumber: TELEFONO_REAL },
    }),
    existe('correo que no es texto', undefined, 400, { body: { email: 5 } }),
    existe('teléfono que no es texto', undefined, 400, {
      body: { phoneNumber: 5 },
    }),
    existe('los dos que no son texto', undefined, 400, {
      body: { email: 5, phoneNumber: 5 },
    }),
    existe('correo mal formado', undefined, 400, { body: { email: 'no' } }),
    existe('teléfono inválido', undefined, 400, {
      body: { phoneNumber: '123' },
    }),
    existe('campo de más', undefined, 400, {
      body: { email: 'a@splg.local', x: 1 },
    }),
  ];

  // ================================================================ POST /users
  let n = 0;
  const nuevo =
    (extra: Record<string, unknown> = {}) =>
    () => ({
      email: `alta.${(n += 1)}.${Date.now()}@splg.local`,
      password: 'Test1234',
      full_name: 'Alta Prueba',
      phone_number: telefonoDePrueba(),
      rol: 'customer',
      ...extra,
    });
  const alta = endpoint<Ctx>('post', '/users', '/users');
  const cuerpoCon = (extra: Record<string, unknown>) => () => nuevo(extra)();
  const casosAlta: Array<Caso<Ctx>> = [
    alta('admin da de alta un cliente', 'adminA', 201, { body: cuerpoCon({}) }),
    alta('admin da de alta un chofer', 'adminA', 201, {
      body: cuerpoCon({ rol: 'delivery' }),
    }),
    alta('admin da de alta un admin', 'adminA', 201, {
      body: cuerpoCon({ rol: 'admin' }),
    }),
    alta(
      'admin da de alta un chofer con su propia distribuidora en el cuerpo',
      'adminA',
      201,
      {
        body: (c) => nuevo({ rol: 'delivery', distributorId: c.distA.id })(),
      },
    ),
    alta('super admin da de alta un super admin', 'super', 201, {
      body: cuerpoCon({ rol: 'super_admin' }),
    }),
    alta('super admin da de alta un chofer con X-Distributor', 'super', 201, {
      cabeceras: (c) => ({ 'X-Distributor': c.distA.slug }),
      body: cuerpoCon({ rol: 'delivery' }),
    }),
    alta('super admin da de alta un admin con distributorId', 'super', 201, {
      body: (c) => nuevo({ rol: 'admin', distributorId: c.distA.id })(),
    }),
    alta('sin rol', 'adminA', 400, { body: cuerpoCon({ rol: undefined }) }),
    alta('rol que no se puede crear', 'adminA', 400, {
      body: cuerpoCon({ rol: 'qa_pruebas' }),
    }),
    alta('sin correo', 'adminA', 400, {
      body: cuerpoCon({ email: undefined }),
    }),
    alta('correo mal formado', 'adminA', 400, {
      body: cuerpoCon({ email: 'no' }),
    }),
    alta('contraseña de 5 caracteres', 'adminA', 400, {
      body: cuerpoCon({ password: '12345' }),
    }),
    alta('nombre de 1 letra', 'adminA', 400, {
      body: cuerpoCon({ full_name: 'A' }),
    }),
    alta('teléfono fuera de E.164', 'adminA', 400, {
      body: cuerpoCon({ phone_number: '123' }),
    }),
    alta('distributorId que no es uuid', 'adminA', 400, {
      body: cuerpoCon({ distributorId: 'x' }),
    }),
    alta('validated que no es booleano', 'adminA', 400, {
      body: cuerpoCon({ validated: 'si' }),
    }),
    alta('isActive que no es booleano', 'adminA', 400, {
      body: cuerpoCon({ isActive: 'si' }),
    }),
    alta('latLng mal formado', 'adminA', 400, {
      body: cuerpoCon({ latLng: 'aca' }),
    }),
    alta('employeeId que no es uuid', 'adminA', 400, {
      body: cuerpoCon({ rol: 'delivery', employeeId: 'x' }),
    }),
    alta('legajo que no es objeto', 'adminA', 400, {
      body: cuerpoCon({ rol: 'delivery', legajo: 'x' }),
    }),
    alta('legajo con tipo de documento inválido', 'adminA', 400, {
      body: cuerpoCon({ rol: 'delivery', legajo: { documentType: 'carnet' } }),
    }),
    alta('legajo existente y legajo nuevo a la vez', 'adminA', 400, {
      body: (c) =>
        nuevo({ rol: 'delivery', employeeId: c.inexistente, legajo: {} })(),
    }),
    alta('legajo en un cliente', 'adminA', 400, {
      body: cuerpoCon({ legajo: {} }),
    }),
    alta('campo de más', 'adminA', 400, { body: cuerpoCon({ isAdmin: true }) }),
    alta(
      'super admin crea un chofer sin decir la distribuidora',
      'super',
      400,
      {
        body: cuerpoCon({ rol: 'delivery' }),
        code: 'MISSING_DISTRIBUTOR',
      },
    ),
    alta('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
      body: cuerpoCon({}),
    }),
    alta('cliente', 'clienteA', 403, { body: cuerpoCon({}) }),
    alta('chofer', 'chofer', 403, { body: cuerpoCon({}) }),
    alta('admin crea un super admin', 'adminA', 403, {
      body: cuerpoCon({ rol: 'super_admin' }),
    }),
    alta('admin crea un chofer en otra distribuidora', 'adminA', 403, {
      body: (c) => nuevo({ rol: 'delivery', distributorId: c.distB.id })(),
    }),
    alta('correo ya en uso', 'adminA', 409, {
      body: (c) => nuevo({ email: c.clienteA.email })(),
    }),
    alta('teléfono ya en uso', 'adminA', 409, {
      body: (c) => nuevo({ phone_number: c.clienteA.phone })(),
    }),
  ];

  // ============================================================== People
  const fotos = endpoint<Ctx>('post', '/people/photos', '/v2/people/photos');
  const ids = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
  const casosFotos: Array<Caso<Ctx>> = [
    fotos('admin pide fotos de su gente', 'adminA', 200, {
      body: (c) => ({
        userIds: [c.clienteFicha.userId, c.clienteB.userId],
        deliveryIds: [c.choferA.deliveryId],
      }),
      verificar: (r, c) => {
        const cuerpo = r as {
          users: Record<string, { url: string } | null>;
          deliveries: Record<string, unknown>;
        };
        // La foto de su gente sale; la de otra distribuidora (que sí la tiene) viene nula.
        expect(cuerpo.users[c.clienteFicha.userId]).not.toBeNull();
        expect(typeof cuerpo.users[c.clienteFicha.userId]?.url).toBe('string');
        expect(Object.keys(cuerpo.users)).toContain(c.clienteB.userId);
        expect(cuerpo.users[c.clienteB.userId]).toBeNull();
        expect(Object.keys(cuerpo.deliveries)).toContain(c.choferA.deliveryId);
      },
    }),
    fotos(
      'super admin ve las fotos de todas las distribuidoras',
      'super',
      200,
      {
        body: (c) => ({ userIds: [c.clienteFicha.userId, c.clienteB.userId] }),
        verificar: (r, c) => {
          const u = (r as { users: Record<string, unknown> }).users;
          expect(u[c.clienteFicha.userId]).not.toBeNull();
          expect(u[c.clienteB.userId]).not.toBeNull();
        },
      },
    ),
    fotos('admin de B ve la foto de su gente y no la de A', 'adminB', 200, {
      body: (c) => ({ userIds: [c.clienteFicha.userId, c.clienteB.userId] }),
      verificar: (r, c) => {
        const u = (r as { users: Record<string, unknown> }).users;
        expect(u[c.clienteB.userId]).not.toBeNull();
        expect(u[c.clienteFicha.userId]).toBeNull();
      },
    }),
    fotos('listas vacías', 'adminA', 200, {
      body: { userIds: [], employeeIds: [], deliveryIds: [] },
    }),
    fotos('ids que no existen salen nulos', 'adminA', 200, {
      body: (c) => ({ userIds: [c.inexistente] }),
      verificar: (r, c) =>
        expect(
          (r as { users: Record<string, unknown> }).users[c.inexistente],
        ).toBeNull(),
    }),
    fotos('sin userIds', 'adminA', 400, { body: {} }),
    fotos('userIds que no es lista', 'adminA', 400, { body: { userIds: 'x' } }),
    fotos('un id que no es uuid', 'adminA', 400, { body: { userIds: ['x'] } }),
    fotos('más de 100 userIds', 'adminA', 400, { body: { userIds: ids(101) } }),
    fotos('más de 100 employeeIds', 'adminA', 400, {
      body: { userIds: [], employeeIds: ids(101) },
    }),
    fotos('más de 100 deliveryIds', 'adminA', 400, {
      body: { userIds: [], deliveryIds: ids(101) },
    }),
    fotos('employeeIds con un id inválido', 'adminA', 400, {
      body: { userIds: [], employeeIds: ['x'] },
    }),
    fotos('deliveryIds que no es lista', 'adminA', 400, {
      body: { userIds: [], deliveryIds: 'x' },
    }),
    fotos('campo de más', 'adminA', 400, { body: { userIds: [], otros: [] } }),
    fotos('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'panel-app' },
      body: { userIds: [] },
    }),
    fotos('cliente', 'clienteA', 403, { body: { userIds: [] } }),
    fotos('chofer', 'chofer', 403, { body: { userIds: [] } }),
  ];

  correrMatriz('GET /users', ver, casosListado);
  correrMatriz('GET /users/email/{email}', ver, casosPorEmail);
  correrMatriz('GET /users/{id}', ver, casosPorId);
  correrMatriz('GET /users/phone/{phoneNumber}', ver, casosPorTelefono);
  correrMatriz('PATCH /users/{id}', ver, casosEditar);
  correrMatriz('PATCH /users/{id}/block', ver, casosBloquear);
  correrMatriz('POST /users/check-exists', ver, casosExiste);
  correrMatriz('POST /users', ver, casosAlta);
  correrMatriz('fotos propias: subir', ver, casosMiFoto);
  correrMatriz('fotos propias: ver', ver, casosVerMiFoto);
  correrMatriz('fotos propias: sacar', ver, casosSacarMiFoto);
  correrMatriz('fotos de un id: subir', ver, casosSubirFoto);
  correrMatriz('fotos de un id: ver', ver, casosVerFoto);
  correrMatriz('fotos de un id: sacar', ver, casosSacarFoto);
  correrMatriz('POST /v2/people/photos', ver, casosFotos);
  correrMatriz('DELETE /users/{id}', ver, casosBaja);
  correrMatriz('DELETE /users/me', ver, casosBajaPropia);

  describe('cupo de check-exists', () => {
    it('POST /users/check-exists → 429 a la undécima', async () => {
      await reiniciarCuposDelThrottler(env);
      const pedir = () =>
        request(env.app.getHttpServer())
          .post('/users/check-exists')
          .send({ email: 'nadie@splg.local' });
      for (let i = 0; i < 10; i += 1) await pedir().expect(200);
      const res = await pedir();
      expect(res.status).toBe(429);
      verificarCastellano(res.body, 429);
    });
  });
});
