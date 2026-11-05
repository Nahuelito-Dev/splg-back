/**
 * Matriz HTTP T1 (1/4): endpoints públicos y de sesión: Auth, Registro, Health
 * y Email. Cada caso es una fila de la tabla (ver `matriz.ts`).
 */
import request from 'supertest';
import { DataSource } from 'typeorm';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { FirebaseAuthPort } from '../../../src/firebase/ports/firebase-auth.port';
import { EmailSenderPort } from '../../../src/email/ports/email-sender.port';
import { TestEnv, createTestApp, telefonoDePrueba } from '../setup/test-env';
import {
  Caso,
  Escenario,
  correrMatriz,
  sembrarEscenario,
  reiniciarCuposDelThrottler,
  verificarCastellano,
} from './matriz';

jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(() => ({})),
  signInWithEmailAndPassword: jest.fn(),
}));

/** Un error del SDK de Firebase: lleva su `code`. */
const errorDeFirebase = (code: string) =>
  Object.assign(new Error(code), { code });

/** Lo que responde Firebase al acceso, según el correo (ver `simularFirebase`). */
function simularFirebase(): void {
  (signInWithEmailAndPassword as jest.Mock).mockImplementation(
    (_auth: unknown, email: string, password: string) => {
      if (email.startsWith('deshabilitada')) {
        return Promise.reject(errorDeFirebase('auth/user-disabled'));
      }
      if (email.startsWith('muchos')) {
        return Promise.reject(errorDeFirebase('auth/too-many-requests'));
      }
      if (email.startsWith('caido')) {
        return Promise.reject(errorDeFirebase('auth/network-request-failed'));
      }
      if (password !== 'Test1234') {
        return Promise.reject(errorDeFirebase('auth/invalid-credential'));
      }
      return Promise.resolve({
        user: {
          uid: email,
          email,
          displayName: null,
          phoneNumber: null,
          emailVerified: true,
          getIdTokenResult: () =>
            Promise.resolve({
              token: email,
              expirationTime: new Date(Date.now() + 3_600_000).toISOString(),
            }),
        },
      });
    },
  );
}

interface Ctx extends Escenario {
  cliente: { email: string; phone: string };
}

describe('Matriz HTTP T1: Auth, Registro, Health y Email (e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;

  beforeAll(async () => {
    env = await createTestApp();
    const e = await sembrarEscenario(env.app);
    ctx = {
      ...e,
      cliente: { email: e.clienteA.email, phone: e.clienteA.phone },
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    simularFirebase();
    const rolCliente = await env.app
      .get(DataSource)
      .query<
        Array<{ role_id: string }>
      >(`SELECT role_id FROM role WHERE type = 'customer'`);
    for (const [correo, bloqueado] of [
      ['bloqueada@splg.local', true],
      ['cambia@splg.local', false],
      ['baja@splg.local', false],
    ] as const) {
      await env.app
        .get(DataSource)
        .query(
          `INSERT INTO "user" (email, full_name, phone_number, role_id, blocked) VALUES ($1, 'Extra', $2, $3, $4)`,
          [correo, telefonoDePrueba(), rolCliente[0].role_id, bloqueado],
        );
    }
    await env.app
      .get(DataSource)
      .query(`UPDATE "user" SET "deletedAt" = now() WHERE email = $1`, [
        'baja@splg.local',
      ]);
    const firebase = env.app.get(FirebaseAuthPort);
    jest
      .spyOn(firebase, 'createUserSafe')
      .mockImplementation((datos) =>
        Promise.resolve({ uid: `uid-${datos.email}` } as never),
      );
    jest.spyOn(firebase, 'deleteUserSafe').mockResolvedValue();
    jest
      .spyOn(firebase, 'generatePasswordResetLink')
      .mockResolvedValue('https://splg.test/reset');
    jest
      .spyOn(firebase, 'updateUser')
      .mockImplementation((uid, props) =>
        props.email === 'duplicado@splg.local'
          ? Promise.reject(errorDeFirebase('auth/email-already-exists'))
          : Promise.resolve({ uid } as never),
      );
    jest.spyOn(env.app.get(EmailSenderPort), 'send').mockResolvedValue();
  }, 180000);

  afterAll(async () => {
    await env.cleanup();
  });

  // ---------------------------------------------------------------- Auth
  const auth: Array<Caso<Ctx>> = [
    {
      endpoint: 'POST /auth',
      caso: 'token válido',
      metodo: 'post',
      ruta: '/auth',
      actor: 'adminA',
      esperado: 201,
      verificar: (c) =>
        expect(c).toMatchObject({
          message: 'Token válido',
          response: 'Token válido',
        }),
    },
    {
      endpoint: 'POST /auth',
      caso: 'sin token',
      metodo: 'post',
      ruta: '/auth',
      actor: 'adminA',
      cabeceras: { Authorization: null },
      esperado: 401,
    },
    {
      endpoint: 'POST /auth',
      caso: 'token de un usuario que no existe',
      metodo: 'post',
      ruta: '/auth',
      actor: 'adminA',
      cabeceras: { Authorization: 'Bearer nadie@splg.local' },
      esperado: 401,
    },
    {
      endpoint: 'POST /auth',
      caso: 'sin X-Client-Source',
      metodo: 'post',
      ruta: '/auth',
      actor: 'adminA',
      cabeceras: { 'X-Client-Source': null },
      esperado: 401,
    },
    {
      endpoint: 'POST /auth',
      caso: 'rol que no es de esta app',
      metodo: 'post',
      ruta: '/auth',
      actor: 'adminA',
      cabeceras: { 'X-Client-Source': 'customer-app' },
      esperado: 401,
    },
  ];

  const login = (
    endpoint: string,
    ruta: string,
    caso: string,
    body: Caso<Ctx>['body'],
    esperado: number,
    extra: Partial<Caso<Ctx>> = {},
  ): Caso<Ctx> => ({
    endpoint,
    caso,
    metodo: 'post',
    ruta,
    body,
    esperado,
    cabeceras: { 'X-Client-Source': 'panel-app' },
    ...extra,
  });

  const loginApp = '/auth/login';
  const loginPanel = '/auth/login/dashboard';
  const EP_APP = 'POST /auth/login';
  const EP_PANEL = 'POST /auth/login/dashboard';
  const sesion = (cuerpo: unknown) => {
    const c = cuerpo as { accessToken?: string; user?: { email?: string } };
    expect(typeof c.accessToken).toBe('string');
    expect(c.user?.email).toBeDefined();
  };

  const logins: Array<Caso<Ctx>> = [
    {
      ...login(EP_APP, loginApp, 'cliente con clave correcta', undefined, 200, {
        cabeceras: { 'X-Client-Source': 'customer-app' },
      }),
      body: (c: Ctx) => ({ email: c.clienteA.email, password: 'Test1234' }),
      verificar: sesion,
    },
    login(EP_APP, loginApp, 'sin email', { password: 'x' }, 400),
    login(
      EP_APP,
      loginApp,
      'email mal formado',
      { email: 'no', password: 'x' },
      400,
    ),
    login(EP_APP, loginApp, 'sin password', { email: 'a@splg.local' }, 400),
    login(
      EP_APP,
      loginApp,
      'password que no es texto',
      { email: 'a@splg.local', password: 5 },
      400,
    ),
    login(
      EP_APP,
      loginApp,
      'requestSource que no es texto',
      { email: 'a@splg.local', password: 'x', requestSource: 5 },
      400,
    ),
    login(
      EP_APP,
      loginApp,
      'campo de más',
      { email: 'a@splg.local', password: 'x', rol: 'admin' },
      400,
    ),
    login(EP_APP, loginApp, 'cuerpo vacío', {}, 400),
    login(
      EP_APP,
      loginApp,
      'clave incorrecta',
      { email: 'ana@splg.local', password: 'mala' },
      401,
      { mensaje: 'incorrectos' },
    ),
    login(
      EP_APP,
      loginApp,
      'cuenta dada de baja (Firebase la rechaza) = mismas credenciales',
      { email: 'deshabilitada@splg.local', password: 'x' },
      401,
      { mensaje: 'incorrectos' },
    ),
    {
      ...login(
        EP_APP,
        loginApp,
        'cuenta bloqueada con la clave buena',
        undefined,
        401,
        {
          cabeceras: { 'X-Client-Source': 'customer-app' },
          mensaje: 'no está habilitada',
        },
      ),
      body: () => ({ email: 'bloqueada@splg.local', password: 'Test1234' }),
    },
    login(
      EP_APP,
      loginApp,
      'Firebase caído',
      { email: 'caido@splg.local', password: 'Test1234' },
      503,
    ),
    login(
      EP_APP,
      loginApp,
      'Firebase corta por demasiados intentos',
      { email: 'muchos@splg.local', password: 'Test1234' },
      429,
    ),
    {
      ...login(
        EP_PANEL,
        loginPanel,
        'admin con clave correcta',
        undefined,
        200,
      ),
      body: (c: Ctx) => ({ email: c.adminA.email, password: 'Test1234' }),
      verificar: sesion,
    },
    login(EP_PANEL, loginPanel, 'sin email', { password: 'x' }, 400),
    login(
      EP_PANEL,
      loginPanel,
      'email mal formado',
      { email: 'no', password: 'x' },
      400,
    ),
    login(EP_PANEL, loginPanel, 'sin password', { email: 'a@splg.local' }, 400),
    login(
      EP_PANEL,
      loginPanel,
      'campo de más',
      { email: 'a@splg.local', password: 'x', x: 1 },
      400,
    ),
    login(
      EP_PANEL,
      loginPanel,
      'clave incorrecta',
      { email: 'ana@splg.local', password: 'mala' },
      401,
      { mensaje: 'incorrectos' },
    ),
    {
      ...login(
        EP_PANEL,
        loginPanel,
        'cliente (no es administrador)',
        undefined,
        401,
        {
          mensaje: 'Administrador no encontrado',
        },
      ),
      body: (c: Ctx) => ({ email: c.clienteA.email, password: 'Test1234' }),
    },
    login(
      EP_PANEL,
      loginPanel,
      'Firebase corta por demasiados intentos',
      { email: 'muchos@splg.local', password: 'Test1234' },
      429,
    ),
  ];

  const loginExtra: Array<Caso<Ctx>> = [
    ...[
      [EP_APP, loginApp, 'customer-app'],
      [EP_PANEL, loginPanel, 'panel-app'],
    ].flatMap(([ep, ruta, fuente]) => [
      login(
        ep,
        ruta,
        'password que no es texto',
        { email: 'a@splg.local', password: 5 },
        400,
        { cabeceras: { 'X-Client-Source': fuente } },
      ),
      login(
        ep,
        ruta,
        'cuenta bloqueada con la clave buena',
        { email: 'bloqueada@splg.local', password: 'Test1234' },
        401,
        {
          cabeceras: { 'X-Client-Source': fuente },
          mensaje: 'no está habilitada',
        },
      ),
      login(
        ep,
        ruta,
        'cuenta dada de baja con la clave buena',
        { email: 'baja@splg.local', password: 'Test1234' },
        401,
        {
          cabeceras: { 'X-Client-Source': fuente },
          mensaje: 'no está habilitada',
        },
      ),
      login(
        ep,
        ruta,
        'Firebase caído',
        { email: 'caido@splg.local', password: 'Test1234' },
        503,
        { cabeceras: { 'X-Client-Source': fuente } },
      ),
    ]),
  ];

  // ------------------------------------------------------------ Registro
  const valido = (n: string) => ({
    email: `nuevo.${n}@splg.local`,
    password: 'Test1234',
    full_name: 'Ana Pérez',
    phone_number: telefonoDePrueba(),
  });
  const reg = (
    endpoint: string,
    ruta: string,
    caso: string,
    body: Caso<Ctx>['body'],
    esperado: number,
    extra: Partial<Caso<Ctx>> = {},
  ): Caso<Ctx> => ({
    endpoint,
    caso,
    metodo: 'post',
    ruta,
    body,
    esperado,
    ...extra,
  });
  const variantes = (ep: string, ruta: string, n: string): Array<Caso<Ctx>> => {
    const base = () => valido(n);
    return [
      reg(ep, ruta, 'alta feliz', undefined, 201, {
        body: base,
        verificar: (c) => {
          const u = c as { email: string };
          expect(u.email).toBe(`nuevo.${n}@splg.local`);
        },
      }),
      reg(ep, ruta, 'sin email', () => ({ ...base(), email: undefined }), 400),
      reg(
        ep,
        ruta,
        'email mal formado',
        () => ({ ...base(), email: 'no' }),
        400,
      ),
      reg(
        ep,
        ruta,
        'sin password',
        () => ({ ...base(), password: undefined }),
        400,
      ),
      reg(
        ep,
        ruta,
        'password de 5 caracteres',
        () => ({ ...base(), password: '12345' }),
        400,
      ),
      reg(
        ep,
        ruta,
        'password que no es texto',
        () => ({ ...base(), password: 123456 }),
        400,
      ),
      reg(
        ep,
        ruta,
        'sin full_name',
        () => ({ ...base(), full_name: undefined }),
        400,
      ),
      reg(
        ep,
        ruta,
        'full_name de 1 letra',
        () => ({ ...base(), full_name: 'A' }),
        400,
      ),
      reg(
        ep,
        ruta,
        'sin teléfono',
        () => ({ ...base(), phone_number: undefined }),
        400,
      ),
      reg(
        ep,
        ruta,
        'teléfono sin +',
        () => ({ ...base(), phone_number: '5493764000000' }),
        400,
      ),
      reg(
        ep,
        ruta,
        'teléfono con letras',
        () => ({ ...base(), phone_number: '+54abc' }),
        400,
      ),
      reg(
        ep,
        ruta,
        'lat_lang mal formado',
        () => ({ ...base(), lat_lang: 'aca' }),
        400,
      ),
      reg(
        ep,
        ruta,
        'notification_token que no es texto',
        () => ({ ...base(), notification_token: 1 }),
        400,
      ),
      reg(
        ep,
        ruta,
        'consumption que no es objeto',
        () => ({ ...base(), consumption: 'mucho' }),
        400,
      ),
      reg(ep, ruta, 'campo de más', () => ({ ...base(), isAdmin: true }), 400),
      reg(
        ep,
        ruta,
        'no se puede elegir rol',
        () => ({ ...base(), rol: 'admin' }),
        400,
      ),
    ];
  };

  const registro: Array<Caso<Ctx>> = [
    ...variantes('POST /auth/registro', '/auth/registro', 'a'),
    reg(
      'POST /auth/registro',
      '/auth/registro',
      'correo ya en uso',
      (c: Ctx) => ({ ...valido('b'), email: c.clienteA.email }),
      409,
    ),
    reg(
      'POST /auth/registro',
      '/auth/registro',
      'teléfono ya en uso',
      (c: Ctx) => ({ ...valido('c'), phone_number: c.clienteA.phone }),
      409,
    ),
  ];
  const registroViejo: Array<Caso<Ctx>> = [
    ...variantes(
      'POST /users/customer-registration',
      '/users/customer-registration',
      'v',
    ),
    reg(
      'POST /users/customer-registration',
      '/users/customer-registration',
      'correo ya en uso',
      (c: Ctx) => ({ ...valido('w'), email: c.clienteA.email }),
      409,
    ),
    reg(
      'POST /users/customer-registration',
      '/users/customer-registration',
      'teléfono ya en uso',
      (c: Ctx) => ({ ...valido('x'), phone_number: c.clienteA.phone }),
      409,
    ),
  ];

  // -------------------------------------------------------------- Health
  const health: Array<Caso<Ctx>> = [
    {
      endpoint: 'GET /health',
      caso: 'sano',
      metodo: 'get',
      ruta: '/health',
      esperado: 200,
    },
    {
      endpoint: 'GET /health/live',
      caso: 'vivo',
      metodo: 'get',
      ruta: '/health/live',
      esperado: 200,
    },
    {
      endpoint: 'GET /health/ready',
      caso: 'listo',
      metodo: 'get',
      ruta: '/health/ready',
      esperado: 200,
    },
  ];

  // --------------------------------------------------------------- Email
  const email = (
    endpoint: string,
    ruta: string,
    caso: string,
    body: Caso<Ctx>['body'],
    esperado: number,
    extra: Partial<Caso<Ctx>> = {},
  ): Caso<Ctx> => ({
    endpoint,
    caso,
    metodo: 'post',
    ruta,
    body,
    esperado,
    ...extra,
  });
  const EP_RESET = 'POST /email/password-reset';
  const EP_CHANGE = 'POST /email/change-email';
  const EP_TEST = 'POST /email/test';
  const correos: Array<Caso<Ctx>> = [
    email(
      EP_RESET,
      '/email/password-reset',
      'cuenta existente',
      (c: Ctx) => ({ email: c.clienteA.email }),
      200,
      {
        verificar: (b) =>
          expect((b as { message: string }).message).toMatch(/enlace/),
      },
    ),
    email(
      EP_RESET,
      '/email/password-reset',
      'cuenta inexistente (mismo mensaje)',
      { email: 'nadie@splg.local' },
      200,
      {
        verificar: (b) =>
          expect((b as { message: string }).message).toMatch(/enlace/),
      },
    ),
    email(EP_RESET, '/email/password-reset', 'sin email', {}, 400),
    email(
      EP_RESET,
      '/email/password-reset',
      'email mal formado',
      { email: 'no' },
      400,
    ),
    email(
      EP_RESET,
      '/email/password-reset',
      'email que no es texto',
      { email: 5 },
      400,
    ),
    email(
      EP_RESET,
      '/email/password-reset',
      'campo de más',
      { email: 'a@splg.local', x: 1 },
      400,
    ),

    email(
      EP_CHANGE,
      '/email/change-email',
      'cambio feliz',
      () => ({
        currentEmail: 'cambia@splg.local',
        newEmail: 'cambiado@splg.local',
        idToken: 'cambia@splg.local',
      }),
      201,
      {
        cabeceras: {
          Authorization: 'Bearer cambia@splg.local',
          'X-Client-Source': 'customer-app',
        },
      },
    ),
    email(
      EP_CHANGE,
      '/email/change-email',
      'sin currentEmail',
      (c: Ctx) => ({ newEmail: 'x@splg.local', idToken: c.clienteA.email }),
      400,
      { actor: 'clienteA' },
    ),
    email(
      EP_CHANGE,
      '/email/change-email',
      'newEmail mal formado',
      (c: Ctx) => ({
        currentEmail: c.clienteA.email,
        newEmail: 'no',
        idToken: c.clienteA.email,
      }),
      400,
      { actor: 'clienteA' },
    ),
    email(
      EP_CHANGE,
      '/email/change-email',
      'sin idToken',
      (c: Ctx) => ({
        currentEmail: c.clienteA.email,
        newEmail: 'x@splg.local',
      }),
      400,
      { actor: 'clienteA' },
    ),
    email(
      EP_CHANGE,
      '/email/change-email',
      'idToken vacío',
      (c: Ctx) => ({
        currentEmail: c.clienteA.email,
        newEmail: 'x@splg.local',
        idToken: '',
      }),
      400,
      { actor: 'clienteA' },
    ),
    email(
      EP_CHANGE,
      '/email/change-email',
      'campo de más',
      (c: Ctx) => ({
        currentEmail: c.clienteA.email,
        newEmail: 'x@splg.local',
        idToken: c.clienteA.email,
        y: 1,
      }),
      400,
      { actor: 'clienteA' },
    ),
    email(
      EP_CHANGE,
      '/email/change-email',
      'el token no es del correo actual',
      (c: Ctx) => ({
        currentEmail: c.clienteA.email,
        newEmail: 'x@splg.local',
        idToken: c.clienteB.email,
      }),
      400,
      { actor: 'clienteA' },
    ),
    email(
      EP_CHANGE,
      '/email/change-email',
      'el correo nuevo ya existe',
      (c: Ctx) => ({
        currentEmail: c.clienteA.email,
        newEmail: c.clienteB.email,
        idToken: c.clienteA.email,
      }),
      400,
      { actor: 'clienteA' },
    ),
    email(
      EP_CHANGE,
      '/email/change-email',
      'Firebase rechaza el correo nuevo',
      (c: Ctx) => ({
        currentEmail: c.clienteA.email,
        newEmail: 'duplicado@splg.local',
        idToken: c.clienteA.email,
      }),
      400,
      { actor: 'clienteA' },
    ),
    email(
      EP_CHANGE,
      '/email/change-email',
      'sin token',
      { currentEmail: 'a@splg.local', newEmail: 'b@splg.local', idToken: 'x' },
      401,
      {
        actor: 'clienteA',
        cabeceras: { Authorization: null },
      },
    ),
    email(
      EP_CHANGE,
      '/email/change-email',
      'token de un usuario inexistente',
      { currentEmail: 'a@splg.local', newEmail: 'b@splg.local', idToken: 'x' },
      401,
      {
        actor: 'clienteA',
        cabeceras: { Authorization: 'Bearer nadie@splg.local' },
      },
    ),

    email(
      EP_TEST,
      '/email/test',
      'super admin',
      { email: 'prueba@splg-test.com' },
      201,
      { actor: 'super' },
    ),
    email(EP_TEST, '/email/test', 'sin email', {}, 400, { actor: 'super' }),
    email(EP_TEST, '/email/test', 'email mal formado', { email: 'no' }, 400, {
      actor: 'super',
    }),
    email(
      EP_TEST,
      '/email/test',
      'campo de más',
      { email: 'a@splg-test.com', x: 1 },
      400,
      { actor: 'super' },
    ),
    email(
      EP_TEST,
      '/email/test',
      'sin token',
      { email: 'a@splg-test.com' },
      401,
      { cabeceras: { 'X-Client-Source': 'panel-app' } },
    ),
    email(
      EP_TEST,
      '/email/test',
      'admin de empresa',
      { email: 'a@splg-test.com' },
      403,
      { actor: 'adminA' },
    ),
    email(
      EP_TEST,
      '/email/test',
      'cliente',
      { email: 'a@splg-test.com' },
      403,
      { actor: 'clienteA', cabeceras: { 'X-Client-Source': 'customer-app' } },
    ),
    email(EP_TEST, '/email/test', 'chofer', { email: 'a@splg-test.com' }, 403, {
      actor: 'chofer',
    }),
  ];

  correrMatriz('Auth', ver, auth);
  correrMatriz('Login', ver, [...logins, ...loginExtra]);
  correrMatriz('Registro público', ver, registro);
  correrMatriz('Registro ruta anterior', ver, registroViejo);
  correrMatriz('Health', ver, health);
  correrMatriz('Email', ver, correos);

  // -------------------------------------------------------- 429 y 503
  describe('cupos y dependencias caídas', () => {
    const http = () => request(env.app.getHttpServer());
    const agotar = async (
      ruta: string,
      cuerpo: (i: number) => object,
      limite: number,
      cabeceras: Record<string, string> = {},
    ) => {
      await reiniciarCuposDelThrottler(env);
      for (let i = 0; i < limite; i += 1) {
        const r = await http().post(ruta).set(cabeceras).send(cuerpo(i));
        expect(r.status).not.toBe(429);
      }
      const res = await http().post(ruta).set(cabeceras).send(cuerpo(limite));
      expect(res.status).toBe(429);
      verificarCastellano(res.body, 429);
    };

    it('POST /auth/login → 429 a la novena por cuenta', async () => {
      await expect(
        agotar(
          '/auth/login',
          () => ({ email: 'repetida@splg.local', password: 'mala' }),
          8,
          { 'X-Client-Source': 'customer-app' },
        ),
      ).resolves.toBeUndefined();
    });

    it('POST /auth/login/dashboard → 429 a la novena por cuenta', async () => {
      await expect(
        agotar(
          '/auth/login/dashboard',
          () => ({ email: 'repetida2@splg.local', password: 'mala' }),
          8,
          { 'X-Client-Source': 'panel-app' },
        ),
      ).resolves.toBeUndefined();
    });

    it('POST /auth/registro → 429 a la undécima', async () => {
      await expect(
        agotar('/auth/registro', () => ({}), 10),
      ).resolves.toBeUndefined();
    });

    it('POST /users/customer-registration → 429 a la undécima', async () => {
      await expect(
        agotar('/users/customer-registration', () => ({}), 10),
      ).resolves.toBeUndefined();
    });

    it('POST /users/check-exists → 429 a la undécima', async () => {
      await expect(
        agotar(
          '/users/check-exists',
          (i) => ({ email: `n${i}@splg.local` }),
          10,
        ),
      ).resolves.toBeUndefined();
    });

    it('POST /email/password-reset → 400 «demasiados intentos» a la undécima del mismo correo', async () => {
      await reiniciarCuposDelThrottler(env);
      const pedir = () =>
        http().post('/email/password-reset').send({ email: 'tope@splg.local' });
      for (let i = 0; i < 10; i += 1) await pedir().expect(200);
      const res = await pedir();
      expect(res.status).toBe(400);
      verificarCastellano(res.body, 400);
      expect(JSON.stringify(res.body)).toContain('Demasiados intentos');
    });

    it('GET /health y /health/ready → 503 si cae la base', async () => {
      const ds = env.app.get(DataSource);
      const roto = jest
        .spyOn(ds, 'query')
        .mockRejectedValue(new Error('conexión caída'));
      try {
        for (const ruta of ['/health', '/health/ready']) {
          const res = await http().get(ruta);
          expect(res.status).toBe(503);
          // El 503 de health es el informe de terminus para el balanceador, no un
          // texto para la persona: sólo estados (`up`/`down`), sin mensajes libres.
          const textos = JSON.stringify(res.body).match(/"[^"]+":"[^"]*"/g);
          expect(res.body).toMatchObject({
            status: 'error',
            error: { postgres: { status: 'down' } },
          });
          for (const par of textos ?? []) {
            expect(par).toMatch(/^"[^"]+":"(up|down|error|ok)"$/);
          }
        }
      } finally {
        roto.mockRestore();
      }
      await http().get('/health/ready').expect(200);
    });
  });
});
