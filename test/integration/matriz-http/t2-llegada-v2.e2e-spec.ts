/**
 * Matriz HTTP de `PATCH /v2/orders/{id}/arrived` («Llegué» con control de
 * distancia) y la regresión de la v1, que queda igual. El domicilio de los
 * pedidos es `ZONA_CENTRO`; el radio se fija con el PUT del despacho, así pasa
 * por la misma caché que usa el endpoint.
 */
import { DataSource } from 'typeorm';
import { Order, OrderStatus } from '../../../src/order/entities/order.entity';
import { UserAddress } from '../../../src/user-address/entities/user-address.entity';
import { FcmPort } from '../../../src/firebase/ports/fcm.port';
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
} from './t2-base';
import { casosEnModoSoporte } from './soporte';

type Ctx = EscenarioT2;

/** ≈ 56 m al sur del domicilio. */
const CERCA = {
  latitude: ZONA_CENTRO.lat - 0.0005,
  longitude: ZONA_CENTRO.lng,
};
/** ≈ 2,2 km al sur del domicilio. */
const LEJOS = { latitude: ZONA_CENTRO.lat - 0.02, longitude: ZONA_CENTRO.lng };

describe('Matriz HTTP: «Llegué» con control de distancia (e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;
  const E = OrderStatus;
  let primerToque: ReturnType<typeof llamar>;
  /** FCM de mentira: los clientes sembrados tienen token `fake-fcm`. */
  const fcm = { sendToToken: jest.fn<Promise<string>, [string, unknown]>() };
  /** Pushes de llegada enviados para el pedido del caso. */
  const pushesDeLlegada = (orderId: string) =>
    fcm.sendToToken.mock.calls.filter(
      ([, m]) =>
        (m as { data?: { event?: string; orderId?: string } }).data?.event ===
          'ORDER_ARRIVED' &&
        (m as { data: { orderId: string } }).data.orderId === orderId,
    ).length;

  /** Cómo terminó cada push de llegada: el id de FCM o el error. */
  const resultadosDeLlegada = () =>
    Promise.all(
      fcm.sendToToken.mock.calls
        .map((llamada, i) => ({ llamada, i }))
        .filter(
          ({ llamada }) =>
            (llamada[1] as { data?: { event?: string } }).data?.event ===
            'ORDER_ARRIVED',
        )
        .map(({ i }) =>
          (fcm.sendToToken.mock.results[i].value as Promise<string>).catch(
            (e: Error) => e.message,
          ),
        ),
    );

  beforeEach(() => {
    fcm.sendToToken.mockReset();
    fcm.sendToToken.mockResolvedValue('msg-1');
  });

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp({
      overrides: [{ token: FcmPort, value: fcm }],
    });
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
  /** Fija el radio de la distribuidora A por la API (y antes siembra el pedido). */
  const conRadio =
    (metros: number, o: OpcionesPedido = { estado: E.ON_THE_WAY }) =>
    async (c: Ctx): Promise<void> => {
      const r = await llamar(c, 'put', '/module-config/dispatch', 'adminA', {
        arrivalRadiusMeters: metros,
      });
      expect(r.status).toBe(200);
      await nuevo(o)(c);
    };
  /** Pedido en camino cuyo domicilio no tiene ubicación (ni punto de entrega). */
  const sinUbicacion = async (c: Ctx): Promise<void> => {
    await conRadio(150)(c);
    const ds = c.app.get(DataSource);
    const dir = await ds.getRepository(UserAddress).save({
      userId: c.clienteA.userId,
      street: 'Calle sin mapa',
      city: 'CABA',
      isDefault: false,
    } as unknown as Partial<UserAddress>);
    await ds.getRepository(Order).update({ orderId: c.p.l }, {
      addressId: dir.addressId,
      deliveryPoint: null,
    } as Partial<Order>);
  };

  const SW = '/orders/{id}/arrived';
  const v2 = endpoint<Ctx>(
    'patch',
    `/v2${SW}`,
    (c) => `/v2/orders/${c.p.l}/arrived`,
  );
  const enCamino = nuevo({ estado: E.ON_THE_WAY });

  const casos: Array<Caso<Ctx>> = [
    v2('chofer asignado en la puerta', 'chofer', 200, {
      antes: conRadio(150),
      body: CERCA,
      verificar: (cuerpo) =>
        expect(cuerpo).toEqual({ message: 'Cliente notificado' }),
    }),
    v2('radio en 0: sin control aunque esté lejos', 'chofer', 200, {
      antes: conRadio(0),
      body: LEJOS,
    }),
    v2('domicilio sin ubicación: se permite', 'chofer', 200, {
      antes: sinUbicacion,
      body: LEJOS,
    }),
    v2(
      'marcar dos veces: la segunda es 200 sin re-notificar ni mirar la distancia',
      'chofer',
      200,
      {
        antes: conRadio(150),
        body: CERCA,
        verificar: async (_cuerpo, c) => {
          expect(pushesDeLlegada(c.p.l)).toBe(1);
          const r = await llamar(
            c,
            'patch',
            `/v2/orders/${c.p.l}/arrived`,
            'chofer',
            LEJOS,
          );
          expect(r.status).toBe(200);
          expect(r.body).toEqual({ message: 'Cliente notificado' });
          expect(pushesDeLlegada(c.p.l)).toBe(1);
        },
      },
    ),
    v2(
      'el push falló: 200 y el reintento del chofer vuelve a avisar',
      'chofer',
      200,
      {
        antes: async (c) => {
          await conRadio(150)(c);
          fcm.sendToToken.mockRejectedValueOnce(new Error('FCM caído'));
        },
        body: CERCA,
        verificar: async (_cuerpo, c) => {
          expect(pushesDeLlegada(c.p.l)).toBe(1);
          const r = await llamar(
            c,
            'patch',
            `/v2/orders/${c.p.l}/arrived`,
            'chofer',
            CERCA,
          );
          expect(r.status).toBe(200);
          expect(pushesDeLlegada(c.p.l)).toBe(2);
          // Ahora salió: el tercero ya no avisa.
          await llamar(
            c,
            'patch',
            `/v2/orders/${c.p.l}/arrived`,
            'chofer',
            CERCA,
          );
          expect(pushesDeLlegada(c.p.l)).toBe(2);
        },
      },
    ),
    v2(
      'dos toques a la vez y el primer push lento falla: el segundo avisa',
      'chofer',
      200,
      {
        antes: async (c) => {
          await conRadio(150)(c);
          // El primer push de llegada tarda y falla; los demás salen.
          const base = fcm.sendToToken.getMockImplementation();
          let primero = true;
          fcm.sendToToken.mockImplementation((token: string, m: unknown) => {
            const evento = (m as { data?: { event?: string } }).data?.event;
            if (evento === 'ORDER_ARRIVED' && primero) {
              primero = false;
              return new Promise((_r, rechazar) =>
                setTimeout(() => rechazar(new Error('FCM caído')), 600),
              );
            }
            return base!(token, m);
          });
          // El primer toque queda enviando; el de la matriz es el segundo.
          primerToque = llamar(
            c,
            'patch',
            `/v2/orders/${c.p.l}/arrived`,
            'chofer',
            CERCA,
          );
          await new Promise((r) => setTimeout(r, 150));
        },
        body: CERCA,
        verificar: async (_cuerpo, c) => {
          const r = await primerToque;
          expect({
            primerToque: r.status,
            pushes: pushesDeLlegada(c.p.l),
            resultados: await resultadosDeLlegada(),
          }).toEqual({
            primerToque: 200,
            pushes: 2,
            // El primero falló; el segundo (el del toque que esperó) salió.
            resultados: ['FCM caído', 'msg-1'],
          });
        },
      },
    ),
    v2('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'driver-app' },
      ruta: (c) => `/v2/orders/${c.inexistente}/arrived`,
      body: CERCA,
    }),
    v2('cliente', 'clienteA', 403, { antes: enCamino, body: CERCA }),
    v2('administrador (la v2 es sólo del chofer)', 'adminA', 403, {
      antes: enCamino,
      body: CERCA,
    }),
    v2('chofer de otro pedido', 'choferA2', 403, {
      antes: enCamino,
      body: CERCA,
    }),
    v2('sin cuerpo', 'chofer', 400, { antes: enCamino }),
    v2('sin longitud', 'chofer', 400, {
      antes: enCamino,
      body: { latitude: CERCA.latitude },
    }),
    v2('latitud fuera de rango', 'chofer', 400, {
      antes: enCamino,
      body: { latitude: 91, longitude: CERCA.longitude },
    }),
    v2('longitud fuera de rango', 'chofer', 400, {
      antes: enCamino,
      body: { latitude: CERCA.latitude, longitude: -181 },
    }),
    v2('latitud como texto', 'chofer', 400, {
      antes: enCamino,
      body: { latitude: '-34.6', longitude: CERCA.longitude },
    }),
    v2('id mal formado', 'chofer', 400, {
      ruta: '/v2/orders/xx/arrived',
      body: CERCA,
    }),
    v2('inexistente', 'chofer', 404, {
      ruta: (c) => `/v2/orders/${c.inexistente}/arrived`,
      body: CERCA,
    }),
    v2('chofer de otra distribuidora', 'choferB', 404, {
      antes: enCamino,
      body: CERCA,
    }),
    v2('lejos del domicilio', 'chofer', 409, {
      antes: conRadio(150),
      body: LEJOS,
      code: 'ARRIVAL_TOO_FAR',
      mensaje:
        /^Todavía estás a \d+ m del domicilio\. Marcá «Llegué» cuando estés en la puerta\.$/,
      verificar: (cuerpo) => {
        const c = cuerpo as { distanceMeters: number; radiusMeters: number };
        expect(c.radiusMeters).toBe(150);
        expect(c.distanceMeters).toBeGreaterThan(2000);
        expect(c.distanceMeters).toBeLessThan(2500);
        expect(Number.isInteger(c.distanceMeters)).toBe(true);
      },
    }),
    v2('radio de 5000 m: a 2,2 km pasa', 'chofer', 200, {
      antes: conRadio(5000),
      body: LEJOS,
    }),
    v2('pedido aceptado, todavía no en camino', 'chofer', 409, {
      antes: nuevo({ estado: E.ACCEPTED }),
      body: CERCA,
      code: 'ORDER_NOT_ON_THE_WAY',
    }),
    v2('pedido entregado', 'chofer', 409, {
      antes: nuevo({ estado: E.DELIVERED }),
      body: CERCA,
      code: 'ORDER_NOT_ON_THE_WAY',
    }),
  ];

  // La v1 queda como estaba: sin cuerpo, sin control y con 400 por estado.
  const v1 = endpoint<Ctx>('patch', SW, (c) => `/orders/${c.p.l}/arrived`);
  const casosV1: Array<Caso<Ctx>> = [
    v1('v1 · chofer sin cuerpo y con radio activo', 'chofer', 200, {
      antes: conRadio(150),
    }),
    v1('v1 · administrador', 'adminA', 200, { antes: enCamino }),
    v1('v1 · pedido aceptado sigue siendo 400', 'chofer', 400, {
      antes: nuevo({ estado: E.ACCEPTED }),
    }),
  ];

  // Modo soporte: con sesión lee lo de su empresa y no escribe; sin sesión, nada.
  correrMatriz(
    'super admin en modo soporte',
    ver,
    casosEnModoSoporte(endpoint<Ctx>('get', '/orders', '/orders'), v1),
  );
  correrMatriz(
    'PATCH /v2/orders/{id}/arrived',
    ver,
    conMismaDistribuidora(casos),
  );
  correrMatriz('PATCH /orders/{id}/arrived (v1, regresión)', ver, casosV1);
});
