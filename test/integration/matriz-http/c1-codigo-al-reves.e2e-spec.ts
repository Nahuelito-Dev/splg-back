/**
 * Matriz HTTP del código de entrega «al revés» (C1, API v3): el cliente ve el
 * código y se lo dice al chofer; el chofer lo escribe con su ubicación. Incluye
 * la regresión del cierre de permisos en v1 y v2 (en sus propias suites de
 * pedidos). El domicilio de los pedidos es `ZONA_CENTRO`; el radio de llegada
 * se fija con el PUT del despacho.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Order, OrderStatus } from '../../../src/order/entities/order.entity';
import { TestEnv, createTestApp } from '../setup/test-env';
import {
  Caso,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
  sembrarEscenario,
} from './matriz';
import {
  EscenarioT2,
  OpcionesPedido,
  ZONA_CENTRO,
  conMismaDistribuidora,
  sembrarBaseT2,
  sembrarPedido,
  usarClave,
} from './t2-base';

type Ctx = EscenarioT2;

/** ≈ 56 m al sur del domicilio. */
const CERCA = {
  latitude: ZONA_CENTRO.lat - 0.0005,
  longitude: ZONA_CENTRO.lng,
};
/** ≈ 2,2 km al sur del domicilio. */
const LEJOS = { latitude: ZONA_CENTRO.lat - 0.02, longitude: ZONA_CENTRO.lng };
const CODIGO = '123456';
const MOTIVO = 'El cliente no tiene celular: confirmó por teléfono';

describe('Matriz HTTP: código de entrega al revés (v3, e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;
  const E = OrderStatus;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    ctx = {
      ...(await sembrarBaseT2(env.app, await sembrarEscenario(env.app))),
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
  }, 300000);

  afterAll(async () => {
    await env.cleanup();
  });

  const nuevo =
    (o: OpcionesPedido = {}) =>
    async (c: Ctx): Promise<void> => {
      c.p.l = await sembrarPedido(c, o);
    };
  const enCamino = nuevo({ estado: E.ON_THE_WAY });
  /** Fija el radio de llegada de la distribuidora A y siembra el pedido en camino. */
  const conRadio = (metros: number) => async (c: Ctx) => {
    const r = await llamar(c, 'put', '/module-config/dispatch', 'adminA', {
      arrivalRadiusMeters: metros,
    });
    expect(r.status).toBe(200);
    await enCamino(c);
  };
  const pedido = (c: Ctx) =>
    c.app
      .get(DataSource)
      .getRepository(Order)
      .findOneByOrFail({ orderId: c.p.l });
  const equivocarse = (n: number) => async (c: Ctx) => {
    for (let i = 0; i < n; i += 1) {
      await llamar(
        c,
        'post',
        `/v3/orders/${c.p.l}/confirm-delivery`,
        'chofer',
        {
          code: '000000',
          ...CERCA,
        },
      );
    }
  };

  // ============================================== GET /v3/orders/{id}/delivery-code
  const SW_GET = '/orders/{id}/delivery-code';
  const ver_ = endpoint<Ctx>(
    'get',
    `/v3${SW_GET}`,
    (c) => `/v3/orders/${c.p.l}/delivery-code`,
  );
  const casosVer: Array<Caso<Ctx>> = [
    ver_('cliente dueño, pedido en camino', 'clienteA', 200, {
      antes: enCamino,
      verificar: (cuerpo, c) =>
        expect(cuerpo).toEqual({
          orderId: c.p.l,
          deliveryCode: CODIGO,
          attempts: 0,
          blocked: false,
        }),
    }),
    ver_('cliente dueño, pedido aceptado', 'clienteA', 200, {
      antes: nuevo({ estado: E.ACCEPTED }),
    }),
    ver_('cliente con el código bloqueado', 'clienteA', 200, {
      antes: async (c) => {
        await enCamino(c);
        await equivocarse(5)(c);
      },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ attempts: 5, blocked: true }),
    }),
    ver_(
      'código viejo de 10 caracteres: se cambia por uno de 6 dígitos',
      'clienteA',
      200,
      {
        antes: async (c) => {
          await enCamino(c);
          await c.app
            .get(DataSource)
            .getRepository(Order)
            .update(
              { orderId: c.p.l },
              { deliveryCode: 'A1B2C3D4E5', deliveryCodeAttempts: 3 },
            );
        },
        verificar: async (cuerpo, c) => {
          const r = cuerpo as { deliveryCode: string; attempts: number };
          expect(r.deliveryCode).toMatch(/^\d{6}$/);
          expect(r.attempts).toBe(0);
          expect((await pedido(c)).deliveryCode).toBe(r.deliveryCode);
        },
      },
    ),
    ver_('administrador', 'adminA', 200, { antes: enCamino }),
    ver_('super en modo soporte sobre A', 'soporteA', 200, {
      antes: enCamino,
    }),
    ver_('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'customer-app' },
      ruta: (c) => `/v3/orders/${c.inexistente}/delivery-code`,
    }),
    ver_('chofer (nunca lo ve)', 'chofer', 403, { antes: enCamino }),
    ver_('id mal formado', 'clienteA', 400, {
      ruta: '/v3/orders/xx/delivery-code',
    }),
    ver_('pedido de otro cliente', 'clienteB', 404, { antes: enCamino }),
    ver_('inexistente', 'clienteA', 404, {
      ruta: (c) => `/v3/orders/${c.inexistente}/delivery-code`,
    }),
    ver_('administrador de otra distribuidora', 'adminB', 404, {
      antes: enCamino,
    }),
    ver_('pedido pendiente: todavía no hay código', 'clienteA', 409, {
      antes: nuevo(),
      code: 'ORDER_WITHOUT_DELIVERY_CODE',
    }),
    ver_('pedido ya entregado', 'clienteA', 409, {
      antes: nuevo({ estado: E.DELIVERED }),
      code: 'ORDER_WITHOUT_DELIVERY_CODE',
    }),
  ];

  // ================================ POST /v3/orders/{id}/delivery-code/regenerate
  const SW_REG = '/orders/{id}/delivery-code/regenerate';
  const regenerar = endpoint<Ctx>(
    'post',
    `/v3${SW_REG}`,
    (c) => `/v3/orders/${c.p.l}/delivery-code/regenerate`,
  );
  const casosRegenerar: Array<Caso<Ctx>> = [
    regenerar('cliente dueño: código nuevo y sin intentos', 'clienteA', 201, {
      antes: enCamino,
      verificar: async (cuerpo, c) => {
        const r = cuerpo as { orderId: string; deliveryCode: string };
        expect(r).toMatchObject({
          orderId: c.p.l,
          attempts: 0,
          blocked: false,
        });
        expect(r.deliveryCode).toMatch(/^\d{6}$/);
        expect(r.deliveryCode).not.toBe(CODIGO);
        expect((await pedido(c)).deliveryCode).toBe(r.deliveryCode);
      },
    }),
    regenerar(
      'bloqueado por 5 errores del chofer: con el código nuevo el chofer entrega',
      'clienteA',
      201,
      {
        antes: async (c) => {
          await enCamino(c);
          await equivocarse(5)(c);
        },
        verificar: async (cuerpo, c) => {
          const nuevoCodigo = (cuerpo as { deliveryCode: string }).deliveryCode;
          expect((await pedido(c)).deliveryCodeAttempts).toBe(0);
          const r = await llamar(
            c,
            'post',
            `/v3/orders/${c.p.l}/confirm-delivery`,
            'chofer',
            { code: nuevoCodigo, ...CERCA },
          );
          expect(r.status).toBe(200);
        },
      },
    ),
    regenerar('administrador', 'adminA', 201, { antes: enCamino }),
    regenerar('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      antes: enCamino,
      code: 'SUPPORT_SESSION_REQUIRED',
      verificar: async (_cuerpo, c) =>
        expect((await pedido(c)).deliveryCode).toBe(CODIGO),
    }),
    regenerar('super en modo soporte sobre A', 'soporteA', 403, {
      antes: enCamino,
      code: 'SUPPORT_READ_ONLY',
    }),
    regenerar('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'customer-app' },
      ruta: (c) => `/v3/orders/${c.inexistente}/delivery-code/regenerate`,
    }),
    regenerar('chofer', 'chofer', 403, {
      antes: enCamino,
      verificar: async (_cuerpo, c) =>
        expect((await pedido(c)).deliveryCode).toBe(CODIGO),
    }),
    regenerar('id mal formado', 'clienteA', 400, {
      ruta: '/v3/orders/xx/delivery-code/regenerate',
    }),
    regenerar('pedido de otro cliente', 'clienteB', 404, {
      antes: enCamino,
      verificar: async (_cuerpo, c) =>
        expect((await pedido(c)).deliveryCode).toBe(CODIGO),
    }),
    regenerar('inexistente', 'clienteA', 404, {
      ruta: (c) => `/v3/orders/${c.inexistente}/delivery-code/regenerate`,
    }),
    regenerar('administrador de otra distribuidora', 'adminB', 404, {
      antes: enCamino,
    }),
    regenerar('pedido aceptado, todavía no en camino', 'clienteA', 409, {
      antes: nuevo({ estado: E.ACCEPTED }),
      code: 'ORDER_NOT_ON_THE_WAY',
    }),
    regenerar('pedido entregado', 'clienteA', 409, {
      antes: nuevo({ estado: E.DELIVERED }),
      code: 'ORDER_NOT_ON_THE_WAY',
    }),
  ];

  // ================================= POST /v3/orders/{id}/confirm-delivery
  const SW_CONF = '/orders/{id}/confirm-delivery';
  const confirmar = endpoint<Ctx>(
    'post',
    `/v3${SW_CONF}`,
    (c) => `/v3/orders/${c.p.l}/confirm-delivery`,
  );
  const bueno = { code: CODIGO, ...CERCA };
  const casosConfirmar: Array<Caso<Ctx>> = [
    confirmar('chofer asignado en la puerta', 'chofer', 200, {
      antes: conRadio(150),
      body: { ...bueno, accuracyMeters: 8.5 },
      verificar: async (cuerpo, c) => {
        const d = cuerpo as {
          status: string;
          deliveryConfirmation: Record<string, unknown>;
        };
        expect(d.status).toBe('delivered');
        expect(d.deliveryConfirmation).toMatchObject({
          confirmedByRole: 'delivery',
          latitude: CERCA.latitude,
          longitude: CERCA.longitude,
          accuracyMeters: 8.5,
          outOfRange: false,
        });
        expect(d.deliveryConfirmation.distanceMeters as number).toBeLessThan(
          100,
        );
        const o = await pedido(c);
        expect(o.deliveredAt).not.toBeNull();
        expect(o.deliveryConfirmedByRole).toBe('delivery');
        expect(o.deliveryConfirmedOutOfRange).toBe(false);
      },
    }),
    confirmar(
      'chofer fuera del radio: entrega y queda marcado',
      'chofer',
      200,
      {
        antes: conRadio(150),
        body: { code: CODIGO, ...LEJOS },
        verificar: async (cuerpo, c) => {
          const d = cuerpo as {
            deliveryConfirmation: {
              outOfRange: boolean;
              distanceMeters: number;
            };
          };
          expect(d.deliveryConfirmation.outOfRange).toBe(true);
          expect(d.deliveryConfirmation.distanceMeters).toBeGreaterThan(2000);
          expect((await pedido(c)).deliveryConfirmedOutOfRange).toBe(true);
        },
      },
    ),
    confirmar('radio en 0: lejos y sin marca', 'chofer', 200, {
      antes: conRadio(0),
      body: { code: CODIGO, ...LEJOS },
      verificar: (cuerpo) =>
        expect(
          (cuerpo as { deliveryConfirmation: { outOfRange: boolean } })
            .deliveryConfirmation.outOfRange,
        ).toBe(false),
    }),
    confirmar(
      'la entrega repetida responde 200 con el pedido, sin pedir el código',
      'chofer',
      200,
      {
        antes: nuevo({ estado: E.DELIVERED }),
        body: { code: '000000', ...CERCA },
        verificar: (cuerpo) =>
          expect(cuerpo).toMatchObject({ status: 'delivered' }),
      },
    ),
    confirmar('administrador con motivo, sin ubicación', 'adminA', 200, {
      antes: enCamino,
      body: { reason: MOTIVO },
      verificar: async (cuerpo, c) => {
        expect(
          (cuerpo as { deliveryConfirmation: Record<string, unknown> })
            .deliveryConfirmation,
        ).toMatchObject({
          confirmedByRole: 'admin',
          latitude: null,
          longitude: null,
          distanceMeters: null,
          outOfRange: false,
        });
        expect((await pedido(c)).deliveryConfirmedPoint).toBeNull();
      },
    }),
    confirmar('super en modo soporte sobre A', 'soporteA', 403, {
      antes: enCamino,
      body: { reason: MOTIVO },
      code: 'SUPPORT_READ_ONLY',
    }),
    confirmar('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'driver-app' },
      ruta: (c) => `/v3/orders/${c.inexistente}/confirm-delivery`,
      body: bueno,
    }),
    confirmar('cliente (no confirma)', 'clienteA', 403, {
      antes: enCamino,
      body: { code: CODIGO },
      verificar: async (_cuerpo, c) =>
        expect((await pedido(c)).status).toBe(E.ON_THE_WAY),
    }),
    confirmar('chofer de otro pedido', 'choferA2', 403, {
      antes: enCamino,
      body: bueno,
    }),
    confirmar('sin cuerpo', 'chofer', 400, {
      antes: enCamino,
      code: 'VALIDATION',
    }),
    confirmar('sin ubicación', 'chofer', 400, {
      antes: enCamino,
      body: { code: CODIGO },
      code: 'VALIDATION',
    }),
    confirmar('sin código', 'chofer', 400, {
      antes: enCamino,
      body: CERCA,
      code: 'VALIDATION',
    }),
    confirmar('código de 5 dígitos: no cuenta como intento', 'chofer', 400, {
      antes: enCamino,
      body: { code: '12345', ...CERCA },
      code: 'DELIVERY_CODE_FORMATO',
      verificar: async (_cuerpo, c) =>
        expect((await pedido(c)).deliveryCodeAttempts).toBe(0),
    }),
    confirmar('código con letras', 'chofer', 400, {
      antes: enCamino,
      body: { code: '12A456', ...CERCA },
      code: 'DELIVERY_CODE_FORMATO',
    }),
    confirmar(
      'código incorrecto: suma un intento y dice cuántos quedan',
      'chofer',
      400,
      {
        antes: enCamino,
        body: { code: '999999', ...CERCA },
        code: 'DELIVERY_CODE_INCORRECTO',
        verificar: async (cuerpo, c) => {
          expect(cuerpo).toMatchObject({ attempts: 1, remaining: 4 });
          expect((await pedido(c)).deliveryCodeAttempts).toBe(1);
          expect((await pedido(c)).status).toBe(E.ON_THE_WAY);
        },
      },
    ),
    confirmar('el cuarto error todavía deja uno', 'chofer', 400, {
      antes: async (c) => {
        await enCamino(c);
        await equivocarse(3)(c);
      },
      body: { code: '999999', ...CERCA },
      code: 'DELIVERY_CODE_INCORRECTO',
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ attempts: 4, remaining: 1 }),
    }),
    confirmar('código que no es texto: formato, no cuenta', 'chofer', 400, {
      antes: enCamino,
      body: { code: 123456, ...CERCA },
      code: 'DELIVERY_CODE_FORMATO',
      verificar: async (_cuerpo, c) =>
        expect((await pedido(c)).deliveryCodeAttempts).toBe(0),
    }),
    confirmar('latitud null', 'chofer', 400, {
      antes: enCamino,
      body: { code: CODIGO, latitude: null, longitude: CERCA.longitude },
      code: 'VALIDATION',
      verificar: async (_cuerpo, c) =>
        expect((await pedido(c)).status).toBe(E.ON_THE_WAY),
    }),
    confirmar(
      'reintento con la misma clave de un código incorrecto: mismo 400, sin sumar otro intento',
      'chofer',
      400,
      {
        antes: async (c) => {
          await enCamino(c);
          c.p.clave = randomUUID();
          const r = await request(c.app.getHttpServer())
            .post(`/v3/orders/${c.p.l}/confirm-delivery`)
            .set({ ...c.actores.chofer, 'Idempotency-Key': c.p.clave })
            .send({ code: '999999', ...CERCA });
          expect(r.status).toBe(400);
        },
        cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
        body: { code: '999999', ...CERCA },
        code: 'DELIVERY_CODE_INCORRECTO',
        verificar: async (cuerpo, c) => {
          expect(cuerpo).toMatchObject({ attempts: 1, remaining: 4 });
          expect((await pedido(c)).deliveryCodeAttempts).toBe(1);
        },
      },
    ),
    confirmar('latitud fuera de rango', 'chofer', 400, {
      antes: enCamino,
      body: { code: CODIGO, latitude: 91, longitude: CERCA.longitude },
    }),
    confirmar('longitud fuera de rango', 'chofer', 400, {
      antes: enCamino,
      body: { code: CODIGO, latitude: CERCA.latitude, longitude: -181 },
    }),
    confirmar('latitud como texto', 'chofer', 400, {
      antes: enCamino,
      body: { code: CODIGO, latitude: '-34.6', longitude: CERCA.longitude },
    }),
    confirmar('precisión negativa', 'chofer', 400, {
      antes: enCamino,
      body: { ...bueno, accuracyMeters: -1 },
    }),
    confirmar('precisión de más de 10000 m', 'chofer', 400, {
      antes: enCamino,
      body: { ...bueno, accuracyMeters: 10001 },
    }),
    confirmar('campo desconocido', 'chofer', 400, {
      antes: enCamino,
      body: { ...bueno, foo: 1 },
    }),
    confirmar('id mal formado', 'chofer', 400, {
      ruta: '/v3/orders/xx/confirm-delivery',
      body: bueno,
    }),
    confirmar('administrador sin motivo', 'adminA', 400, {
      antes: enCamino,
      body: {},
    }),
    confirmar('administrador con motivo corto', 'adminA', 400, {
      antes: enCamino,
      body: { reason: 'corto' },
    }),
    confirmar(
      'administrador con un código equivocado: es informativo, entrega igual',
      'adminA',
      200,
      {
        antes: enCamino,
        body: { code: '999999', reason: MOTIVO },
        verificar: async (cuerpo, c) => {
          expect(cuerpo).toMatchObject({ status: 'delivered' });
          expect((await pedido(c)).deliveryCodeAttempts).toBe(0);
        },
      },
    ),
    confirmar('administrador con código y sin motivo', 'adminA', 400, {
      antes: enCamino,
      body: { code: CODIGO },
      verificar: async (_cuerpo, c) =>
        expect((await pedido(c)).status).toBe(E.ON_THE_WAY),
    }),
    confirmar('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      antes: enCamino,
      body: { reason: MOTIVO },
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    confirmar('inexistente', 'chofer', 404, {
      ruta: (c) => `/v3/orders/${c.inexistente}/confirm-delivery`,
      body: bueno,
    }),
    confirmar('chofer de otra distribuidora', 'choferB', 404, {
      antes: enCamino,
      body: bueno,
    }),
    confirmar('administrador de otra distribuidora', 'adminB', 404, {
      antes: enCamino,
      body: { reason: MOTIVO },
      verificar: async (_cuerpo, c) =>
        expect((await pedido(c)).status).toBe(E.ON_THE_WAY),
    }),
    confirmar('pedido aceptado, todavía no en camino', 'chofer', 409, {
      antes: nuevo({ estado: E.ACCEPTED }),
      body: bueno,
      code: 'ORDER_NOT_ON_THE_WAY',
    }),
    confirmar('pedido pendiente', 'chofer', 409, {
      antes: async (c) => {
        await nuevo()(c);
        await c.app
          .get(DataSource)
          .getRepository(Order)
          .update({ orderId: c.p.l }, { deliveryId: c.choferA.deliveryId });
      },
      body: bueno,
      code: 'ORDER_NOT_ON_THE_WAY',
    }),
    confirmar('se agotaron los 5 intentos', 'chofer', 409, {
      antes: async (c) => {
        await enCamino(c);
        await equivocarse(5)(c);
      },
      body: bueno,
      code: 'DELIVERY_CODE_BLOQUEADO',
      verificar: async (_cuerpo, c) =>
        expect((await pedido(c)).status).toBe(E.ON_THE_WAY),
    }),
    confirmar('el 5.º error ya responde bloqueado', 'chofer', 409, {
      antes: async (c) => {
        await enCamino(c);
        await equivocarse(4)(c);
      },
      body: { code: '999999', ...CERCA },
      code: 'DELIVERY_CODE_BLOQUEADO',
    }),
    confirmar('la misma clave con otro cuerpo', 'chofer', 422, {
      antes: async (c) => {
        await enCamino(c);
        c.p.clave = await usarClave(
          c,
          'post',
          `/v3/orders/${c.p.l}/confirm-delivery`,
          'chofer',
          bueno,
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: { code: '111111', ...CERCA },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  correrMatriz(
    'GET /v3/orders/{id}/delivery-code',
    ver,
    conMismaDistribuidora(casosVer),
  );
  correrMatriz(
    'POST /v3/orders/{id}/delivery-code/regenerate',
    ver,
    conMismaDistribuidora(casosRegenerar),
  );
  correrMatriz(
    'POST /v3/orders/{id}/confirm-delivery',
    ver,
    conMismaDistribuidora(casosConfirmar),
  );
});
