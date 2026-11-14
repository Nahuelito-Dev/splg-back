import { randomUUID } from 'crypto';
import { createTestApp, TestEnv } from '../setup/test-env';
import { PNG_REAL } from '../setup/imagenes';
import { startMinio, TestMinio } from '../setup/minio';
import {
  Caso,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
} from './matriz';
import { EscenarioT4, sembrarBaseT4 } from './t4-base';
import {
  MERCADOPAGO_FETCH,
  MercadoPagoFetch,
} from '../../../src/distributor/mercadopago-credentials.service';
import { casosEnModoSoporte } from './soporte';

describe('Matriz HTTP T4: distribuidoras y rutas (e2e)', () => {
  let env: TestEnv;
  let minio: TestMinio;
  let ctx: EscenarioT4;
  const mercadoPagoFetch = jest.fn<
    ReturnType<MercadoPagoFetch>,
    Parameters<MercadoPagoFetch>
  >();
  const ver = () => ctx;
  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    // Clave descartable de 32 bytes: permite probar el circuito cifrado sin
    // credenciales reales. El único fetch externo se simula abajo.
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString(
      'base64',
    );
    mercadoPagoFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ tags: ['test_user'], nickname: 'TESTUSER-T4' }),
    });
    minio = await startMinio();
    env = await createTestApp({
      s3: minio.env,
      overrides: [{ token: MERCADOPAGO_FETCH, value: mercadoPagoFetch }],
    });
    ctx = {
      ...(await sembrarBaseT4(env.app)),
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
  }, 240000);
  afterAll(async () => {
    await env.cleanup();
    await minio.stop();
  });
  const all = endpoint<EscenarioT4>('get', '/distributor', '/distributor');
  const current = endpoint<EscenarioT4>(
    'get',
    '/distributor/current',
    '/distributor/current',
  );
  const one = endpoint<EscenarioT4>(
    'get',
    '/distributor/{id}',
    (c) => `/distributor/${c.distA.id}`,
  );
  const create = endpoint<EscenarioT4>('post', '/distributor', '/distributor');
  const patch = endpoint<EscenarioT4>(
    'patch',
    '/distributor/{id}',
    (c) => `/distributor/${c.distA.id}`,
  );
  const putLogo = endpoint<EscenarioT4>(
    'put',
    '/distributor/{id}/logo',
    (c) => `/distributor/${c.distA.id}/logo`,
  );
  const logo = endpoint<EscenarioT4>(
    'get',
    '/distributor/{id}/logo',
    (c) => `/distributor/${c.distA.id}/logo`,
  );
  const removeLogo = endpoint<EscenarioT4>(
    'delete',
    '/distributor/{id}/logo',
    (c) => `/distributor/${c.distA.id}/logo`,
  );
  const remove = endpoint<EscenarioT4>(
    'delete',
    '/distributor/{id}',
    (c) => `/distributor/${c.distA.id}`,
  );
  const png = {
    campo: 'file',
    contenido: PNG_REAL,
    nombre: 'logo.png',
    tipo: 'image/png',
  };
  const htmlComoPng = {
    campo: 'file',
    contenido: Buffer.from('<html>no es una imagen</html>'),
    nombre: 'logo.png',
    tipo: 'image/png',
  };
  const gigante = {
    campo: 'file',
    contenido: Buffer.concat([PNG_REAL, Buffer.alloc(6 * 1024 * 1024)]),
    nombre: 'logo.png',
    tipo: 'image/png',
  };
  const cases: Array<Caso<EscenarioT4>> = [
    all('super administrador', 'super', 200),
    all('sin token', undefined, 401),
    all('administrador', 'adminA', 403),
    current('admin recibe la propia', 'adminA', 200, {
      verificar: (b, c) =>
        expect(b).toMatchObject({ distributor_id: c.distA.id }),
    }),
    current('super sin sesión de soporte (plataforma)', 'super', 404),
    current('super con X-Distributor (ya no se lee)', 'superEnA', 404),
    current('super en modo soporte sobre A', 'soporteA', 200, {
      verificar: (b, c) =>
        expect(b).toMatchObject({ distributor_id: c.distA.id }),
    }),
    current('sin token', undefined, 401),
    current('cliente', 'clienteA', 403),
    one('super consulta', 'super', 200),
    one('id inválido', 'super', 400, {
      ruta: '/distributor/no',
      code: 'INVALID_ID',
    }),
    one('sin token', undefined, 401),
    one('administrador', 'adminA', 403),
    one('inexistente', 'super', 404, {
      ruta: (c) => `/distributor/${c.inexistente}`,
    }),
    create('crea y relee', 'super', 201, {
      body: () => ({
        name: 'Tenant T4',
        slug: `t4-${randomUUID().slice(0, 8)}`,
      }),
      verificar: async (b, c) => {
        const id = (b as { distributor_id: string }).distributor_id;
        expect(
          (await llamar(c, 'get', `/distributor/${id}`, 'super')).body,
        ).toMatchObject({ distributor_id: id });
      },
    }),
    create('requerido', 'super', 400, { body: { name: 'x' } }),
    create('slug inválido', 'super', 400, {
      body: { name: 'Nombre válido', slug: 'MAYUS' },
    }),
    create('campo extra', 'super', 400, {
      body: { name: 'Nombre válido', slug: 'valido', ajeno: true },
    }),
    create('sin token', undefined, 401),
    create('admin', 'adminA', 403),
    create('slug duplicado', 'super', 409, {
      body: (c) => ({ name: 'Duplicada T4', slug: c.distA.slug }),
    }),
    patch('edita y relee', 'super', 200, {
      body: { name: 'Dist A editada T4' },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', `/distributor/${c.distA.id}`, 'super')).body,
        ).toMatchObject({ name: 'Dist A editada T4' }),
    }),
    patch('id inválido', 'super', 400, {
      ruta: '/distributor/no',
      body: {},
      code: 'INVALID_ID',
    }),
    patch('campo slug no editable', 'super', 400, {
      body: { slug: 'no-cambia' },
    }),
    patch('inexistente', 'super', 404, {
      ruta: (c) => `/distributor/${c.inexistente}`,
      body: {},
    }),
    patch('sin token', undefined, 401, { body: {} }),
    patch('administrador', 'adminA', 403, { body: {} }),
    patch('cliente', 'clienteA', 403, { body: {} }),
    patch('chofer', 'chofer', 403, { body: {} }),
    putLogo('sin token', undefined, 401),
    putLogo('cliente', 'clienteA', 403),
    putLogo('id inválido', 'adminA', 400, {
      ruta: '/distributor/no/logo',
      code: 'INVALID_ID',
    }),
    putLogo('sin archivo', 'adminA', 400),
    putLogo('sube y relee logo', 'adminA', 200, {
      adjunto: png,
      verificar: async (_b, c) => {
        const releida: unknown = (
          await llamar(c, 'get', `/distributor/${c.distA.id}`, 'super')
        ).body;
        expect(releida).toMatchObject({ distributor_id: c.distA.id });
        expect((releida as { photoUrl?: unknown }).photoUrl).toEqual(
          expect.any(String),
        );
      },
    }),
    putLogo('archivo demasiado grande', 'adminA', 413, { adjunto: gigante }),
    putLogo('tipo declarado que no coincide', 'adminA', 415, {
      adjunto: htmlComoPng,
    }),
    logo('sin token', undefined, 401),
    logo('cliente', 'clienteA', 403),
    logo('id inválido', 'adminA', 400, {
      ruta: '/distributor/no/logo',
      code: 'INVALID_ID',
    }),
    logo('sin logo', 'adminB', 404, {
      ruta: (c) => `/distributor/${c.distB.id}/logo`,
    }),
    logo('logo en JSON', 'adminA', 200, {
      ruta: (c) => `/distributor/${c.distA.id}/logo?modo=url`,
      verificar: (b) =>
        expect(typeof (b as { url?: unknown }).url).toBe('string'),
    }),
    removeLogo('sin token', undefined, 401),
    removeLogo('cliente', 'clienteA', 403),
    removeLogo('id inválido', 'adminA', 400, {
      ruta: '/distributor/no/logo',
      code: 'INVALID_ID',
    }),
    removeLogo('sin logo', 'adminA', 200, {
      verificar: (b) => expect(b).toMatchObject({ photoUrl: null }),
    }),
    putLogo('distribuidora ajena', 'adminA', 404, {
      ruta: (c) => `/distributor/${c.distB.id}/logo`,
      adjunto: png,
    }),
    remove('sin token', undefined, 401),
    remove('admin', 'adminA', 403),
    remove('id inválido', 'super', 400, {
      ruta: '/distributor/no',
      code: 'INVALID_ID',
    }),
    remove('inexistente', 'super', 404, {
      ruta: (c) => `/distributor/${c.inexistente}`,
    }),
    (() => {
      let creada = '';
      return remove('baja una distribuidora creada por el caso', 'super', 200, {
        ruta: () => `/distributor/${creada}`,
        antes: async (c) => {
          const res = await llamar(c, 'post', '/distributor', 'super', {
            name: 'Baja T4',
            slug: `baja-t4-${randomUUID().slice(0, 8)}`,
          });
          expect(res.status).toBe(201);
          creada = (res.body as { distributor_id: string }).distributor_id;
        },
        verificar: async (_b, c) =>
          expect(
            (await llamar(c, 'get', `/distributor/${creada}`, 'super')).status,
          ).toBe(404),
      });
    })(),
  ];
  correrMatriz('distribuidoras', ver, cases);

  const bank = endpoint<EscenarioT4>(
    'get',
    '/v2/distributor/bank-details',
    '/v2/distributor/bank-details',
  );
  const putBank = endpoint<EscenarioT4>(
    'put',
    '/v2/distributor/bank-details',
    '/v2/distributor/bank-details',
  );
  const mp = endpoint<EscenarioT4>(
    'get',
    '/v2/distributor/mercadopago-credentials',
    '/v2/distributor/mercadopago-credentials',
  );
  const putMp = endpoint<EscenarioT4>(
    'put',
    '/v2/distributor/mercadopago-credentials',
    '/v2/distributor/mercadopago-credentials',
  );
  const deactivate = endpoint<EscenarioT4>(
    'put',
    '/v2/distributor/mercadopago-credentials/deactivate',
    '/v2/distributor/mercadopago-credentials/deactivate',
  );
  correrMatriz('datos de cobro', ver, [
    bank('admin', 'adminA', 200),
    bank('sin token', undefined, 401),
    bank('cliente', 'clienteA', 403),
    bank('super sin tenant (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    putBank('guarda y relee', 'adminA', 200, {
      body: { alias: 'garrafas.t4', holder: 'Distribuidora T4' },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', '/v2/distributor/bank-details', 'adminA'))
            .body,
        ).toMatchObject({ alias: 'garrafas.t4', holder: 'Distribuidora T4' }),
    }),
    putBank('alias inválido', 'adminA', 400, { body: { alias: 'x' } }),
    putBank('CBU inválido', 'adminA', 400, {
      body: { cbu: '0170099220000067797371' },
    }),
    putBank('titular corto', 'adminA', 400, { body: { holder: 'x' } }),
    putBank('tipo inválido', 'adminA', 400, { body: { alias: 1 } }),
    putBank('campo extra', 'adminA', 400, { body: { ajeno: true } }),
    putBank('sin token', undefined, 401),
    putBank('cliente', 'clienteA', 403),
    putBank('chofer', 'chofer', 403),
    putBank('super sin tenant (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    mp('admin', 'adminA', 200),
    mp('sin token', undefined, 401),
    mp('cliente', 'clienteA', 403),
    mp('super sin tenant (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    putMp('requeridos', 'adminA', 400, { body: { accessToken: '' } }),
    putMp('tipos inválidos', 'adminA', 400, {
      body: { accessToken: 1, publicKey: 2, webhookSecret: 3 },
    }),
    putMp('guarda cifrado y nunca devuelve secretos', 'adminA', 200, {
      body: {
        accessToken: 'APP_USR-token-falso-t4',
        publicKey: 'APP_USR-publica-falsa-t4',
        webhookSecret: 'secreto-falso-t4',
      },
      verificar: async (b, c) => {
        const texto = JSON.stringify(b);
        expect(texto).not.toContain('token-falso-t4');
        expect(texto).not.toContain('publica-falsa-t4');
        expect(texto).not.toContain('secreto-falso-t4');
        expect(b).toMatchObject({ source: 'own', active: true });
        const releido = await llamar(
          c,
          'get',
          '/v2/distributor/mercadopago-credentials',
          'adminA',
        );
        expect(releido.status).toBe(200);
        expect(JSON.stringify(releido.body)).not.toContain('secreto-falso-t4');
      },
    }),
    putMp('token rechazado por Mercado Pago', 'adminA', 422, {
      body: {
        accessToken: 'APP_USR-rechazado-t4',
        publicKey: 'APP_USR-publica-t4',
        webhookSecret: 'secreto-t4',
      },
      antes: () => {
        mercadoPagoFetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: () => Promise.resolve({}),
        });
        return Promise.resolve();
      },
    }),
    putMp('Mercado Pago no responde', 'adminA', 502, {
      body: {
        accessToken: 'APP_USR-error-t4',
        publicKey: 'APP_USR-publica-t4',
        webhookSecret: 'secreto-t4',
      },
      antes: () => {
        mercadoPagoFetch.mockRejectedValueOnce(new Error('sin red'));
        return Promise.resolve();
      },
    }),
    putMp('sin token', undefined, 401),
    putMp('cliente', 'clienteA', 403),
    putMp('chofer', 'chofer', 403),
    putMp('super sin tenant (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    deactivate('baja lógica y relee sistema', 'adminA', 200, {
      verificar: async (b, c) => {
        expect(b).toMatchObject({ source: 'system', active: false });
        expect(
          (
            await llamar(
              c,
              'get',
              '/v2/distributor/mercadopago-credentials',
              'adminA',
            )
          ).body,
        ).toMatchObject({ source: 'system', active: false });
      },
    }),
    deactivate('sin cuenta propia', 'adminA', 404),
    deactivate('sin token', undefined, 401),
    deactivate('cliente', 'clienteA', 403),
    deactivate('chofer', 'chofer', 403),
    deactivate('super sin tenant (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
  ]);

  const route = endpoint<EscenarioT4>(
    'get',
    '/routes/driving',
    '/routes/driving',
  );
  correrMatriz('rutas', ver, [
    route('sin token', undefined, 401),
    route('administrador no autorizado', 'adminA', 403),
    route('orderId requerido', 'clienteA', 400),
    route('orderId inválido', 'clienteA', 400, {
      ruta: '/routes/driving?orderId=no',
    }),
    route('pedido inexistente', 'clienteA', 404, {
      ruta: (c) => `/routes/driving?orderId=${c.inexistente}`,
    }),
    route('from inválido', 'clienteA', 400, {
      ruta: (c) => `/routes/driving?orderId=${c.inexistente}&from=no`,
    }),
  ]);
  // Modo soporte: con sesión lee lo de su empresa y no escribe; sin sesión, nada.
  correrMatriz(
    'super admin en modo soporte',
    ver,
    casosEnModoSoporte(bank, putBank),
  );
});
