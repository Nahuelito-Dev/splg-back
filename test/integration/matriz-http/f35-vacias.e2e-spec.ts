import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { OrderStatus } from '../../../src/order/entities/order.entity';
import { OrderItem } from '../../../src/order/entities/order-item.entity';
import { createTestApp, TestEnv } from '../setup/test-env';
import { Caso, correrMatriz, endpoint, sembrarEscenario } from './matriz';
import {
  EscenarioT2,
  sembrarBaseT2,
  sembrarPedido,
  usarClave,
} from './t2-base';

/** Matriz HTTP F35 E4: declaración de vacías durante una entrega. */
describe('Matriz HTTP F35: PATCH /v2/orders/:id/empties (e2e)', () => {
  let env: TestEnv;
  let ctx: EscenarioT2;
  const ver = () => ctx;

  beforeAll(async () => {
    env = await createTestApp();
    ctx = await sembrarBaseT2(env.app, await sembrarEscenario(env.app));
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  const preparar =
    (estado: OrderStatus = OrderStatus.ON_THE_WAY, deB = false) =>
    async (c: EscenarioT2) => {
      c.p.vacias = await sembrarPedido(c, {
        estado,
        cliente: deB ? 'B' : 'A',
        chofer: deB ? 'B' : 'A',
        cantidad: 2,
      });
      await c.app
        .get(DataSource)
        .getRepository(OrderItem)
        .update({ orderId: c.p.vacias }, { containersCharged: 1 });
    };
  const ruta = (c: EscenarioT2) => `/v2/orders/${c.p.vacias}/empties`;
  const bodyValido = (c: EscenarioT2) => ({
    items: [{ gasCylinderId: c.garrafaA, emptiesReceived: 1 }],
  });
  const conClave = () => ({ 'Idempotency-Key': randomUUID() });
  const declarar = endpoint<EscenarioT2>(
    'patch',
    '/v2/orders/{id}/empties',
    ruta,
  );

  const casos: Array<Caso<EscenarioT2>> = [
    declarar('chofer asignado', 'chofer', 200, {
      antes: preparar(),
      body: bodyValido,
      cabeceras: conClave,
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          order_items: [{ emptiesExpected: 1, emptiesReceived: 1 }],
        }),
    }),
    declarar('chofer asignado sin cambio', 'chofer', 200, {
      antes: async (c) => {
        await preparar()(c);
        await c.app
          .get(DataSource)
          .getRepository(OrderItem)
          .update({ orderId: c.p.vacias }, { emptiesReceived: 1 });
      },
      body: bodyValido,
      cabeceras: conClave,
    }),
    declarar('items vacío', 'chofer', 400, {
      antes: preparar(),
      body: { items: [] },
    }),
    declarar('items no es una lista', 'chofer', 400, {
      antes: preparar(),
      body: { items: {} },
    }),
    declarar('gasCylinderId no es UUID', 'chofer', 400, {
      antes: preparar(),
      body: { items: [{ gasCylinderId: 'no-uuid', emptiesReceived: 1 }] },
    }),
    declarar('tipos repetidos', 'chofer', 400, {
      antes: preparar(),
      body: (c) => ({
        items: [
          { gasCylinderId: c.garrafaA, emptiesReceived: 0 },
          { gasCylinderId: c.garrafaA, emptiesReceived: 1 },
        ],
      }),
    }),
    declarar('vacías no enteras', 'chofer', 400, {
      antes: preparar(),
      body: (c) => ({
        items: [{ gasCylinderId: c.garrafaA, emptiesReceived: 0.5 }],
      }),
    }),
    declarar('vacías negativas', 'chofer', 400, {
      antes: preparar(),
      body: (c) => ({
        items: [{ gasCylinderId: c.garrafaA, emptiesReceived: -1 }],
      }),
    }),
    declarar('vacías mayores que las esperadas', 'chofer', 400, {
      antes: preparar(),
      body: (c) => ({
        items: [{ gasCylinderId: c.garrafaA, emptiesReceived: 2 }],
      }),
    }),
    declarar('tipo ajeno al pedido', 'chofer', 400, {
      antes: preparar(),
      body: (c) => ({
        items: [{ gasCylinderId: c.garrafaA2, emptiesReceived: 0 }],
      }),
    }),
    declarar('campo extra', 'chofer', 400, {
      antes: preparar(),
      body: (c) => ({ ...bodyValido(c), extra: true }),
    }),
    declarar('id mal formado', 'chofer', 400, {
      antes: preparar(),
      ruta: '/v2/orders/no-es-uuid/empties',
      body: bodyValido,
    }),
    declarar('sin token', undefined, 401, {
      antes: preparar(),
      cabeceras: { 'X-Client-Source': 'driver-app' },
      body: bodyValido,
    }),
    declarar('cliente', 'clienteA', 403, {
      antes: preparar(),
      body: bodyValido,
    }),
    declarar('administrador', 'adminA', 403, {
      antes: preparar(),
      body: bodyValido,
    }),
    declarar('otro chofer', 'choferA2', 403, {
      antes: preparar(),
      body: bodyValido,
    }),
    declarar('inexistente', 'chofer', 404, {
      antes: (c) => {
        c.p.vacias = c.inexistente;
        return Promise.resolve();
      },
      body: bodyValido,
    }),
    declarar('pedido pendiente (sin chofer asignado)', 'chofer', 403, {
      antes: preparar(OrderStatus.PENDING),
      body: bodyValido,
    }),
    declarar('pedido aceptado que todavía no salió', 'chofer', 409, {
      antes: preparar(OrderStatus.ACCEPTED),
      body: bodyValido,
    }),
    declarar('pedido entregado', 'chofer', 409, {
      antes: preparar(OrderStatus.DELIVERED),
      body: bodyValido,
    }),
    declarar('pedido de otra distribuidora', 'chofer', 404, {
      antes: preparar(OrderStatus.ON_THE_WAY, true),
      body: (c) => ({
        items: [{ gasCylinderId: c.garrafaB, emptiesReceived: 1 }],
      }),
    }),
    declarar('misma Idempotency-Key con otro cuerpo', 'chofer', 422, {
      antes: async (c) => {
        await preparar()(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          ruta(c),
          'chofer',
          bodyValido(c),
        );
      },
      body: (c) => ({
        items: [{ gasCylinderId: c.garrafaA, emptiesReceived: 0 }],
      }),
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
    }),
  ];

  correrMatriz('F35 E4 · vacías recibidas', ver, casos);
});
