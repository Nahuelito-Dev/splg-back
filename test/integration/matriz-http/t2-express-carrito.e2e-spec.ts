/**
 * Matriz HTTP T2 (2/3): compra express y carrito. Cada caso es una fila de la
 * tabla (ver `matriz.ts`); el carrito y los ítems que necesita cada caso los
 * arma su `antes`.
 */
import { DataSource } from 'typeorm';
import { ExpressSettingsService } from '../../../src/distributor/express-settings.service';
import { GasCylinder } from '../../../src/gascylinder/entities/gascylinder.entity';
import { UserAddress } from '../../../src/user-address/entities/user-address.entity';
import { TestEnv, createTestApp } from '../setup/test-env';
import {
  Caso,
  Persona,
  cabecerasDe_,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
  sembrarEscenario,
  sembrarPersona,
} from './matriz';
import {
  EscenarioT2,
  ZONA_CENTRO,
  ZONA_NORTE,
  sembrarBaseT2,
  ubicarChofer,
  usarClave,
} from './t2-base';

interface Ctx extends EscenarioT2 {
  /** Clientes de A que no comparten carrito ni dirección con clienteA. */
  clienteCarrito: Persona;
  clienteCarrito2: Persona;
  /** Sin dirección predeterminada. */
  clienteSinDireccion: Persona;
  /** Dirección predeterminada en la zona Norte, lejos de las motos. */
  clienteNorte: Persona;
  garrafaBaja: string;
}

describe('Matriz HTTP T2: express y carrito (e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    const base = await sembrarBaseT2(env.app, await sembrarEscenario(env.app));
    const ds = env.app.get(DataSource);
    const cliente = async (n: string) => {
      const p = await sembrarPersona(env.app, 'customer', n, base.distA.id);
      base.actores[n] = cabecerasDe_(p.email, 'customer-app', base.distA.slug);
      return p;
    };
    const clienteCarrito = await cliente('clienteCarrito');
    const clienteCarrito2 = await cliente('clienteCarrito2');
    const clienteSinDireccion = await cliente('clienteSinDireccion');
    const clienteNorte = await cliente('clienteNorte');
    await ds.getRepository(UserAddress).save({
      userId: clienteNorte.userId,
      street: 'Calle Norte 9',
      city: 'CABA',
      isDefault: true,
      location: {
        type: 'Point',
        coordinates: [ZONA_NORTE.lng, ZONA_NORTE.lat],
      },
    } as unknown as Partial<UserAddress>);
    const garrafaBaja = (
      (await ds.getRepository(GasCylinder).save({
        type: '5kg',
        price: 800,
        stock: 10,
        weight: 5,
        isActive: false,
        distributorId: base.distA.id,
      } as Partial<GasCylinder>)) as GasCylinder
    ).gasCylinderId;
    ctx = {
      ...base,
      clienteCarrito,
      clienteCarrito2,
      clienteSinDireccion,
      clienteNorte,
      garrafaBaja,
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    // Express: A lo ofrece las 24 horas y tiene una moto cerca del centro.
    await env.app.get(ExpressSettingsService).guardar(
      base.distA.id,
      {
        enabled: true,
        surchargeAmount: 500,
        maxRadiusKm: 5,
        serviceFrom: '00:00',
        serviceTo: '23:59',
      },
      base.adminA.userId,
    );
    await ubicarChofer(env.app, base.choferA2.userId, ZONA_CENTRO);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  const sinToken = { cabeceras: { 'X-Client-Source': 'customer-app' } };
  const sinDistribuidora = { cabeceras: { 'X-Distributor': null } };

  // ======================================================== carrito
  /** Deja un ítem de la garrafa en el carrito del actor y guarda su id. */
  const conItem =
    (clave: string, actor = 'clienteCarrito', cantidad = 2) =>
    async (c: Ctx) => {
      await llamar(c, 'delete', '/cart', actor);
      const r = await llamar(c, 'post', '/cart/items', actor, {
        gasCylinderId: actor === 'clienteB' ? c.garrafaB : c.garrafaA,
        quantity: cantidad,
      });
      c.p[clave] = (
        r.body as { items: Array<{ cartItemId: string }> }
      ).items[0].cartItemId;
    };

  const consultar = endpoint<Ctx>('get', '/cart', '/cart');
  const casosConsultar: Array<Caso<Ctx>> = [
    consultar('carrito vacío', 'clienteCarrito', 200, {
      antes: async (c) => {
        await llamar(c, 'delete', '/cart', 'clienteCarrito');
      },
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          distributorId: c.distA.id,
          items: [],
          totalUnits: 0,
          total: 0,
        }),
    }),
    consultar(
      'con un ítem: total sobre el precio vigente',
      'clienteCarrito',
      200,
      {
        antes: conItem('g1', 'clienteCarrito', 3),
        verificar: (cuerpo, c) =>
          expect(cuerpo).toMatchObject({
            totalUnits: 3,
            total: 3000,
            items: [
              {
                cartItemId: c.p.g1,
                gasCylinderId: c.garrafaA,
                quantity: 3,
                available: true,
              },
            ],
          }),
      },
    ),
    consultar('el carrito de otro cliente no se ve', 'clienteCarrito2', 200, {
      antes: async (c) => {
        await conItem('g2', 'clienteCarrito')(c);
        await llamar(c, 'delete', '/cart', 'clienteCarrito2');
      },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ items: [], totalUnits: 0 }),
    }),
    consultar(
      'el mismo cliente en la otra distribuidora tiene otro carrito',
      'clienteA',
      200,
      {
        antes: conItem('g3', 'clienteA', 1),
        cabeceras: (c) => ({ 'X-Distributor': c.distB.slug }),
        verificar: (cuerpo) => expect(cuerpo).toMatchObject({ items: [] }),
      },
    ),
    consultar('sin token', undefined, 401, sinToken),
    consultar('administrador', 'adminA', 403),
    consultar('super administrador', 'superEnA', 403),
    consultar('chofer', 'chofer', 403),
    consultar('sin X-Distributor', 'clienteCarrito', 400, sinDistribuidora),
  ];

  const agregar = endpoint<Ctx>('post', '/cart/items', '/cart/items');
  const itemDe = (cantidad: unknown) => (c: Ctx) => ({
    gasCylinderId: c.garrafaA,
    quantity: cantidad,
  });
  const casosAgregar: Array<Caso<Ctx>> = [
    agregar('ítem nuevo', 'clienteCarrito', 201, {
      antes: async (c) => {
        await llamar(c, 'delete', '/cart', 'clienteCarrito');
      },
      body: itemDe(2),
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          totalUnits: 2,
          total: 2000,
          items: [
            { gasCylinderId: c.garrafaA, quantity: 2, savedUnitPrice: 1000 },
          ],
        }),
    }),
    agregar('el mismo tipo suma la cantidad', 'clienteCarrito', 201, {
      antes: conItem('a2', 'clienteCarrito', 2),
      body: itemDe(3),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          totalUnits: 5,
          items: [{ quantity: 5 }],
        }),
    }),
    agregar('otro tipo queda aparte', 'clienteCarrito', 201, {
      antes: conItem('a3', 'clienteCarrito', 1),
      body: (c) => ({ gasCylinderId: c.garrafaA2, quantity: 1 }),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ totalUnits: 2, total: 2500 }),
    }),
    agregar('sin token', undefined, 401, { ...sinToken, body: itemDe(1) }),
    agregar('administrador', 'adminA', 403, { body: itemDe(1) }),
    agregar('chofer', 'chofer', 403, { body: itemDe(1) }),
    agregar('sin X-Distributor', 'clienteCarrito', 400, {
      ...sinDistribuidora,
      body: itemDe(1),
    }),
    agregar('cantidad cero', 'clienteCarrito', 400, { body: itemDe(0) }),
    agregar('cantidad negativa', 'clienteCarrito', 400, { body: itemDe(-1) }),
    agregar('cantidad con decimales', 'clienteCarrito', 400, {
      body: itemDe(1.5),
    }),
    agregar('cantidad que no es número', 'clienteCarrito', 400, {
      body: itemDe('dos'),
    }),
    agregar('cantidad mayor al máximo por ítem', 'clienteCarrito', 400, {
      body: itemDe(1000),
    }),
    agregar('sin cantidad', 'clienteCarrito', 400, {
      body: (c) => ({ gasCylinderId: c.garrafaA }),
    }),
    agregar('garrafa que no es un UUID', 'clienteCarrito', 400, {
      body: { gasCylinderId: 'xx', quantity: 1 },
    }),
    agregar('sin garrafa', 'clienteCarrito', 400, { body: { quantity: 1 } }),
    agregar('sumar pasa del máximo por ítem', 'clienteCarrito', 400, {
      antes: conItem('a4', 'clienteCarrito', 999),
      body: itemDe(1),
      mensaje: 'hasta 999 unidades',
    }),
    agregar('garrafa inexistente', 'clienteCarrito', 404, {
      body: (c) => ({ gasCylinderId: c.inexistente, quantity: 1 }),
      mensaje: 'Garrafa no encontrada',
    }),
    agregar('garrafa de otra distribuidora', 'clienteCarrito', 404, {
      body: (c) => ({ gasCylinderId: c.garrafaB, quantity: 1 }),
      mensaje: 'Garrafa no encontrada',
    }),
    agregar('garrafa dada de baja', 'clienteCarrito', 404, {
      body: (c) => ({ gasCylinderId: c.garrafaBaja, quantity: 1 }),
      mensaje: 'Garrafa no encontrada',
    }),
  ];

  const cambiar = endpoint<Ctx>(
    'patch',
    '/cart/items/{itemId}',
    (c) => `/cart/items/${c.p.m}`,
  );
  const casosCambiar: Array<Caso<Ctx>> = [
    cambiar('cambia la cantidad', 'clienteCarrito', 200, {
      antes: conItem('m', 'clienteCarrito', 2),
      body: { quantity: 7 },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          totalUnits: 7,
          total: 7000,
          items: [{ quantity: 7 }],
        }),
    }),
    cambiar('sin token', undefined, 401, {
      ...sinToken,
      ruta: (c) => `/cart/items/${c.inexistente}`,
      body: { quantity: 1 },
    }),
    cambiar('administrador', 'adminA', 403, {
      ruta: (c) => `/cart/items/${c.inexistente}`,
      body: { quantity: 1 },
    }),
    cambiar('chofer', 'chofer', 403, {
      ruta: (c) => `/cart/items/${c.inexistente}`,
      body: { quantity: 1 },
    }),
    cambiar('sin X-Distributor', 'clienteCarrito', 400, {
      ...sinDistribuidora,
      antes: conItem('m', 'clienteCarrito', 2),
      body: { quantity: 1 },
    }),
    cambiar('ítem mal formado', 'clienteCarrito', 400, {
      ruta: '/cart/items/xx',
      body: { quantity: 1 },
    }),
    cambiar('cantidad cero', 'clienteCarrito', 400, {
      antes: conItem('m', 'clienteCarrito', 2),
      body: { quantity: 0 },
    }),
    cambiar('cantidad con decimales', 'clienteCarrito', 400, {
      antes: conItem('m', 'clienteCarrito', 2),
      body: { quantity: 2.5 },
    }),
    cambiar('cantidad mayor al máximo', 'clienteCarrito', 400, {
      antes: conItem('m', 'clienteCarrito', 2),
      body: { quantity: 1000 },
    }),
    cambiar('sin cantidad', 'clienteCarrito', 400, {
      antes: conItem('m', 'clienteCarrito', 2),
      body: {},
    }),
    cambiar('ítem inexistente', 'clienteCarrito', 404, {
      ruta: (c) => `/cart/items/${c.inexistente}`,
      body: { quantity: 1 },
      mensaje: 'El ítem no está en tu carrito',
    }),
    cambiar('ítem del carrito de otro cliente', 'clienteCarrito2', 404, {
      antes: conItem('m', 'clienteCarrito', 2),
      body: { quantity: 9 },
      mensaje: 'El ítem no está en tu carrito',
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', '/cart', 'clienteCarrito');
        expect(r.body).toMatchObject({ items: [{ quantity: 2 }] });
      },
    }),
    cambiar('ítem de un carrito de otra distribuidora', 'clienteCarrito', 404, {
      antes: async (c) => {
        await llamar(c, 'delete', '/cart', 'clienteB');
        const r = await llamar(c, 'post', '/cart/items', 'clienteB', {
          gasCylinderId: c.garrafaB,
          quantity: 1,
        });
        c.p.m = (
          r.body as { items: Array<{ cartItemId: string }> }
        ).items[0].cartItemId;
      },
      body: { quantity: 9 },
    }),
  ];

  const quitar = endpoint<Ctx>(
    'delete',
    '/cart/items/{itemId}',
    (c) => `/cart/items/${c.p.q}`,
  );
  const casosQuitar: Array<Caso<Ctx>> = [
    quitar('quita el ítem', 'clienteCarrito', 200, {
      antes: conItem('q', 'clienteCarrito', 2),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ items: [], totalUnits: 0 }),
    }),
    quitar('sin token', undefined, 401, {
      ...sinToken,
      ruta: (c) => `/cart/items/${c.inexistente}`,
    }),
    quitar('administrador', 'adminA', 403, {
      ruta: (c) => `/cart/items/${c.inexistente}`,
    }),
    quitar('chofer', 'chofer', 403, {
      ruta: (c) => `/cart/items/${c.inexistente}`,
    }),
    quitar('sin X-Distributor', 'clienteCarrito', 400, {
      ...sinDistribuidora,
      ruta: (c) => `/cart/items/${c.inexistente}`,
    }),
    quitar('ítem mal formado', 'clienteCarrito', 400, {
      ruta: '/cart/items/xx',
    }),
    quitar('ítem inexistente', 'clienteCarrito', 404, {
      ruta: (c) => `/cart/items/${c.inexistente}`,
      mensaje: 'El ítem no está en tu carrito',
    }),
    quitar('ítem del carrito de otro cliente', 'clienteCarrito2', 404, {
      antes: conItem('q', 'clienteCarrito', 2),
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', '/cart', 'clienteCarrito');
        expect(r.body).toMatchObject({ items: [{ quantity: 2 }] });
      },
    }),
  ];

  const vaciar = endpoint<Ctx>('delete', '/cart', '/cart');
  const casosVaciar: Array<Caso<Ctx>> = [
    vaciar('vacía el carrito', 'clienteCarrito', 200, {
      antes: conItem('v', 'clienteCarrito', 2),
      verificar: async (cuerpo, c) => {
        expect(cuerpo).toMatchObject({ items: [], totalUnits: 0 });
        const r = await llamar(c, 'get', '/cart', 'clienteCarrito');
        expect(r.body).toMatchObject({ items: [] });
      },
    }),
    vaciar('sin carrito no hace nada', 'clienteCarrito2', 200, {
      verificar: (cuerpo) => expect(cuerpo).toMatchObject({ items: [] }),
    }),
    vaciar('no toca el carrito de otro cliente', 'clienteCarrito2', 200, {
      antes: conItem('v', 'clienteCarrito', 2),
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', '/cart', 'clienteCarrito');
        expect(r.body).toMatchObject({ items: [{ quantity: 2 }] });
      },
    }),
    vaciar('sin token', undefined, 401, sinToken),
    vaciar('administrador', 'adminA', 403),
    vaciar('chofer', 'chofer', 403),
    vaciar('sin X-Distributor', 'clienteCarrito', 400, sinDistribuidora),
  ];

  // ======================================================== express
  const opciones = endpoint<Ctx>(
    'get',
    '/orders/delivery-options',
    (c) => `/orders/delivery-options?addressId=${c.dirCentro}`,
  );
  const casosOpciones: Array<Caso<Ctx>> = [
    opciones(
      'cliente: standard siempre y express disponible',
      'clienteA',
      200,
      {
        verificar: (cuerpo, c) => {
          const r = cuerpo as {
            addressId: string;
            options: Array<{
              mode: string;
              available: boolean;
              surchargeAmount: number;
            }>;
          };
          expect(r.addressId).toBe(c.dirCentro);
          expect(r.options).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ mode: 'standard', available: true }),
              expect.objectContaining({
                mode: 'express',
                available: true,
                surchargeAmount: 500,
              }),
            ]),
          );
        },
      },
    ),
    opciones(
      'cliente: express no disponible en la zona sin motos',
      'clienteA',
      200,
      {
        ruta: (c) => `/orders/delivery-options?addressId=${c.dirNorte}`,
        verificar: (cuerpo) =>
          expect(
            (
              cuerpo as {
                options: Array<{ mode: string; reason: string | null }>;
              }
            ).options.find((o) => o.mode === 'express'),
          ).toMatchObject({
            available: false,
            reason: 'no_motorcycle_driver',
          }),
      },
    ),
    opciones('cliente: dirección fuera de cobertura', 'clienteA', 200, {
      ruta: (c) => `/orders/delivery-options?addressId=${c.dirFuera}`,
      verificar: (cuerpo) =>
        expect(
          (
            cuerpo as {
              options: Array<{ mode: string; reason: string | null }>;
            }
          ).options.find((o) => o.mode === 'express'),
        ).toMatchObject({ available: false, reason: 'out_of_coverage' }),
    }),
    opciones('administrador con el cliente', 'adminA', 200, {
      ruta: (c) =>
        `/orders/delivery-options?addressId=${c.dirCentro}&customerId=${c.clienteA.userId}`,
    }),
    opciones('super administrador viendo como A', 'superEnA', 200, {
      ruta: (c) =>
        `/orders/delivery-options?addressId=${c.dirCentro}&customerId=${c.clienteA.userId}`,
    }),
    opciones('sin token', undefined, 401, sinToken),
    opciones('chofer', 'chofer', 403),
    opciones('cliente consultando por otro cliente', 'clienteA', 403, {
      ruta: (c) =>
        `/orders/delivery-options?addressId=${c.dirB}&customerId=${c.clienteB.userId}`,
    }),
    opciones('administrador sin customerId', 'adminA', 400),
    opciones('sin addressId', 'clienteA', 400, {
      ruta: '/orders/delivery-options',
    }),
    opciones('addressId que no es un UUID', 'clienteA', 400, {
      ruta: '/orders/delivery-options?addressId=xx',
    }),
    opciones('customerId que no es un UUID', 'adminA', 400, {
      ruta: (c) =>
        `/orders/delivery-options?addressId=${c.dirCentro}&customerId=xx`,
    }),
    opciones('dirección inexistente', 'clienteA', 404, {
      ruta: (c) => `/orders/delivery-options?addressId=${c.inexistente}`,
      mensaje: 'Dirección no encontrada',
    }),
    opciones('dirección de otro cliente', 'clienteA', 404, {
      ruta: (c) => `/orders/delivery-options?addressId=${c.dirAjena}`,
      mensaje: 'Dirección no encontrada',
    }),
  ];

  const cuerpoExpress =
    (extra: object = {}) =>
    (c: Ctx) => ({
      paymentMethod: 'cash',
      gasCylinderId: c.garrafaA,
      ...extra,
    });
  const vista = endpoint<Ctx>(
    'post',
    '/orders/express/quote',
    '/orders/express/quote',
  );
  const casosVista: Array<Caso<Ctx>> = [
    vista('disponible: precio con el recargo express', 'clienteA', 200, {
      body: cuerpoExpress(),
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          available: true,
          fallback: null,
          address: { addressId: c.dirCentro },
          item: { gasCylinderId: c.garrafaA, quantity: 1 },
          quote: { expressSurcharge: 500 },
        }),
    }),
    vista('varias unidades', 'clienteA', 200, {
      body: cuerpoExpress({ quantity: 3 }),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ item: { quantity: 3 } }),
    }),
    vista('sin moto cerca: 200 con available false', 'clienteNorte', 200, {
      body: cuerpoExpress(),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          available: false,
          reason: 'no_motorcycle_driver',
          fallback: 'scheduled',
          quote: null,
        }),
    }),
    vista(
      'distribuidora sin express: 200 con available false',
      'clienteB',
      200,
      {
        body: (c) => ({ paymentMethod: 'cash', gasCylinderId: c.garrafaB }),
        verificar: (cuerpo) =>
          expect(cuerpo).toMatchObject({
            available: false,
            reason: 'disabled',
          }),
      },
    ),
    vista('sin token', undefined, 401, { ...sinToken, body: cuerpoExpress() }),
    vista('administrador', 'adminA', 403, { body: cuerpoExpress() }),
    vista('chofer', 'chofer', 403, { body: cuerpoExpress() }),
    vista('sin medio de pago', 'clienteA', 400, {
      body: (c) => ({ gasCylinderId: c.garrafaA }),
    }),
    vista('medio de pago inexistente', 'clienteA', 400, {
      body: cuerpoExpress({ paymentMethod: 'bitcoin' }),
    }),
    vista('garrafa que no es un UUID', 'clienteA', 400, {
      body: cuerpoExpress({ gasCylinderId: 'xx' }),
    }),
    vista('cantidad cero', 'clienteA', 400, {
      body: cuerpoExpress({ quantity: 0 }),
    }),
    vista('cantidad mayor a 10', 'clienteA', 400, {
      body: cuerpoExpress({ quantity: 11 }),
    }),
    vista('cantidad con decimales', 'clienteA', 400, {
      body: cuerpoExpress({ quantity: 1.5 }),
    }),
    vista('sin garrafa y sin compras previas', 'clienteNorte', 400, {
      body: { paymentMethod: 'cash' },
      mensaje: 'Todavía no tenés compras',
    }),
    vista('garrafa inexistente', 'clienteA', 404, {
      body: (c) => cuerpoExpress({ gasCylinderId: c.inexistente })(c),
    }),
    vista('garrafa de otra distribuidora', 'clienteA', 400, {
      body: (c) => cuerpoExpress({ gasCylinderId: c.garrafaB })(c),
    }),
    vista('sin dirección predeterminada', 'clienteSinDireccion', 404, {
      body: cuerpoExpress(),
      mensaje: 'No tenés una dirección predeterminada',
    }),
  ];

  const comprar = endpoint<Ctx>('post', '/orders/express', '/orders/express');
  const casosComprar: Array<Caso<Ctx>> = [
    comprar('crea el pedido express con el recargo', 'clienteA', 201, {
      body: cuerpoExpress(),
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          customer: { user_id: c.clienteA.userId },
          deliveryMode: 'express',
          expressSurchargeAmount: 500,
          total_amount: 1600,
        }),
    }),
    comprar('sin token', undefined, 401, {
      ...sinToken,
      body: cuerpoExpress(),
    }),
    comprar('administrador', 'adminA', 403, { body: cuerpoExpress() }),
    comprar('chofer', 'chofer', 403, { body: cuerpoExpress() }),
    comprar('sin medio de pago', 'clienteA', 400, {
      body: (c) => ({ gasCylinderId: c.garrafaA }),
    }),
    comprar('cantidad mayor a 10', 'clienteA', 400, {
      body: cuerpoExpress({ quantity: 11 }),
    }),
    comprar('garrafa que no es un UUID', 'clienteA', 400, {
      body: cuerpoExpress({ gasCylinderId: 'xx' }),
    }),
    comprar('sin garrafa y sin compras previas', 'clienteNorte', 400, {
      body: { paymentMethod: 'cash' },
      mensaje: 'Todavía no tenés compras',
    }),
    comprar('sin dirección predeterminada', 'clienteSinDireccion', 404, {
      body: cuerpoExpress(),
      mensaje: 'No tenés una dirección predeterminada',
    }),
    comprar('sin moto cerca', 'clienteNorte', 409, {
      body: cuerpoExpress(),
      code: 'EXPRESS_NOT_AVAILABLE',
    }),
    comprar('la distribuidora no ofrece express', 'clienteB', 409, {
      body: (c) => ({ paymentMethod: 'cash', gasCylinderId: c.garrafaB }),
      code: 'EXPRESS_NOT_AVAILABLE',
    }),
    comprar('la misma clave con otro cuerpo', 'clienteA', 422, {
      antes: async (c) => {
        c.p.clave = await usarClave(
          c,
          'post',
          '/orders/express',
          'clienteA',
          cuerpoExpress()(c),
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: cuerpoExpress({ quantity: 2 }),
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    comprar('garrafa inexistente', 'clienteA', 404, {
      body: (c) => cuerpoExpress({ gasCylinderId: c.inexistente })(c),
    }),
    comprar('garrafa de otra distribuidora', 'clienteA', 400, {
      body: (c) => cuerpoExpress({ gasCylinderId: c.garrafaB })(c),
    }),
  ];

  correrMatriz('GET /cart', ver, casosConsultar);
  correrMatriz('POST /cart/items', ver, casosAgregar);
  correrMatriz('PATCH /cart/items/{itemId}', ver, casosCambiar);
  correrMatriz('DELETE /cart/items/{itemId}', ver, casosQuitar);
  correrMatriz('DELETE /cart', ver, casosVaciar);
  correrMatriz('GET /orders/delivery-options', ver, casosOpciones);
  correrMatriz('POST /orders/express/quote', ver, casosVista);
  correrMatriz('POST /orders/express', ver, casosComprar);
});
