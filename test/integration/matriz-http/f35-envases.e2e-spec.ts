/** Matriz HTTP F35: interruptor, precio y cuenta de envases por tenant. */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { GasCylinder } from '../../../src/gascylinder/entities/gascylinder.entity';
import { Customer } from '../../../src/customer/entities/customer.entity';
import { createTestApp, TestEnv } from '../setup/test-env';
import {
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
} from './matriz';
import { EscenarioT2, sembrarBaseT2 } from './t2-base';
import { sembrarEscenario } from './matriz';

interface Ctx extends EscenarioT2 {
  customerA: string;
  customerB: string;
  gasSinPrecio: string;
}

describe('Matriz HTTP F35: cobro de envases (e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    const base = await sembrarBaseT2(env.app, await sembrarEscenario(env.app));
    const ds = env.app.get(DataSource);
    await ds
      .getRepository(GasCylinder)
      .update({ gasCylinderId: base.garrafaA }, { containerPrice: 250 });
    const sinPrecio = await ds.getRepository(GasCylinder).save({
      distributorId: base.distA.id,
      type: 'Envase sin precio F35',
      weight: 12,
      price: 1200,
      containerPrice: null,
      stock: 100,
      isActive: true,
    } as Partial<GasCylinder>);
    const customerA = await ds.getRepository(Customer).findOneByOrFail({
      userId: base.clienteA.userId,
    });
    const customerB = await ds.getRepository(Customer).findOneByOrFail({
      userId: base.clienteB.userId,
    });
    ctx = {
      ...base,
      customerA: customerA.customerId,
      customerB: customerB.customerId,
      gasSinPrecio: sinPrecio.gasCylinderId,
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
  }, 300000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  const pedido = (c: Ctx, gasCylinderId = c.garrafaA) => ({
    customerId: c.clienteA.userId,
    addressId: c.dirCentro,
    paymentMethod: 'cash',
    items: [{ gasCylinderId, quantity: 1, unitPrice: 1 }],
  });
  const cotizacion = (c: Ctx, gasCylinderId = c.garrafaA) => ({
    paymentMethod: 'cash',
    items: [{ gasCylinderId, quantity: 1, unitPrice: 1 }],
  });
  const ajuste = (c: Ctx, extra: Record<string, unknown> = {}) => ({
    gasCylinderId: c.garrafaA,
    quantity: 2,
    note: 'Ajuste manual válido de prueba',
    ...extra,
  });
  const encenderConPrecio = async (c: Ctx): Promise<void> => {
    await c.app
      .get(DataSource)
      .getRepository(GasCylinder)
      .update({ gasCylinderId: c.garrafaA }, { containerPrice: 400 });
    // Los casos de ajuste de esta misma matriz le suman envases al cliente: se parte de
    // una cuenta en cero para que el pedido necesite comprar el envase.
    await c.app
      .get(DataSource)
      .query(
        `DELETE FROM customer_container_movement WHERE account_id IN (SELECT account_id FROM customer_container_account WHERE gas_cylinder_id = $1)`,
        [c.garrafaA],
      );
    await c.app
      .get(DataSource)
      .query(
        `DELETE FROM customer_container_account WHERE gas_cylinder_id = $1`,
        [c.garrafaA],
      );
    await llamar(c, 'put', '/v2/container-charge', 'adminA', {
      enabled: true,
    });
  };

  const getInterruptor = endpoint<Ctx>(
    'get',
    '/v2/container-charge',
    '/v2/container-charge',
  );
  const putInterruptor = endpoint<Ctx>(
    'put',
    '/v2/container-charge',
    '/v2/container-charge',
  );
  let claveInterruptor = '';
  correrMatriz('interruptor de cobro', ver, [
    getInterruptor('apagado por omisión', 'adminA', 200, {
      verificar: (b) => expect(b).toMatchObject({ enabled: false }),
    }),
    getInterruptor('sin token', undefined, 401),
    getInterruptor('cliente', 'clienteA', 403),
    getInterruptor('chofer', 'chofer', 403),
    getInterruptor('super admin sin distribuidora', 'super', 400, {
      code: 'MISSING_DISTRIBUTOR',
    }),
    putInterruptor('lo enciende y relee', 'adminA', 200, {
      body: { enabled: true },
      verificar: async (_b, c) => {
        const res = await llamar(c, 'get', '/v2/container-charge', 'adminA');
        expect(res.body).toMatchObject({ enabled: true });
      },
    }),
    putInterruptor('no booleano', 'adminA', 400, { body: { enabled: 'si' } }),
    putInterruptor('requerido', 'adminA', 400, { body: {} }),
    putInterruptor('campo extra', 'adminA', 400, {
      body: { enabled: true, ajeno: true },
    }),
    putInterruptor('misma clave con otro cuerpo', 'adminA', 422, {
      antes: async (c) => {
        claveInterruptor = randomUUID();
        const res = await request(c.app.getHttpServer())
          .put('/v2/container-charge')
          .set({ ...c.actores.adminA, 'Idempotency-Key': claveInterruptor })
          .send({ enabled: true });
        expect(res.status).toBe(200);
      },
      cabeceras: () => ({ 'Idempotency-Key': claveInterruptor }),
      body: { enabled: false },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    putInterruptor('sin token', undefined, 401, { body: { enabled: true } }),
    putInterruptor('cliente', 'clienteA', 403, { body: { enabled: true } }),
    putInterruptor('chofer', 'chofer', 403, { body: { enabled: true } }),
  ]);

  const crearTipo = endpoint<Ctx>('post', '/gascylinder', '/gascylinder');
  const editarTipo = endpoint<Ctx>(
    'patch',
    '/gascylinder/{id}',
    (c) => `/gascylinder/${c.garrafaA}`,
  );
  const tipoValido = () => ({
    type: `Tipo F35 ${randomUUID().slice(0, 8)}`,
    weight: 10,
    price: 1000,
    stock: 5,
  });
  correrMatriz('precio del envase', ver, [
    crearTipo('crea con precio del envase', 'adminA', 201, {
      body: () => ({ ...tipoValido(), container_price: 300.25 }),
      verificar: (b) => expect(b).toMatchObject({ container_price: 300.25 }),
    }),
    crearTipo('precio nulo', 'adminA', 201, {
      body: () => ({ ...tipoValido(), container_price: null }),
      verificar: (b) => expect(b).toMatchObject({ container_price: null }),
    }),
    crearTipo('precio texto', 'adminA', 400, {
      body: () => ({ ...tipoValido(), container_price: 'trescientos' }),
    }),
    crearTipo('precio cero', 'adminA', 400, {
      body: () => ({ ...tipoValido(), container_price: 0 }),
    }),
    crearTipo('precio negativo', 'adminA', 400, {
      body: () => ({ ...tipoValido(), container_price: -1 }),
    }),
    crearTipo('precio con tres decimales', 'adminA', 400, {
      body: () => ({ ...tipoValido(), container_price: 1.111 }),
    }),
    crearTipo('precio sobre el tope', 'adminA', 400, {
      body: () => ({ ...tipoValido(), container_price: 10_000_001 }),
    }),
    crearTipo('sin token', undefined, 401, { body: tipoValido }),
    crearTipo('cliente', 'clienteA', 403, { body: tipoValido }),
    crearTipo('chofer', 'chofer', 403, { body: tipoValido }),
    editarTipo('actualiza el precio', 'adminA', 200, {
      body: { container_price: 400 },
      verificar: (b) => expect(b).toMatchObject({ container_price: 400 }),
    }),
    editarTipo('borra con nulo', 'adminA', 200, {
      body: { container_price: null },
      verificar: (b) => expect(b).toMatchObject({ container_price: null }),
    }),
    editarTipo('ausente no toca el precio', 'adminA', 200, {
      antes: async (c) => {
        await llamar(c, 'patch', `/gascylinder/${c.garrafaA}`, 'adminA', {
          container_price: 400,
        });
      },
      body: { description: 'Sin alterar precio de envase' },
      verificar: (b) => expect(b).toMatchObject({ container_price: 400 }),
    }),
    editarTipo('id mal formado', 'adminA', 400, {
      ruta: '/gascylinder/xx',
      body: { container_price: 1 },
      code: 'INVALID_ID',
    }),
    editarTipo('inexistente', 'adminA', 404, {
      ruta: (c) => `/gascylinder/${c.inexistente}`,
      body: { container_price: 1 },
    }),
    editarTipo('tenant ajeno', 'adminB', 404, { body: { container_price: 1 } }),
    editarTipo('sin token', undefined, 401, { body: { container_price: 1 } }),
    editarTipo('cliente', 'clienteA', 403, { body: { container_price: 1 } }),
    editarTipo('chofer', 'chofer', 403, { body: { container_price: 1 } }),
  ]);

  const cuentas = endpoint<Ctx>(
    'get',
    '/v2/customers/{id}/containers',
    (c) => `/v2/customers/${c.customerA}/containers`,
  );
  const movimientos = endpoint<Ctx>(
    'get',
    '/v2/customers/{id}/containers/movements',
    (c) => `/v2/customers/${c.customerA}/containers/movements?limit=1&offset=0`,
  );
  const ajustar = endpoint<Ctx>(
    'post',
    '/v2/customers/{id}/containers/adjustments',
    (c) => `/v2/customers/${c.customerA}/containers/adjustments`,
  );
  let claveAjuste = '';
  correrMatriz('cuentas de envases', ver, [
    cuentas('cliente propio', 'adminA', 200),
    cuentas('id mal formado', 'adminA', 400, {
      ruta: '/v2/customers/xx/containers',
      code: 'INVALID_ID',
    }),
    cuentas('inexistente', 'adminA', 404, {
      ruta: (c) => `/v2/customers/${c.inexistente}/containers`,
    }),
    cuentas('tenant ajeno', 'adminB', 404),
    cuentas('sin token', undefined, 401),
    cuentas('cliente', 'clienteA', 403),
    cuentas('chofer', 'chofer', 403),
    movimientos('paginado válido', 'adminA', 200),
    movimientos('límite cero', 'adminA', 400, {
      ruta: (c) => `/v2/customers/${c.customerA}/containers/movements?limit=0`,
    }),
    movimientos('límite sobre máximo', 'adminA', 400, {
      ruta: (c) =>
        `/v2/customers/${c.customerA}/containers/movements?limit=101`,
    }),
    movimientos('offset negativo', 'adminA', 400, {
      ruta: (c) =>
        `/v2/customers/${c.customerA}/containers/movements?offset=-1`,
    }),
    movimientos('sin token', undefined, 401),
    movimientos('cliente', 'clienteA', 403),
    movimientos('chofer', 'chofer', 403),
    ajustar('ajuste positivo', 'adminA', 201, {
      body: (c) => ajuste(c),
      verificar: (b) => expect(b).toMatchObject({ owned: 2 }),
    }),
    ajustar('gasCylinderId mal formado', 'adminA', 400, {
      body: (c) => ajuste(c, { gasCylinderId: 'xx' }),
    }),
    ajustar('cantidad cero', 'adminA', 400, {
      body: (c) => ajuste(c, { quantity: 0 }),
    }),
    ajustar('cantidad decimal', 'adminA', 400, {
      body: (c) => ajuste(c, { quantity: 1.5 }),
    }),
    ajustar('cantidad fuera de rango', 'adminA', 400, {
      body: (c) => ajuste(c, { quantity: 1001 }),
    }),
    ajustar('nota corta', 'adminA', 400, {
      body: (c) => ajuste(c, { note: 'corta' }),
    }),
    ajustar('nota larga', 'adminA', 400, {
      body: (c) => ajuste(c, { note: 'x'.repeat(501) }),
    }),
    ajustar('tipo ajeno', 'adminA', 404, {
      body: (c) => ajuste(c, { gasCylinderId: c.garrafaB }),
    }),
    ajustar('cliente ajeno', 'adminA', 404, {
      ruta: (c) => `/v2/customers/${c.customerB}/containers/adjustments`,
      body: (c) => ajuste(c),
    }),
    ajustar('saldo negativo', 'adminA', 409, {
      antes: async (c) => {
        await llamar(
          c,
          'post',
          `/v2/customers/${c.customerA}/containers/adjustments`,
          'adminA',
          ajuste(c),
        );
      },
      body: (c) => ajuste(c, { quantity: -999 }),
    }),
    ajustar('misma clave con otro cuerpo', 'adminA', 422, {
      antes: async (c) => {
        claveAjuste = randomUUID();
        const res = await request(c.app.getHttpServer())
          .post(`/v2/customers/${c.customerA}/containers/adjustments`)
          .set({ ...c.actores.adminA, 'Idempotency-Key': claveAjuste })
          .send(ajuste(c));
        expect(res.status).toBe(201);
      },
      cabeceras: () => ({ 'Idempotency-Key': claveAjuste }),
      body: (c) => ajuste(c, { quantity: 3 }),
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    ajustar('sin token', undefined, 401, { body: (c) => ajuste(c) }),
    ajustar('cliente', 'clienteA', 403, { body: (c) => ajuste(c) }),
    ajustar('chofer', 'chofer', 403, { body: (c) => ajuste(c) }),
  ]);

  const quote = endpoint<Ctx>('post', '/orders/quote', '/orders/quote');
  const create = endpoint<Ctx>('post', '/orders', '/orders');
  correrMatriz('pedidos con interruptor', ver, [
    quote('encendido cobra el envase', 'clienteA', 200, {
      antes: encenderConPrecio,
      body: (c) => cotizacion(c),
      verificar: (b) =>
        expect(b).toMatchObject({
          containerChargeAmount: 400,
          items: [{ containersCharged: 1, containerUnitPrice: 400 }],
        }),
    }),
    create('encendido guarda el cargo', 'clienteA', 201, {
      antes: encenderConPrecio,
      body: (c) => pedido(c),
      verificar: (b) =>
        expect(b).toMatchObject({
          containerChargeAmount: 400,
          order_items: [{ containersCharged: 1, containerUnitPrice: 400 }],
        }),
    }),
    quote('sin precio devuelve código estable', 'clienteA', 400, {
      body: (c) => cotizacion(c, c.gasSinPrecio),
      code: 'CONTAINER_PRICE_MISSING',
    }),
    quote('admin sin cliente', 'adminA', 400, {
      body: (c) => cotizacion(c),
      mensaje: 'Elegí el cliente para cotizar',
    }),
    quote('apagado cotiza sin cargo', 'clienteA', 200, {
      antes: (c) =>
        llamar(c, 'put', '/v2/container-charge', 'adminA', {
          enabled: false,
        }).then(() => undefined),
      body: (c) => cotizacion(c, c.gasSinPrecio),
      verificar: (b) =>
        expect(b).toMatchObject({
          containerChargeAmount: 0,
          items: [{ containersCharged: 0, containerUnitPrice: null }],
        }),
    }),
    create('apagado crea sin cargo', 'clienteA', 201, {
      body: (c) => pedido(c, c.gasSinPrecio),
      verificar: (b) =>
        expect(b).toMatchObject({
          containerChargeAmount: 0,
          order_items: [{ containersCharged: 0, containerUnitPrice: null }],
        }),
    }),
    quote('sin token', undefined, 401, { body: (c) => cotizacion(c) }),
    quote('chofer', 'chofer', 403, { body: (c) => cotizacion(c) }),
    create('sin token', undefined, 401, { body: (c) => pedido(c) }),
    create('cliente de otro tenant', 'clienteB', 403, {
      body: (c) => pedido(c),
    }),
  ]);
});
