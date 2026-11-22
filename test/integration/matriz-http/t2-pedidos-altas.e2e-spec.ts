/**
 * Matriz HTTP T2 (2/4): pedidos, alta, cotización y cambios (editar, dirección,
 * quién recibe, cancelar, estado, asignar, rechazar, llegada, posición,
 * confirmar entrega y código nuevo). Cada caso es una fila (ver `matriz.ts`) y
 * arma su propio pedido en el `antes`: ninguno depende de otro.
 */
import { DataSource } from 'typeorm';
import { Delivery } from '../../../src/delivery/entities/delivery.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentType,
} from '../../../src/order/entities/order.entity';
import { GasCylinder } from '../../../src/gascylinder/entities/gascylinder.entity';
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
  OpcionesPedido,
  dejarEnCurso,
  conVehiculo,
  conMismaDistribuidora,
  sembrarBaseT2,
  sembrarPedido,
  usarClave,
} from './t2-base';
import { conBypassManager } from '../setup/bypass';
import { UserAddress } from '../../../src/user-address/entities/user-address.entity';
import { ZONA_CENTRO } from './t2-base';

interface Ctx extends EscenarioT2 {
  garrafaPoca: string;
  /** Con dirección y un carrito para el checkout. */
  clienteCarrito: Persona;
  clienteCarritoVacio: Persona;
  choferInhabilitado: Persona & { deliveryId: string };
  choferSinValidar: Persona & { deliveryId: string };
}

describe('Matriz HTTP T2: pedidos, altas y cambios (e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    const base = await sembrarBaseT2(env.app, await sembrarEscenario(env.app));
    const ds = env.app.get(DataSource);
    const garrafaPoca = (
      (await ds.getRepository(GasCylinder).save({
        type: '5kg',
        price: 800,
        stock: 2,
        weight: 5,
        isActive: true,
        distributorId: base.distA.id,
      } as Partial<GasCylinder>)) as GasCylinder
    ).gasCylinderId;
    const cliente = async (n: string) => {
      const p = await sembrarPersona(env.app, 'customer', n, base.distA.id);
      base.actores[n] = cabecerasDe_(p.email, 'customer-app', base.distA.slug);
      await ds.getRepository(UserAddress).save({
        userId: p.userId,
        street: `Calle ${n}`,
        city: 'CABA',
        isDefault: true,
        location: {
          type: 'Point',
          coordinates: [ZONA_CENTRO.lng, ZONA_CENTRO.lat],
        },
      } as unknown as Partial<UserAddress>);
      return p;
    };
    const clienteCarritoPersona = await cliente('clienteCarrito');
    const chofer = async (n: string, campos: Partial<Delivery>) => {
      const p = await sembrarPersona(env.app, 'delivery', n, base.distA.id);
      await ds.getRepository(Delivery).update({ userId: p.userId }, campos);
      const fila = await ds
        .getRepository(Delivery)
        .findOneByOrFail({ userId: p.userId });
      base.actores[n] = cabecerasDe_(p.email, 'driver-app');
      return { ...p, deliveryId: fila.deliveryId };
    };
    base.p.dirCarrito = (
      await ds
        .getRepository(UserAddress)
        .findOneByOrFail({ userId: clienteCarritoPersona.userId })
    ).addressId;
    const clienteVacioPersona = await cliente('clienteCarritoVacio');
    base.p.dirVacio = (
      await ds
        .getRepository(UserAddress)
        .findOneByOrFail({ userId: clienteVacioPersona.userId })
    ).addressId;
    // Un chofer para cada caso que acepta pedidos: nunca dos aceptados esperando.
    for (const n of ['chS1', 'chS2', 'chS3']) {
      const p = await sembrarPersona(env.app, 'delivery', n, base.distA.id);
      const fila = await ds
        .getRepository(Delivery)
        .findOneByOrFail({ userId: p.userId });
      await conVehiculo(ds, base.distA.id, p.userId, fila.deliveryId);
      base.actores[n] = cabecerasDe_(p.email, 'driver-app');
    }
    ctx = {
      ...base,
      garrafaPoca,
      clienteCarrito: clienteCarritoPersona,
      clienteCarritoVacio: clienteVacioPersona,
      choferInhabilitado: await chofer('choferInhabilitado', {
        isEnabled: false,
      }),
      choferSinValidar: await chofer('choferSinValidar', { validated: false }),
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
  }, 300000);

  afterAll(async () => {
    await env.cleanup();
  });

  const sinToken = { cabeceras: { 'X-Client-Source': 'panel-app' } };
  const sinTokenCliente = { cabeceras: { 'X-Client-Source': 'customer-app' } };
  const sinTokenChofer = { cabeceras: { 'X-Client-Source': 'driver-app' } };
  const E = OrderStatus;

  /** Siembra un pedido en el estado pedido y guarda su id en `c.p[clave]`. */
  const nuevo =
    (clave: string, o: OpcionesPedido = {}) =>
    async (c: Ctx): Promise<void> => {
      c.p[clave] = await sembrarPedido(c, o);
    };
  /** Lo mismo, y lo deja como pedido de Mercado Pago sin pagar. */
  const nuevoMercadoPago = (clave: string) => async (c: Ctx) => {
    await nuevo(clave)(c);
    await conBypassManager(
      c.app.get(DataSource),
      ['transiciones', 'saldos'],
      (m) =>
        m.update(
          Order,
          { orderId: c.p[clave] },
          {
            paymentMethod: PaymentMethod.MERCADOPAGO,
            paymentType: PaymentType.ONLINE,
          },
        ),
    );
  };
  const pedidoDe = (c: Ctx, clave: string) =>
    c.app
      .get(DataSource)
      .getRepository(Order)
      .findOneByOrFail({ orderId: c.p[clave] });
  const ruta = (swagger: string, clave: string) => (c: Ctx) =>
    swagger.replace('{id}', c.p[clave]);
  const idMalo = (swagger: string) => swagger.replace('{id}', 'xx');
  const idInexistente = (swagger: string) => (c: Ctx) =>
    swagger.replace('{id}', c.inexistente);

  // ============================================================ POST /orders
  const crear = endpoint<Ctx>('post', '/orders', '/orders');
  const alta =
    (extra: Record<string, unknown> = {}, actor: 'A' | 'B' = 'A') =>
    (c: Ctx) => ({
      customerId: actor === 'A' ? c.clienteA.userId : c.clienteB.userId,
      addressId: actor === 'A' ? c.dirCentro : c.dirB,
      paymentMethod: 'cash',
      items: [
        {
          gasCylinderId: actor === 'A' ? c.garrafaA : c.garrafaB,
          quantity: 1,
          unitPrice: 1,
        },
      ],
      ...extra,
    });
  const dia = (dias: number) =>
    new Date(Date.now() + dias * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const conCarrito = (n: number, gar: (c: Ctx) => string) => async (c: Ctx) => {
    await llamar(c, 'delete', '/cart', 'clienteCarrito');
    await llamar(c, 'post', '/cart/items', 'clienteCarrito', {
      gasCylinderId: gar(c),
      quantity: n,
    });
  };
  const casosCrear: Array<Caso<Ctx>> = [
    crear(
      'cliente en efectivo: el precio lo pone el servidor',
      'clienteA',
      201,
      {
        body: alta(),
        verificar: (cuerpo, c) =>
          expect(cuerpo).toMatchObject({
            status: 'pending',
            payment_method: 'cash',
            total_amount: 1100,
            customer: { user_id: c.clienteA.userId },
          }),
      },
    ),
    crear(
      'cliente por transferencia: la distribuidora ya no la acepta',
      'clienteA',
      400,
      {
        body: alta({ paymentMethod: 'transfer' }),
        code: 'PAYMENT_METHOD_NOT_ACCEPTED',
      },
    ),
    crear('administrador por transferencia: también 400', 'adminA', 400, {
      body: alta({ paymentMethod: 'transfer' }),
      code: 'PAYMENT_METHOD_NOT_ACCEPTED',
    }),
    crear('reserva con seña por transferencia: 400', 'clienteA', 400, {
      body: alta({
        paymentMethod: 'transfer',
        isReservation: true,
        depositAmount: 100,
        scheduledDate: '2099-01-01',
      }),
      code: 'PAYMENT_METHOD_NOT_ACCEPTED',
    }),
    crear('varias unidades', 'clienteA', 201, {
      body: (c) =>
        alta({
          items: [
            { gasCylinderId: c.garrafaA, quantity: 2, unitPrice: 1 },
            { gasCylinderId: c.garrafaA2, quantity: 1, unitPrice: 1 },
          ],
        })(c),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ total_amount: 3850 }),
    }),
    crear('con el total esperado correcto', 'clienteA', 201, {
      body: alta({ expectedTotal: 1100 }),
    }),
    crear('con quien recibe', 'clienteA', 201, {
      body: alta({
        receiver: {
          receiverName: 'María Gómez',
          receiverDocument: '30.123.456',
          receiverRelationship: 'vecina',
        },
      }),
    }),
    crear('reserva con seña', 'clienteA', 201, {
      body: alta({
        isReservation: true,
        depositAmount: 300,
        scheduledDate: dia(3),
      }),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ status: 'reserved' }),
    }),
    crear('checkout del carrito', 'clienteCarrito', 201, {
      antes: conCarrito(2, (c) => c.garrafaA),
      body: (c) => ({
        customerId: c.clienteCarrito.userId,
        addressId: c.p.dirCarrito,
        fromCart: true,
        paymentMethod: 'cash',
      }),
    }),
    crear('administrador carga el pedido a nombre del cliente', 'adminA', 201, {
      body: alta(),
    }),
    crear('super en modo soporte sobre A', 'soporteA', 403, {
      body: alta(),
      code: 'SUPPORT_READ_ONLY',
    }),
    crear('chofer carga el pedido a nombre del cliente', 'chofer', 201, {
      body: alta(),
    }),
    crear('sin token', undefined, 401, { ...sinTokenCliente, body: alta() }),
    crear('cliente a nombre de otro cliente', 'clienteA', 403, {
      body: alta({}, 'B'),
      mensaje: 'No autorizado a crear pedidos para otro cliente',
    }),
    crear(
      'cuenta corriente: la carga sólo un administrador (cliente)',
      'clienteA',
      403,
      {
        body: alta({ paymentMethod: 'account' }),
      },
    ),
    crear(
      'cuenta corriente: la carga sólo un administrador (chofer)',
      'chofer',
      403,
      {
        body: alta({ paymentMethod: 'account' }),
      },
    ),
    crear(
      'el carrito es del cliente: el administrador no lo usa',
      'adminA',
      403,
      {
        body: (c) => ({
          customerId: c.clienteA.userId,
          addressId: c.dirCentro,
          fromCart: true,
          paymentMethod: 'cash',
        }),
      },
    ),
    crear('cliente que no es un UUID', 'clienteA', 400, {
      body: alta({ customerId: 'xx' }),
    }),
    crear('sin cliente', 'clienteA', 400, {
      body: alta({ customerId: undefined }),
    }),
    crear('dirección que no es un UUID', 'clienteA', 400, {
      body: alta({ addressId: 'xx' }),
    }),
    crear('sin dirección', 'clienteA', 400, {
      body: alta({ addressId: undefined }),
    }),
    crear('sin renglones', 'clienteA', 400, { body: alta({ items: [] }) }),
    crear('sin items', 'clienteA', 400, { body: alta({ items: undefined }) }),
    crear('items que no es una lista', 'clienteA', 400, {
      body: alta({ items: 'dos' }),
    }),
    crear('garrafa repetida', 'clienteA', 400, {
      body: (c) =>
        alta({
          items: [
            { gasCylinderId: c.garrafaA, quantity: 1, unitPrice: 1 },
            { gasCylinderId: c.garrafaA, quantity: 2, unitPrice: 1 },
          ],
        })(c),
      mensaje: 'no puede repetir la misma garrafa',
    }),
    crear('garrafa que no es un UUID', 'clienteA', 400, {
      body: alta({
        items: [{ gasCylinderId: 'xx', quantity: 1, unitPrice: 1 }],
      }),
    }),
    crear('cantidad cero', 'clienteA', 400, {
      body: (c) =>
        alta({
          items: [{ gasCylinderId: c.garrafaA, quantity: 0, unitPrice: 1 }],
        })(c),
    }),
    crear('cantidad con decimales', 'clienteA', 400, {
      body: (c) =>
        alta({
          items: [{ gasCylinderId: c.garrafaA, quantity: 1.5, unitPrice: 1 }],
        })(c),
    }),
    crear('precio unitario que no es número', 'clienteA', 400, {
      body: (c) =>
        alta({
          items: [{ gasCylinderId: c.garrafaA, quantity: 1, unitPrice: 'mil' }],
        })(c),
    }),
    crear('sin medio de pago', 'clienteA', 400, {
      body: alta({ paymentMethod: undefined }),
    }),
    crear('medio de pago inexistente', 'clienteA', 400, {
      body: alta({ paymentMethod: 'bitcoin' }),
    }),
    crear('notas que no son texto', 'clienteA', 400, {
      body: alta({ notes: 5 }),
    }),
    crear('franja que no es un UUID', 'clienteA', 400, {
      body: alta({ timeSlotId: 'xx' }),
    }),
    crear('fecha con otro formato', 'clienteA', 400, {
      body: alta({ scheduledDate: 'mañana' }),
    }),
    crear('fecha pasada', 'clienteA', 400, {
      body: alta({ scheduledDate: '2020-01-01' }),
    }),
    crear('reserva sin fecha', 'clienteA', 400, {
      body: alta({ isReservation: true, depositAmount: 300 }),
    }),
    crear('reserva que no es un booleano', 'clienteA', 400, {
      body: alta({ isReservation: 'si' }),
    }),
    crear('seña negativa', 'clienteA', 400, {
      body: alta({
        isReservation: true,
        depositAmount: -1,
        scheduledDate: dia(3),
      }),
    }),
    crear('seña con tres decimales', 'clienteA', 400, {
      body: alta({
        isReservation: true,
        depositAmount: 1.234,
        scheduledDate: dia(3),
      }),
    }),
    crear('modalidad inexistente', 'clienteA', 400, {
      body: alta({ deliveryMode: 'volando' }),
    }),
    crear('total esperado negativo', 'clienteA', 400, {
      body: alta({ expectedTotal: -1 }),
    }),
    crear('total esperado enorme', 'clienteA', 400, {
      body: alta({ expectedTotal: 2_000_000_000 }),
    }),
    crear('carrito que no es un booleano', 'clienteA', 400, {
      body: alta({ fromCart: 'si' }),
    }),
    crear('quien recibe con documento inválido', 'clienteA', 400, {
      body: alta({
        receiver: {
          receiverName: 'María',
          receiverDocument: 'ab',
          receiverRelationship: 'vecina',
        },
      }),
    }),
    crear('campo desconocido', 'clienteA', 400, { body: alta({ foo: 1 }) }),
    crear('checkout con carrito vacío', 'clienteCarritoVacio', 400, {
      antes: async (c) => {
        await llamar(c, 'delete', '/cart', 'clienteCarritoVacio');
      },
      body: (c) => ({
        customerId: c.clienteCarritoVacio.userId,
        addressId: c.p.dirVacio,
        fromCart: true,
        paymentMethod: 'cash',
      }),
      mensaje: 'Tu carrito está vacío',
    }),
    crear('checkout con carrito y renglones a la vez', 'clienteCarrito', 400, {
      antes: conCarrito(1, (c) => c.garrafaA),
      body: (c) => ({
        customerId: c.clienteCarrito.userId,
        addressId: c.p.dirCarrito,
        fromCart: true,
        paymentMethod: 'cash',
        items: [{ gasCylinderId: c.garrafaA, quantity: 1, unitPrice: 1 }],
      }),
    }),
    crear('dirección fuera de cobertura', 'clienteA', 400, {
      body: (c) => alta({ addressId: c.dirFuera })(c),
      mensaje: 'fuera de la zona de cobertura',
    }),
    crear('más unidades que el stock', 'clienteA', 400, {
      body: (c) =>
        alta({
          items: [{ gasCylinderId: c.garrafaPoca, quantity: 3, unitPrice: 1 }],
        })(c),
      mensaje: 'Stock insuficiente',
    }),
    crear('garrafa de otra distribuidora', 'clienteA', 400, {
      body: (c) =>
        alta({
          items: [{ gasCylinderId: c.garrafaB, quantity: 1, unitPrice: 1 }],
        })(c),
      mensaje: 'no pertenece a la distribuidora',
    }),
    crear('garrafa inexistente', 'clienteA', 404, {
      body: (c) =>
        alta({
          items: [{ gasCylinderId: c.inexistente, quantity: 1, unitPrice: 1 }],
        })(c),
    }),
    crear('cliente inexistente', 'adminA', 404, {
      body: (c) => alta({ customerId: c.inexistente })(c),
      mensaje: 'Cliente no encontrado',
    }),
    crear('dirección inexistente', 'clienteA', 404, {
      body: (c) => alta({ addressId: c.inexistente })(c),
      mensaje: 'Dirección no encontrada',
    }),
    crear('dirección de otra persona', 'clienteA', 404, {
      body: (c) => alta({ addressId: c.dirAjena })(c),
      mensaje: 'Dirección no encontrada',
    }),
    crear(
      'administrador de otra distribuidora carga un pedido a un cliente que todavía no le compró',
      'adminB',
      201,
      {
        body: (c) =>
          alta({
            items: [{ gasCylinderId: c.garrafaB, quantity: 1, unitPrice: 1 }],
          })(c),
      },
    ),
    crear('el total esperado ya no es el de hoy', 'clienteA', 409, {
      body: alta({ expectedTotal: 999 }),
      code: 'PRICE_CHANGED',
      verificar: (cuerpo) => expect(cuerpo).toMatchObject({ total: 1100 }),
    }),
    crear('la misma clave con otro cuerpo', 'clienteA', 422, {
      antes: async (c) => {
        c.p.clave = await usarClave(
          c,
          'post',
          '/orders',
          'clienteA',
          alta()(c),
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: alta({ notes: 'otra cosa' }),
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    crear('la misma clave con el pedido todavía en curso', 'clienteA', 409, {
      antes: async (c) => {
        c.p.clave = await usarClave(
          c,
          'post',
          '/orders',
          'clienteA',
          alta()(c),
        );
        await dejarEnCurso(env, c.p.clave);
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: alta(),
      code: 'IDEMPOTENCY_IN_PROGRESS',
      mensajeExacto:
        'Hay otra solicitud en curso con la misma clave de idempotencia: reintentá en unos segundos.',
    }),
    crear('Idempotency-Key que no es un UUID', 'clienteA', 400, {
      cabeceras: () => ({ 'Idempotency-Key': 'no-es-uuid' }),
      body: alta(),
      code: 'IDEMPOTENCY_KEY_INVALID',
    }),
  ];

  // ================================================== POST /orders/quote
  const cotizar = endpoint<Ctx>('post', '/orders/quote', '/orders/quote');
  const cotiza =
    (extra: Record<string, unknown> = {}) =>
    (c: Ctx) => ({
      paymentMethod: 'cash',
      items: [{ gasCylinderId: c.garrafaA, quantity: 2, unitPrice: 1 }],
      ...extra,
    });
  const casosCotizar: Array<Caso<Ctx>> = [
    cotizar('cliente sin dirección', 'clienteA', 200, {
      body: cotiza(),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          subtotal: 2000,
          zoneSurcharge: 0,
          paymentSurcharge: 0,
          total: 2000,
          balance: 2000,
          deposit: 0,
        }),
    }),
    cotizar('con dirección: suma el recargo de la zona', 'clienteA', 200, {
      body: (c) => cotiza({ addressId: c.dirNorte })(c),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          subtotal: 2000,
          zoneSurcharge: 500,
          total: 2500,
          zone: { name: 'Norte' },
        }),
    }),
    cotizar('transferencia: ya no se acepta', 'clienteA', 400, {
      body: (c) =>
        cotiza({ addressId: c.dirCentro, paymentMethod: 'transfer' })(c),
      code: 'PAYMENT_METHOD_NOT_ACCEPTED',
    }),
    cotizar('Mercado Pago: suma el recargo del medio', 'clienteA', 200, {
      body: (c) =>
        cotiza({ addressId: c.dirCentro, paymentMethod: 'mercadopago' })(c),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          zoneSurcharge: 200,
          paymentSurchargePercentage: 10,
          total: 2420,
        }),
    }),
    cotizar('reserva con seña', 'clienteA', 200, {
      body: cotiza({
        isReservation: true,
        depositAmount: 500,
        scheduledDate: dia(3),
      }),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ deposit: 500, balance: 1500 }),
    }),
    cotizar('el total es el del pedido que se crea', 'clienteA', 200, {
      body: (c) => cotiza({ addressId: c.dirCentro })(c),
      verificar: async (cuerpo, c) => {
        const r = await llamar(c, 'post', '/orders', 'clienteA', {
          ...cotiza({ addressId: c.dirCentro })(c),
          customerId: c.clienteA.userId,
        });
        expect(r.body).toMatchObject({
          total_amount: (cuerpo as { total: number }).total,
        });
      },
    }),
    cotizar('administrador con el cliente', 'adminA', 200, {
      body: (c) =>
        cotiza({ addressId: c.dirCentro, customerId: c.clienteA.userId })(c),
    }),
    // Cotizar sólo calcula (`@SoloLectura`): en modo soporte anda.
    cotizar('super en modo soporte sobre A', 'soporteA', 200, {
      body: (c) =>
        cotiza({ addressId: c.dirCentro, customerId: c.clienteA.userId })(c),
    }),
    cotizar('cotiza la edición de un pedido propio', 'clienteA', 200, {
      antes: nuevo('q'),
      body: (c) => ({
        orderId: c.p.q,
        paymentMethod: 'cash',
        items: [{ gasCylinderId: c.garrafaA, quantity: 3, unitPrice: 1 }],
      }),
    }),
    cotizar('sin token', undefined, 401, {
      ...sinTokenCliente,
      body: cotiza(),
    }),
    cotizar('chofer', 'chofer', 403, { body: cotiza() }),
    cotizar('cliente cotizando para otro', 'clienteA', 403, {
      body: (c) => cotiza({ customerId: c.clienteB.userId })(c),
    }),
    cotizar(
      'el carrito es del cliente: el administrador no lo usa',
      'adminA',
      403,
      {
        body: (c) => ({
          customerId: c.clienteA.userId,
          fromCart: true,
          paymentMethod: 'cash',
        }),
      },
    ),
    cotizar('sin medio de pago', 'clienteA', 400, {
      body: cotiza({ paymentMethod: undefined }),
    }),
    cotizar('medio de pago inexistente', 'clienteA', 400, {
      body: cotiza({ paymentMethod: 'bitcoin' }),
    }),
    cotizar('sin renglones', 'clienteA', 400, { body: cotiza({ items: [] }) }),
    cotizar('cantidad cero', 'clienteA', 400, {
      body: (c) =>
        cotiza({
          items: [{ gasCylinderId: c.garrafaA, quantity: 0, unitPrice: 1 }],
        })(c),
    }),
    cotizar('dirección que no es un UUID', 'clienteA', 400, {
      body: cotiza({ addressId: 'xx' }),
    }),
    cotizar('orden que no es un UUID', 'clienteA', 400, {
      body: cotiza({ orderId: 'xx' }),
    }),
    cotizar('campo desconocido', 'clienteA', 400, { body: cotiza({ foo: 1 }) }),
    cotizar('administrador con dirección y sin cliente', 'adminA', 400, {
      body: (c) => cotiza({ addressId: c.dirCentro })(c),
    }),
    cotizar('dirección fuera de cobertura', 'clienteA', 400, {
      body: (c) => cotiza({ addressId: c.dirFuera })(c),
      mensaje: 'fuera de la zona de cobertura',
    }),
    cotizar('más unidades que el stock', 'clienteA', 400, {
      body: (c) =>
        cotiza({
          items: [{ gasCylinderId: c.garrafaPoca, quantity: 3, unitPrice: 1 }],
        })(c),
    }),
    cotizar('garrafa de otra distribuidora', 'clienteA', 400, {
      body: (c) =>
        cotiza({
          items: [{ gasCylinderId: c.garrafaB, quantity: 1, unitPrice: 1 }],
        })(c),
    }),
    cotizar('dirección de otra persona', 'clienteA', 404, {
      body: (c) => cotiza({ addressId: c.dirAjena })(c),
      mensaje: 'Dirección no encontrada',
    }),
    cotizar('edición de un pedido de otro cliente', 'clienteB', 404, {
      antes: nuevo('q'),
      body: (c) => cotiza({ orderId: c.p.q })(c),
    }),
    cotizar('edición de un pedido inexistente', 'clienteA', 404, {
      body: (c) => cotiza({ orderId: c.inexistente })(c),
    }),
    cotizar('edición de un pedido que ya tiene chofer', 'clienteA', 409, {
      antes: nuevo('q', { estado: E.ACCEPTED }),
      body: (c) => cotiza({ orderId: c.p.q })(c),
    }),
  ];

  // ===================================================== PATCH /orders/{id}
  const SW_EDIT = '/orders/{id}';
  const editar = endpoint<Ctx>('patch', SW_EDIT, ruta(SW_EDIT, 'e'));
  const casosEditar: Array<Caso<Ctx>> = [
    editar('cliente dueño cambia las notas', 'clienteA', 200, {
      antes: nuevo('e'),
      body: { notes: 'Dejar en portería' },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ customer_notes: 'Dejar en portería' }),
    }),
    editar(
      'cliente dueño reemplaza los renglones: recalcula el total',
      'clienteA',
      200,
      {
        antes: nuevo('e'),
        body: (c) => ({
          items: [{ gasCylinderId: c.garrafaA, quantity: 2 }],
        }),
        verificar: (cuerpo) =>
          expect(cuerpo).toMatchObject({ total_amount: 2200 }),
      },
    ),
    editar(
      'cliente dueño cambia de dirección: recalcula el recargo',
      'clienteA',
      200,
      {
        antes: nuevo('e'),
        body: (c) => ({ addressId: c.dirNorte }),
        verificar: (cuerpo) =>
          expect(cuerpo).toMatchObject({ total_amount: 1250 }),
      },
    ),
    editar('cliente dueño pasa a transferencia: 400', 'clienteA', 400, {
      antes: nuevo('e'),
      body: { paymentMethod: 'transfer' },
      code: 'PAYMENT_METHOD_NOT_ACCEPTED',
    }),
    editar(
      'cliente dueño de un pedido viejo por transferencia pasa a efectivo',
      'clienteA',
      200,
      {
        antes: nuevo('e', { metodo: PaymentMethod.TRANSFER }),
        body: { paymentMethod: 'cash' },
      },
    ),
    editar('administrador', 'adminA', 200, {
      antes: nuevo('e'),
      body: { notes: 'Llamar antes' },
    }),
    editar('super en modo soporte sobre A', 'soporteA', 403, {
      antes: nuevo('e'),
      body: { notes: 'Llamar antes' },
      code: 'SUPPORT_READ_ONLY',
    }),
    editar('sin token', undefined, 401, {
      ...sinTokenCliente,
      ruta: idInexistente(SW_EDIT),
      body: { notes: 'x' },
    }),
    editar('chofer', 'chofer', 403, {
      antes: nuevo('e'),
      body: { notes: 'x' },
    }),
    editar('id mal formado', 'clienteA', 400, {
      ruta: idMalo(SW_EDIT),
      body: { notes: 'x' },
    }),
    editar('dirección que no es un UUID', 'clienteA', 400, {
      antes: nuevo('e'),
      body: { addressId: 'xx' },
    }),
    editar('franja que no es un UUID', 'clienteA', 400, {
      antes: nuevo('e'),
      body: { timeSlotId: 'xx' },
    }),
    editar('fecha con otro formato', 'clienteA', 400, {
      antes: nuevo('e'),
      body: { scheduledDate: 'mañana' },
    }),
    editar('fecha pasada', 'clienteA', 400, {
      antes: nuevo('e'),
      body: { scheduledDate: '2020-01-01' },
    }),
    editar('medio de pago inexistente', 'clienteA', 400, {
      antes: nuevo('e'),
      body: { paymentMethod: 'bitcoin' },
    }),
    editar('notas que no son texto', 'clienteA', 400, {
      antes: nuevo('e'),
      body: { notes: 5 },
    }),
    editar('renglones vacíos', 'clienteA', 400, {
      antes: nuevo('e'),
      body: { items: [] },
    }),
    editar('garrafa repetida', 'clienteA', 400, {
      antes: nuevo('e'),
      body: (c) => ({
        items: [
          { gasCylinderId: c.garrafaA, quantity: 1 },
          { gasCylinderId: c.garrafaA, quantity: 1 },
        ],
      }),
    }),
    editar('cantidad cero', 'clienteA', 400, {
      antes: nuevo('e'),
      body: (c) => ({ items: [{ gasCylinderId: c.garrafaA, quantity: 0 }] }),
    }),
    editar('campo desconocido', 'clienteA', 400, {
      antes: nuevo('e'),
      body: { foo: 1 },
    }),
    editar('dirección fuera de cobertura', 'clienteA', 400, {
      antes: nuevo('e'),
      body: (c) => ({ addressId: c.dirFuera }),
    }),
    editar('más unidades que el stock', 'clienteA', 400, {
      antes: nuevo('e'),
      body: (c) => ({ items: [{ gasCylinderId: c.garrafaPoca, quantity: 3 }] }),
    }),
    editar('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      antes: nuevo('e'),
      body: { notes: 'x' },
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    editar('inexistente', 'adminA', 404, {
      ruta: idInexistente(SW_EDIT),
      body: { notes: 'x' },
    }),
    editar('pedido de otro cliente', 'clienteB', 404, {
      antes: nuevo('e'),
      body: { notes: 'x' },
    }),
    editar('administrador de otra distribuidora', 'adminB', 404, {
      antes: nuevo('e'),
      body: { notes: 'x' },
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.e}`, 'adminA');
        expect(r.body).toMatchObject({ customer_notes: null });
      },
    }),
    editar('super en modo soporte sobre B', 'soporteB', 403, {
      antes: nuevo('e'),
      body: { notes: 'x' },
      code: 'SUPPORT_READ_ONLY',
    }),
    editar('pedido que ya tiene chofer', 'clienteA', 409, {
      antes: nuevo('e', { estado: E.ACCEPTED }),
      body: { notes: 'x' },
      mensaje: 'El pedido ya fue tomado por un repartidor',
    }),
    editar('pedido que ya tiene chofer (administrador)', 'adminA', 409, {
      antes: nuevo('e', { estado: E.ACCEPTED }),
      body: { notes: 'x' },
    }),
    editar('pedido cancelado', 'clienteA', 409, {
      antes: nuevo('e', { estado: E.CANCELLED }),
      body: { notes: 'x' },
    }),
    editar('pedido de transferencia', 'clienteA', 200, {
      antes: nuevo('e', { metodo: PaymentMethod.TRANSFER }),
      body: { notes: 'Dejar en portería' },
    }),
    editar('pedido de Mercado Pago', 'clienteA', 409, {
      antes: nuevoMercadoPago('e'),
      body: { notes: 'x' },
    }),
    editar('pasar el pedido a Mercado Pago', 'clienteA', 400, {
      antes: nuevo('e'),
      body: { paymentMethod: 'mercadopago' },
    }),
    editar('la misma clave con otro cuerpo', 'clienteA', 422, {
      antes: async (c) => {
        await nuevo('e')(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          `/orders/${c.p.e}`,
          'clienteA',
          {
            notes: 'uno',
          },
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: { notes: 'otro' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  // ============================================ PATCH /orders/{id}/address
  const SW_DIR = '/orders/{id}/address';
  const direccion = endpoint<Ctx>('patch', SW_DIR, ruta(SW_DIR, 'd'));
  const casosDireccion: Array<Caso<Ctx>> = [
    direccion('pendiente en efectivo: recalcula el total', 'clienteA', 200, {
      antes: nuevo('d'),
      body: (c) => ({ addressId: c.dirNorte, reason: 'Me mudé' }),
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          total_amount: 1250,
          delivery_address: { address_id: c.dirNorte },
        }),
    }),
    direccion('aceptado por un chofer', 'clienteA', 200, {
      antes: nuevo('d', { estado: E.ACCEPTED }),
      body: (c) => ({ addressId: c.dirNorte }),
    }),
    direccion('sin token', undefined, 401, {
      ...sinTokenCliente,
      ruta: idInexistente(SW_DIR),
      body: { addressId: '00000000-0000-4000-8000-000000000000' },
    }),
    direccion('administrador', 'adminA', 403, {
      antes: nuevo('d'),
      body: (c) => ({ addressId: c.dirNorte }),
    }),
    direccion('chofer', 'chofer', 403, {
      antes: nuevo('d'),
      body: (c) => ({ addressId: c.dirNorte }),
    }),
    direccion('id mal formado', 'clienteA', 400, {
      ruta: idMalo(SW_DIR),
      body: (c) => ({ addressId: c.dirNorte }),
    }),
    direccion('dirección que no es un UUID', 'clienteA', 400, {
      antes: nuevo('d'),
      body: { addressId: 'xx' },
    }),
    direccion('sin dirección', 'clienteA', 400, {
      antes: nuevo('d'),
      body: {},
    }),
    direccion('motivo en blanco', 'clienteA', 400, {
      antes: nuevo('d'),
      body: (c) => ({ addressId: c.dirNorte, reason: '   ' }),
    }),
    direccion('motivo de más de 500 caracteres', 'clienteA', 400, {
      antes: nuevo('d'),
      body: (c) => ({ addressId: c.dirNorte, reason: 'a'.repeat(501) }),
    }),
    direccion('la misma dirección', 'clienteA', 400, {
      antes: nuevo('d'),
      body: (c) => ({ addressId: c.dirCentro }),
    }),
    direccion('fuera de cobertura', 'clienteA', 400, {
      antes: nuevo('d'),
      body: (c) => ({ addressId: c.dirFuera }),
      mensaje: 'fuera de la zona de cobertura',
    }),
    direccion('inexistente', 'clienteA', 404, {
      ruta: idInexistente(SW_DIR),
      body: (c) => ({ addressId: c.dirNorte }),
    }),
    direccion('pedido de otro cliente', 'clienteB', 404, {
      antes: nuevo('d'),
      body: (c) => ({ addressId: c.dirB }),
    }),
    direccion('dirección de otra persona', 'clienteA', 404, {
      antes: nuevo('d'),
      body: (c) => ({ addressId: c.dirAjena }),
    }),
    direccion('pago en línea con otro recargo', 'clienteA', 409, {
      antes: nuevo('d', { metodo: PaymentMethod.TRANSFER }),
      body: (c) => ({ addressId: c.dirNorte }),
    }),
    direccion('pedido en camino', 'clienteA', 409, {
      antes: nuevo('d', { estado: E.ON_THE_WAY }),
      body: (c) => ({ addressId: c.dirNorte }),
    }),
    direccion('pedido entregado', 'clienteA', 409, {
      antes: nuevo('d', { estado: E.DELIVERED }),
      body: (c) => ({ addressId: c.dirNorte }),
    }),
    direccion('pedido cancelado', 'clienteA', 409, {
      antes: nuevo('d', { estado: E.CANCELLED }),
      body: (c) => ({ addressId: c.dirNorte }),
    }),
    direccion('la misma clave con otro cuerpo', 'clienteA', 422, {
      antes: async (c) => {
        await nuevo('d')(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          `/orders/${c.p.d}/address`,
          'clienteA',
          { addressId: c.dirNorte },
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: (c) => ({ addressId: c.dirCentro, reason: 'otro' }),
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  // ============================================ PATCH /orders/{id}/receiver
  const SW_REC = '/orders/{id}/receiver';
  const recibe = endpoint<Ctx>('patch', SW_REC, ruta(SW_REC, 'r'));
  const quien = {
    receiverName: 'María Gómez',
    receiverDocument: '30.123.456',
    receiverRelationship: 'vecina',
  };
  const casosRecibe: Array<Caso<Ctx>> = [
    recibe('pendiente', 'clienteA', 200, {
      antes: nuevo('r'),
      body: quien,
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          receiver: {
            name: 'María Gómez',
            document: '30123456',
            relationship: 'vecina',
          },
        }),
    }),
    recibe('en camino', 'clienteA', 200, {
      antes: nuevo('r', { estado: E.ON_THE_WAY }),
      body: quien,
    }),
    recibe('sin token', undefined, 401, {
      ...sinTokenCliente,
      ruta: idInexistente(SW_REC),
      body: quien,
    }),
    recibe('administrador', 'adminA', 403, { antes: nuevo('r'), body: quien }),
    recibe('chofer', 'chofer', 403, { antes: nuevo('r'), body: quien }),
    recibe('id mal formado', 'clienteA', 400, {
      ruta: idMalo(SW_REC),
      body: quien,
    }),
    recibe('sin nombre', 'clienteA', 400, {
      antes: nuevo('r'),
      body: { ...quien, receiverName: undefined },
    }),
    recibe('nombre en blanco', 'clienteA', 400, {
      antes: nuevo('r'),
      body: { ...quien, receiverName: '  ' },
    }),
    recibe('nombre de más de 120 caracteres', 'clienteA', 400, {
      antes: nuevo('r'),
      body: { ...quien, receiverName: 'a'.repeat(121) },
    }),
    recibe('sin documento', 'clienteA', 400, {
      antes: nuevo('r'),
      body: { ...quien, receiverDocument: undefined },
    }),
    recibe('documento con formato inválido', 'clienteA', 400, {
      antes: nuevo('r'),
      body: { ...quien, receiverDocument: 'ab' },
    }),
    recibe('documento sin dígitos', 'clienteA', 400, {
      antes: nuevo('r'),
      body: { ...quien, receiverDocument: 'abcdefgh' },
    }),
    recibe('sin relación', 'clienteA', 400, {
      antes: nuevo('r'),
      body: { ...quien, receiverRelationship: undefined },
    }),
    recibe('relación de más de 40 caracteres', 'clienteA', 400, {
      antes: nuevo('r'),
      body: { ...quien, receiverRelationship: 'a'.repeat(41) },
    }),
    recibe('campo desconocido', 'clienteA', 400, {
      antes: nuevo('r'),
      body: { ...quien, foo: 1 },
    }),
    recibe('inexistente', 'clienteA', 404, {
      ruta: idInexistente(SW_REC),
      body: quien,
    }),
    recibe('pedido de otro cliente', 'clienteB', 404, {
      antes: nuevo('r'),
      body: quien,
    }),
    recibe('pedido entregado', 'clienteA', 409, {
      antes: nuevo('r', { estado: E.DELIVERED }),
      body: quien,
    }),
    recibe('pedido cancelado', 'clienteA', 409, {
      antes: nuevo('r', { estado: E.CANCELLED }),
      body: quien,
    }),
    recibe('la misma clave con otro cuerpo', 'clienteA', 422, {
      antes: async (c) => {
        await nuevo('r')(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          `/orders/${c.p.r}/receiver`,
          'clienteA',
          quien,
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: { ...quien, receiverName: 'Otra Persona' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  // ============================================ PATCH /orders/{id}/cancel
  const SW_CAN = '/orders/{id}/cancel';
  const cancelar = endpoint<Ctx>('patch', SW_CAN, ruta(SW_CAN, 'k'));
  const motivo = { body: { reason: 'Ya no lo necesito' } };
  const casosCancelar: Array<Caso<Ctx>> = [
    cancelar('cliente dueño', 'clienteA', 200, {
      antes: nuevo('k'),
      ...motivo,
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          status: 'cancelled',
          cancellation_reason: 'Ya no lo necesito',
          cancelledBy: 'customer',
        }),
    }),
    cancelar('administrador', 'adminA', 200, {
      antes: nuevo('k'),
      ...motivo,
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          status: 'cancelled',
          cancelledBy: 'admin',
        }),
    }),
    cancelar('super en modo soporte sobre A', 'soporteA', 403, {
      antes: nuevo('k'),
      ...motivo,
      code: 'SUPPORT_READ_ONLY',
    }),
    cancelar('devuelve el stock', 'adminA', 200, {
      antes: nuevo('k', { cantidad: 2 }),
      ...motivo,
      verificar: async (_cuerpo, c) => {
        const antes = await c.app
          .get(DataSource)
          .getRepository(GasCylinder)
          .findOneByOrFail({ gasCylinderId: c.garrafaA });
        const r = await sembrarPedido(c, { cantidad: 3 });
        const durante = await c.app
          .get(DataSource)
          .getRepository(GasCylinder)
          .findOneByOrFail({ gasCylinderId: c.garrafaA });
        expect(durante.stock).toBe(antes.stock - 3);
        await llamar(c, 'patch', `/orders/${r}/cancel`, 'adminA', {
          reason: 'Devolver el stock',
        });
        const despues = await c.app
          .get(DataSource)
          .getRepository(GasCylinder)
          .findOneByOrFail({ gasCylinderId: c.garrafaA });
        expect(despues.stock).toBe(antes.stock);
      },
    }),
    cancelar(
      'el chofer lo libera: vuelve a pendiente, sin motivo',
      'chofer',
      200,
      {
        antes: nuevo('k', { estado: E.ACCEPTED }),
        body: {},
        verificar: (cuerpo) =>
          expect(cuerpo).toMatchObject({
            status: 'pending',
            cancelledBy: null,
          }),
      },
    ),
    cancelar('sin token', undefined, 401, {
      ...sinToken,
      ruta: idInexistente(SW_CAN),
      ...motivo,
    }),
    cancelar('chofer que no es el del pedido', 'choferA2', 403, {
      antes: nuevo('k', { estado: E.ACCEPTED }),
      body: {},
    }),
    cancelar('id mal formado', 'adminA', 400, {
      ruta: idMalo(SW_CAN),
      ...motivo,
    }),
    cancelar('cliente sin motivo', 'clienteA', 400, {
      antes: nuevo('k'),
      body: {},
    }),
    cancelar('administrador sin motivo', 'adminA', 400, {
      antes: nuevo('k'),
      body: {},
    }),
    cancelar('motivo en blanco', 'adminA', 400, {
      antes: nuevo('k'),
      body: { reason: '   ' },
    }),
    cancelar('motivo de más de 500 caracteres', 'adminA', 400, {
      antes: nuevo('k'),
      body: { reason: 'a'.repeat(501) },
    }),
    cancelar('campo desconocido', 'adminA', 400, {
      antes: nuevo('k'),
      body: { reason: 'x', foo: 1 },
    }),
    cancelar('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      antes: nuevo('k'),
      ...motivo,
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    cancelar('inexistente', 'adminA', 404, {
      ruta: idInexistente(SW_CAN),
      ...motivo,
    }),
    cancelar('pedido de otro cliente', 'clienteB', 404, {
      antes: nuevo('k'),
      ...motivo,
    }),
    cancelar('administrador de otra distribuidora', 'adminB', 404, {
      antes: nuevo('k'),
      ...motivo,
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.k}`, 'adminA');
        expect(r.body).toMatchObject({ status: 'pending' });
      },
    }),
    cancelar('super en modo soporte sobre B', 'soporteB', 403, {
      antes: nuevo('k'),
      ...motivo,
      code: 'SUPPORT_READ_ONLY',
    }),
    cancelar('chofer de otra distribuidora', 'choferB', 404, {
      antes: nuevo('k', { estado: E.ACCEPTED }),
      body: {},
    }),
    cancelar('pedido entregado', 'adminA', 400, {
      antes: nuevo('k', { estado: E.DELIVERED }),
      ...motivo,
    }),
    cancelar('pedido ya cancelado', 'adminA', 400, {
      antes: nuevo('k', { estado: E.CANCELLED }),
      ...motivo,
    }),
    cancelar('la misma clave con otro cuerpo', 'adminA', 422, {
      antes: async (c) => {
        await nuevo('k')(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          `/orders/${c.p.k}/cancel`,
          'adminA',
          { reason: 'Un motivo' },
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: { reason: 'Otro motivo distinto' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  // ============================================== DELETE /orders/{id}
  const SW_DEL = '/orders/{id}';
  const borrar = endpoint<Ctx>('delete', SW_DEL, ruta(SW_DEL, 'b'));
  const casosBorrar: Array<Caso<Ctx>> = [
    borrar('administrador', 'adminA', 200, {
      antes: nuevo('b'),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          status: 'cancelled',
          cancellation_reason: 'Cancelación forzada por el administrador',
        }),
    }),
    borrar('pedido aceptado', 'adminA', 200, {
      antes: nuevo('b', { estado: E.ACCEPTED }),
    }),
    borrar('super en modo soporte sobre A', 'soporteA', 403, {
      antes: nuevo('b'),
      code: 'SUPPORT_READ_ONLY',
    }),
    borrar('sin token', undefined, 401, {
      ...sinToken,
      ruta: idInexistente(SW_DEL),
    }),
    borrar('cliente', 'clienteA', 403, { antes: nuevo('b') }),
    borrar('chofer', 'chofer', 403, { antes: nuevo('b') }),
    borrar('id mal formado', 'adminA', 400, { ruta: idMalo(SW_DEL) }),
    borrar('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      antes: nuevo('b'),
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    borrar('pedido entregado', 'adminA', 400, {
      antes: nuevo('b', { estado: E.DELIVERED }),
    }),
    borrar('pedido ya cancelado', 'adminA', 400, {
      antes: nuevo('b', { estado: E.CANCELLED }),
    }),
    borrar('inexistente', 'adminA', 404, { ruta: idInexistente(SW_DEL) }),
    borrar('administrador de otra distribuidora', 'adminB', 404, {
      antes: nuevo('b'),
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.b}`, 'adminA');
        expect(r.body).toMatchObject({ status: 'pending' });
      },
    }),
    borrar('super en modo soporte sobre B', 'soporteB', 403, {
      antes: nuevo('b'),
      code: 'SUPPORT_READ_ONLY',
    }),
  ];

  // ============================================ PATCH /orders/{id}/status
  const SW_EST = '/orders/{id}/status';
  const estado = endpoint<Ctx>('patch', SW_EST, ruta(SW_EST, 's'));
  const casosEstado: Array<Caso<Ctx>> = [
    estado('el chofer acepta un pendiente', 'chS1', 200, {
      antes: nuevo('s'),
      body: { status: 'accepted' },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ status: 'accepted' }),
    }),
    estado('el chofer repite la aceptación del mismo pedido', 'chS2', 200, {
      antes: async (c) => {
        await nuevo('s')(c);
        await llamar(c, 'patch', `/orders/${c.p.s}/status`, 'chS2', {
          status: 'accepted',
        });
      },
      body: { status: 'accepted' },
    }),
    estado('el chofer sale con el pedido aceptado', 'chofer', 200, {
      antes: nuevo('s', { estado: E.ACCEPTED }),
      body: { status: 'out_for_delivery' },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ status: 'out_for_delivery' }),
    }),
    estado('el administrador asigna con deliveryId', 'adminA', 200, {
      antes: nuevo('s'),
      body: (c) => ({ status: 'accepted', deliveryId: c.choferA2.deliveryId }),
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 's')).deliveryId).toBe(c.choferA2.deliveryId),
    }),
    estado('el administrador entrega a mano con motivo', 'adminA', 200, {
      antes: nuevo('s', { estado: E.ON_THE_WAY }),
      body: {
        status: 'delivered',
        reason: 'El cliente no tiene celular: confirmó por teléfono',
      },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ status: 'delivered' }),
    }),
    estado('el administrador libera un pedido aceptado', 'adminA', 200, {
      antes: nuevo('s', { estado: E.ACCEPTED }),
      body: { status: 'pending' },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ status: 'pending' }),
    }),
    estado('el administrador cancela con motivo', 'adminA', 200, {
      antes: nuevo('s'),
      body: {
        status: 'cancelled',
        reason: 'El cliente avisó que no lo quiere',
      },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ status: 'cancelled' }),
    }),
    estado('super en modo soporte sobre A', 'soporteA', 403, {
      antes: nuevo('s', { estado: E.ACCEPTED }),
      body: { status: 'pending' },
      code: 'SUPPORT_READ_ONLY',
    }),
    estado('sin token', undefined, 401, {
      ...sinTokenChofer,
      ruta: idInexistente(SW_EST),
      body: { status: 'accepted' },
    }),
    estado('cliente', 'clienteA', 403, {
      antes: nuevo('s'),
      body: { status: 'cancelled', reason: 'No lo quiero más' },
    }),
    estado(
      'el chofer no entrega: se confirma con el QR del cliente',
      'chofer',
      403,
      {
        antes: nuevo('s', { estado: E.ON_THE_WAY }),
        body: { status: 'delivered' },
      },
    ),
    estado('el chofer opera un pedido de otro chofer', 'choferA2', 403, {
      antes: nuevo('s', { estado: E.ACCEPTED }),
      body: { status: 'out_for_delivery' },
    }),
    estado('el chofer no activa una reserva', 'chofer', 403, {
      antes: nuevo('s', { reserva: { sena: 300 } }),
      body: { status: 'pending' },
    }),
    estado('id mal formado', 'adminA', 400, {
      ruta: idMalo(SW_EST),
      body: { status: 'accepted' },
    }),
    estado('sin estado', 'adminA', 400, { antes: nuevo('s'), body: {} }),
    estado('estado inexistente', 'adminA', 400, {
      antes: nuevo('s'),
      body: { status: 'volando' },
    }),
    estado('deliveryId que no es un UUID', 'adminA', 400, {
      antes: nuevo('s'),
      body: { status: 'accepted', deliveryId: 'xx' },
    }),
    estado('entrega a mano sin motivo', 'adminA', 400, {
      antes: nuevo('s', { estado: E.ON_THE_WAY }),
      body: { status: 'delivered' },
    }),
    estado('entrega a mano con motivo corto', 'adminA', 400, {
      antes: nuevo('s', { estado: E.ON_THE_WAY }),
      body: { status: 'delivered', reason: 'corto' },
    }),
    estado('cancelación sin motivo', 'adminA', 400, {
      antes: nuevo('s'),
      body: { status: 'cancelled' },
    }),
    estado('motivo de más de 500 caracteres', 'adminA', 400, {
      antes: nuevo('s', { estado: E.ON_THE_WAY }),
      body: { status: 'delivered', reason: 'a'.repeat(501) },
    }),
    estado('campo desconocido', 'adminA', 400, {
      antes: nuevo('s'),
      body: { status: 'accepted', foo: 1 },
    }),
    estado('transición inválida: de cancelado a aceptado', 'adminA', 400, {
      antes: nuevo('s', { estado: E.CANCELLED }),
      body: (c) => ({ status: 'accepted', deliveryId: c.choferA2.deliveryId }),
    }),
    estado('transición inválida: de entregado a pendiente', 'adminA', 400, {
      antes: nuevo('s', { estado: E.DELIVERED }),
      body: { status: 'pending' },
    }),
    estado('reserva sin la seña paga', 'adminA', 400, {
      antes: nuevo('s', { reserva: { sena: 300 } }),
      body: { status: 'pending' },
    }),
    estado('chofer deshabilitado', 'choferInhabilitado', 400, {
      antes: nuevo('s'),
      body: { status: 'accepted' },
    }),
    estado('chofer sin validar', 'choferSinValidar', 400, {
      antes: nuevo('s'),
      body: { status: 'accepted' },
    }),
    estado('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      antes: nuevo('s'),
      body: { status: 'pending' },
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    estado('inexistente', 'adminA', 404, {
      ruta: idInexistente(SW_EST),
      body: { status: 'accepted' },
    }),
    estado('administrador de otra distribuidora', 'adminB', 404, {
      antes: nuevo('s', { estado: E.ACCEPTED }),
      body: { status: 'pending' },
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.s}`, 'adminA');
        expect(r.body).toMatchObject({ status: 'accepted' });
      },
    }),
    estado('chofer de otra distribuidora', 'choferB', 404, {
      antes: nuevo('s'),
      body: { status: 'accepted' },
    }),
    estado('super en modo soporte sobre B', 'soporteB', 403, {
      antes: nuevo('s'),
      body: { status: 'pending' },
      code: 'SUPPORT_READ_ONLY',
    }),
    estado('aceptar un pedido de Mercado Pago sin pagar', 'choferA2', 409, {
      antes: nuevoMercadoPago('s'),
      body: { status: 'accepted' },
    }),
    estado(
      'el chofer ya tiene otro pedido aceptado esperando',
      'choferA2',
      409,
      {
        antes: async (c) => {
          const otro = await sembrarPedido(c);
          await llamar(c, 'patch', `/orders/${otro}/status`, 'chS3', {
            status: 'accepted',
          });
          await nuevo('s')(c);
        },
        body: { status: 'accepted' },
      },
    ),
    estado('la misma clave con otro cuerpo', 'adminA', 422, {
      antes: async (c) => {
        await nuevo('s', { estado: E.ACCEPTED })(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          `/orders/${c.p.s}/status`,
          'adminA',
          { status: 'pending' },
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: { status: 'cancelled', reason: 'Otro motivo distinto' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  // ==================================== PATCH /orders/{id}/assign/{deliveryId}
  const asignar = endpoint<Ctx>(
    'patch',
    '/orders/{id}/assign/{deliveryId}',
    (c) => `/orders/${c.p.a}/assign/${c.choferA2.deliveryId}`,
  );
  const casosAsignar: Array<Caso<Ctx>> = [
    asignar('administrador', 'adminA', 200, {
      antes: nuevo('a'),
      verificar: async (cuerpo, c) => {
        expect(cuerpo).toMatchObject({ status: 'accepted' });
        expect((await pedidoDe(c, 'a')).deliveryId).toBe(c.choferA2.deliveryId);
      },
    }),
    asignar('super en modo soporte sobre A', 'soporteA', 403, {
      antes: nuevo('a'),
      code: 'SUPPORT_READ_ONLY',
    }),
    asignar('sin token', undefined, 401, {
      ...sinToken,
      ruta: (c) => `/orders/${c.inexistente}/assign/${c.inexistente}`,
    }),
    asignar('cliente', 'clienteA', 403, { antes: nuevo('a') }),
    asignar('chofer', 'chofer', 403, { antes: nuevo('a') }),
    asignar('pedido con id mal formado', 'adminA', 400, {
      ruta: (c) => `/orders/xx/assign/${c.choferA2.deliveryId}`,
    }),
    asignar('chofer con id mal formado', 'adminA', 400, {
      antes: nuevo('a'),
      ruta: (c) => `/orders/${c.p.a}/assign/xx`,
    }),
    asignar('chofer deshabilitado', 'adminA', 400, {
      antes: nuevo('a'),
      ruta: (c) => `/orders/${c.p.a}/assign/${c.choferInhabilitado.deliveryId}`,
    }),
    asignar('chofer sin validar', 'adminA', 400, {
      antes: nuevo('a'),
      ruta: (c) => `/orders/${c.p.a}/assign/${c.choferSinValidar.deliveryId}`,
    }),
    asignar('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      antes: nuevo('a'),
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    asignar('pedido inexistente', 'adminA', 404, {
      ruta: (c) => `/orders/${c.inexistente}/assign/${c.choferA2.deliveryId}`,
    }),
    asignar('chofer inexistente', 'adminA', 404, {
      antes: nuevo('a'),
      ruta: (c) => `/orders/${c.p.a}/assign/${c.inexistente}`,
    }),
    asignar('chofer de otra distribuidora', 'adminA', 404, {
      antes: nuevo('a'),
      ruta: (c) => `/orders/${c.p.a}/assign/${c.choferB.deliveryId}`,
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.a}`, 'adminA');
        expect(r.body).toMatchObject({ status: 'pending', driver: null });
      },
    }),
    asignar('administrador de otra distribuidora', 'adminB', 404, {
      antes: nuevo('a'),
      ruta: (c) => `/orders/${c.p.a}/assign/${c.choferB.deliveryId}`,
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.a}`, 'adminA');
        expect(r.body).toMatchObject({ status: 'pending', driver: null });
      },
    }),
    asignar('super en modo soporte sobre B', 'soporteB', 403, {
      antes: nuevo('a'),
      code: 'SUPPORT_READ_ONLY',
    }),
    asignar('pedido de Mercado Pago sin pagar', 'adminA', 409, {
      antes: nuevoMercadoPago('a'),
    }),
    asignar('reasigna un pedido que ya tiene chofer', 'adminA', 200, {
      antes: nuevo('a', { estado: E.ACCEPTED }),
      verificar: async (cuerpo, c) => {
        expect(cuerpo).toMatchObject({ status: 'accepted' });
        expect((await pedidoDe(c, 'a')).deliveryId).toBe(c.choferA2.deliveryId);
      },
    }),
  ];

  // ================================================ POST /orders/{id}/reject
  const SW_REJ = '/orders/{id}/reject';
  const rechazar = endpoint<Ctx>('post', SW_REJ, ruta(SW_REJ, 'j'));
  const casosRechazar: Array<Caso<Ctx>> = [
    rechazar(
      'asignación manual: el pedido sigue asignado y se avisa al panel',
      'chofer',
      200,
      {
        antes: nuevo('j', { estado: E.ACCEPTED }),
        verificar: async (cuerpo, c) => {
          expect(cuerpo).toMatchObject({ rejected: true });
          const r = await llamar(c, 'get', `/orders/${c.p.j}`, 'adminA');
          expect(r.body).toMatchObject({ status: 'accepted' });
        },
      },
    ),
    rechazar('sin token', undefined, 401, {
      ...sinTokenChofer,
      ruta: idInexistente(SW_REJ),
    }),
    rechazar('cliente', 'clienteA', 403, { antes: nuevo('j') }),
    rechazar('administrador', 'adminA', 403, { antes: nuevo('j') }),
    rechazar('id mal formado', 'chofer', 400, { ruta: idMalo(SW_REJ) }),
    rechazar('inexistente', 'chofer', 404, { ruta: idInexistente(SW_REJ) }),
    rechazar('chofer de otra distribuidora', 'choferB', 404, {
      antes: nuevo('j', { estado: E.ACCEPTED }),
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.j}`, 'adminA');
        expect(r.body).toMatchObject({ status: 'accepted' });
      },
    }),
  ];

  // ================================================ PATCH /orders/{id}/arrived
  const SW_ARR = '/orders/{id}/arrived';
  const llego = endpoint<Ctx>('patch', SW_ARR, ruta(SW_ARR, 'l'));
  const casosLlego: Array<Caso<Ctx>> = [
    llego('chofer asignado con el pedido en camino', 'chofer', 200, {
      antes: nuevo('l', { estado: E.ON_THE_WAY }),
      verificar: (cuerpo) => expect(cuerpo).toHaveProperty('message'),
    }),
    llego('administrador', 'adminA', 200, {
      antes: nuevo('l', { estado: E.ON_THE_WAY }),
    }),
    llego('super en modo soporte sobre A', 'soporteA', 403, {
      antes: nuevo('l', { estado: E.ON_THE_WAY }),
      code: 'SUPPORT_READ_ONLY',
    }),
    llego('sin token', undefined, 401, {
      ...sinTokenChofer,
      ruta: idInexistente(SW_ARR),
    }),
    llego('cliente', 'clienteA', 403, {
      antes: nuevo('l', { estado: E.ON_THE_WAY }),
    }),
    llego('chofer de otro pedido', 'choferA2', 403, {
      antes: nuevo('l', { estado: E.ON_THE_WAY }),
    }),
    llego('id mal formado', 'chofer', 400, { ruta: idMalo(SW_ARR) }),
    llego('pedido pendiente', 'adminA', 400, { antes: nuevo('l') }),
    llego('pedido aceptado, todavía no en camino', 'chofer', 400, {
      antes: nuevo('l', { estado: E.ACCEPTED }),
    }),
    llego('pedido entregado', 'adminA', 400, {
      antes: nuevo('l', { estado: E.DELIVERED }),
    }),
    llego('inexistente', 'adminA', 404, { ruta: idInexistente(SW_ARR) }),
    llego('administrador de otra distribuidora', 'adminB', 404, {
      antes: nuevo('l', { estado: E.ON_THE_WAY }),
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.l}`, 'adminA');
        expect(r.body).toMatchObject({ status: 'out_for_delivery' });
      },
    }),
    llego('chofer de otra distribuidora', 'choferB', 404, {
      antes: nuevo('l', { estado: E.ON_THE_WAY }),
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.l}`, 'adminA');
        expect(r.body).toMatchObject({ status: 'out_for_delivery' });
      },
    }),
  ];

  // ============================================== PATCH /orders/{id}/location
  const SW_LOC = '/orders/{id}/location';
  const posicion = endpoint<Ctx>('patch', SW_LOC, ruta(SW_LOC, 'p'));
  const punto = { lat: '-34.603722', lng: '-58.381592' };
  const casosPosicion: Array<Caso<Ctx>> = [
    posicion('chofer del pedido', 'chofer', 200, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: punto,
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          order_id: c.p.p,
          status: 'out_for_delivery',
        }),
    }),
    posicion('sin token', undefined, 401, {
      ...sinTokenChofer,
      ruta: idInexistente(SW_LOC),
      body: punto,
    }),
    posicion('cliente', 'clienteA', 403, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: punto,
    }),
    posicion('administrador', 'adminA', 403, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: punto,
    }),
    posicion('id mal formado', 'chofer', 400, {
      ruta: idMalo(SW_LOC),
      body: punto,
    }),
    posicion('latitud inválida', 'chofer', 400, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: { ...punto, lat: '95' },
    }),
    posicion('longitud inválida', 'chofer', 400, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: { ...punto, lng: '200' },
    }),
    posicion('latitud que no es un número', 'chofer', 400, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: { ...punto, lat: 'norte' },
    }),
    posicion('sin latitud', 'chofer', 400, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: { lng: punto.lng },
    }),
    posicion('sin longitud', 'chofer', 400, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: { lat: punto.lat },
    }),
    posicion('campo desconocido', 'chofer', 400, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: { ...punto, foo: 1 },
    }),
    posicion('chofer de otro pedido', 'choferA2', 403, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: punto,
    }),
    posicion('inexistente', 'chofer', 404, {
      ruta: idInexistente(SW_LOC),
      body: punto,
    }),
    posicion('chofer de otra distribuidora', 'choferB', 404, {
      antes: nuevo('p', { estado: E.ON_THE_WAY }),
      body: punto,
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.p}`, 'adminA');
        expect(r.body).toMatchObject({ status: 'out_for_delivery' });
      },
    }),
  ];

  // ====================================== POST /orders/{id}/confirm-delivery
  const SW_CONF = '/orders/{id}/confirm-delivery';
  const confirmar = endpoint<Ctx>('post', SW_CONF, ruta(SW_CONF, 'f'));
  const codigoBueno = { body: { code: '123456' } };
  const equivocado = (n: number) => async (c: Ctx) => {
    for (let i = 0; i < n; i += 1) {
      await llamar(c, 'post', `/orders/${c.p.f}/confirm-delivery`, 'clienteA', {
        code: '000000',
      });
    }
  };
  const casosConfirmar: Array<Caso<Ctx>> = [
    confirmar('cliente con el código del chofer', 'clienteA', 201, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      ...codigoBueno,
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ status: 'delivered' }),
    }),
    confirmar('administrador con motivo', 'adminA', 201, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: {
        code: '123456',
        reason: 'El cliente no tiene celular: confirmó por teléfono',
      },
    }),
    confirmar('super en modo soporte sobre A', 'soporteA', 403, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: {
        code: '123456',
        reason: 'El cliente no tiene celular: confirmó por teléfono',
      },
      code: 'SUPPORT_READ_ONLY',
    }),
    confirmar('sin token', undefined, 401, {
      ...sinTokenCliente,
      ruta: idInexistente(SW_CONF),
      ...codigoBueno,
    }),
    confirmar('chofer', 'chofer', 403, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      ...codigoBueno,
    }),
    confirmar('cliente de otro pedido', 'clienteB', 404, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      ...codigoBueno,
    }),
    confirmar('id mal formado', 'clienteA', 400, {
      ruta: idMalo(SW_CONF),
      ...codigoBueno,
    }),
    confirmar('sin código', 'clienteA', 400, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: {},
    }),
    confirmar('código vacío', 'clienteA', 400, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: { code: '' },
    }),
    confirmar('código que no es texto', 'clienteA', 400, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: { code: 123456 },
    }),
    confirmar('campo desconocido', 'clienteA', 400, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: { code: '123456', foo: 1 },
    }),
    confirmar('código incorrecto', 'clienteA', 400, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: { code: '999999' },
      code: 'DELIVERY_CODE_INCORRECTO',
    }),
    confirmar('código mal leído', 'clienteA', 400, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: { code: 'no es un código' },
      code: 'DELIVERY_CODE_FORMATO',
    }),
    confirmar('código de otro pedido en camino del cliente', 'clienteA', 400, {
      antes: async (c) => {
        await nuevo('f', { estado: E.ON_THE_WAY })(c);
        const otro = await sembrarPedido(c, { estado: E.ON_THE_WAY });
        await c.app
          .get(DataSource)
          .getRepository(Order)
          .update({ orderId: otro }, { deliveryCode: '654321' });
      },
      body: { code: '654321' },
      code: 'DELIVERY_CODE_OTRO_PEDIDO',
    }),
    confirmar('el pedido no está en camino', 'clienteA', 400, {
      antes: nuevo('f', { estado: E.ACCEPTED }),
      ...codigoBueno,
    }),
    confirmar('pedido pendiente', 'clienteA', 400, {
      antes: nuevo('f'),
      ...codigoBueno,
    }),
    confirmar('administrador sin motivo', 'adminA', 400, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      ...codigoBueno,
    }),
    confirmar('administrador con motivo corto', 'adminA', 400, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: { code: '123456', reason: 'corto' },
    }),
    confirmar('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: { code: '123456', reason: 'El cliente no tiene celular' },
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    confirmar('inexistente', 'clienteA', 404, {
      ruta: idInexistente(SW_CONF),
      ...codigoBueno,
    }),
    confirmar('administrador de otra distribuidora', 'adminB', 404, {
      antes: nuevo('f', { estado: E.ON_THE_WAY }),
      body: { code: '123456', reason: 'El cliente no tiene celular' },
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.f}`, 'adminA');
        expect(r.body).toMatchObject({ status: 'out_for_delivery' });
      },
    }),
    confirmar('se agotaron los 5 intentos', 'clienteA', 409, {
      antes: async (c) => {
        await nuevo('f', { estado: E.ON_THE_WAY })(c);
        await equivocado(5)(c);
      },
      ...codigoBueno,
      code: 'DELIVERY_CODE_BLOQUEADO',
    }),
    confirmar('la misma clave con otro cuerpo', 'clienteA', 422, {
      antes: async (c) => {
        await nuevo('f', { estado: E.ON_THE_WAY })(c);
        c.p.clave = await usarClave(
          c,
          'post',
          `/orders/${c.p.f}/confirm-delivery`,
          'clienteA',
          { code: '123456' },
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: { code: '111111' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  // ================== POST /orders/{id}/delivery-code/regenerate (v2)
  const SW_REG = '/orders/{id}/delivery-code/regenerate';
  const regenerar = endpoint<Ctx>(
    'post',
    `/v2${SW_REG}`,
    (c) => `/v2${ruta(SW_REG, 'g')(c)}`,
  );
  const casosRegenerar: Array<Caso<Ctx>> = [
    regenerar('chofer asignado: código nuevo y sin intentos', 'chofer', 201, {
      antes: nuevo('g', { estado: E.ON_THE_WAY }),
      verificar: (cuerpo, c) => {
        const r = cuerpo as { orderId: string; deliveryCode: string };
        expect(r).toMatchObject({
          orderId: c.p.g,
          attempts: 0,
          blocked: false,
        });
        expect(r.deliveryCode).toMatch(/^\d{6}$/);
        expect(r.deliveryCode).not.toBe('123456');
      },
    }),
    regenerar(
      'después de agotar los intentos el cliente puede confirmar',
      'chofer',
      201,
      {
        antes: async (c) => {
          await nuevo('g', { estado: E.ON_THE_WAY })(c);
          for (let i = 0; i < 5; i += 1) {
            await llamar(
              c,
              'post',
              `/orders/${c.p.g}/confirm-delivery`,
              'clienteA',
              {
                code: '000000',
              },
            );
          }
        },
        verificar: async (cuerpo, c) => {
          const nuevoCodigo = (cuerpo as { deliveryCode: string }).deliveryCode;
          const r = await llamar(
            c,
            'post',
            `/orders/${c.p.g}/confirm-delivery`,
            'clienteA',
            { code: nuevoCodigo },
          );
          expect(r.status).toBe(201);
        },
      },
    ),
    regenerar('administrador', 'adminA', 201, {
      antes: nuevo('g', { estado: E.ON_THE_WAY }),
    }),
    regenerar('sin token', undefined, 401, {
      ...sinTokenChofer,
      ruta: (c) => `/v2/orders/${c.inexistente}/delivery-code/regenerate`,
    }),
    regenerar('cliente', 'clienteA', 403, {
      antes: nuevo('g', { estado: E.ON_THE_WAY }),
    }),
    regenerar('chofer de otro pedido', 'choferA2', 403, {
      antes: nuevo('g', { estado: E.ON_THE_WAY }),
    }),
    regenerar('id mal formado', 'chofer', 400, {
      ruta: '/v2/orders/xx/delivery-code/regenerate',
    }),
    regenerar('inexistente', 'chofer', 404, {
      ruta: (c) => `/v2/orders/${c.inexistente}/delivery-code/regenerate`,
    }),
    regenerar('administrador de otra distribuidora', 'adminB', 404, {
      antes: async (c) => {
        await nuevo('g', { estado: E.ON_THE_WAY })(c);
        c.p.codigoG = (await pedidoDe(c, 'g')).deliveryCode ?? '';
      },
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 'g')).deliveryCode).toBe(c.p.codigoG),
    }),
    regenerar('chofer de otra distribuidora', 'choferB', 404, {
      antes: async (c) => {
        await nuevo('g', { estado: E.ON_THE_WAY })(c);
        c.p.codigoG = (await pedidoDe(c, 'g')).deliveryCode ?? '';
      },
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 'g')).deliveryCode).toBe(c.p.codigoG),
    }),
    regenerar('pedido aceptado, todavía no en camino', 'chofer', 409, {
      antes: nuevo('g', { estado: E.ACCEPTED }),
    }),
    regenerar('pedido entregado', 'chofer', 409, {
      antes: nuevo('g', { estado: E.DELIVERED }),
    }),
  ];

  // ============ bajas de usuarios con pedidos en curso (409 que dejó la T1)
  const bajaPropia = endpoint<Ctx>('delete', '/users/me', '/users/me');
  const casosBajaPropia: Array<Caso<Ctx>> = [
    bajaPropia('cliente con un pedido pendiente', 'clienteA', 409, {
      antes: nuevo('z'),
      mensaje: 'pedido(s) en curso',
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/orders/${c.p.z}`, 'clienteA');
        expect(r.status).toBe(200);
      },
    }),
    bajaPropia('cliente con un pedido en camino', 'clienteA', 409, {
      antes: nuevo('z', { estado: E.ON_THE_WAY }),
      mensaje: 'pedido(s) en curso',
    }),
  ];
  const bajaDeUsuario = endpoint<Ctx>(
    'delete',
    '/users/{id}',
    (c) => `/users/${c.choferA.userId}`,
  );
  const casosBajaDeUsuario: Array<Caso<Ctx>> = [
    bajaDeUsuario('chofer con un pedido aceptado', 'adminA', 409, {
      antes: nuevo('z', { estado: E.ACCEPTED }),
      mensaje: 'pedido(s) en curso',
      verificar: async (_cuerpo, c) => {
        const r = await llamar(
          c,
          'get',
          `/users/${c.choferA.userId}`,
          'adminA',
        );
        expect(r.status).toBe(200);
      },
    }),
    bajaDeUsuario('chofer con un pedido en camino', 'adminA', 409, {
      antes: nuevo('z', { estado: E.ON_THE_WAY }),
      mensaje: 'pedido(s) en curso',
    }),
  ];

  correrMatriz('POST /orders', ver, conMismaDistribuidora(casosCrear));
  correrMatriz('POST /orders/quote', ver, conMismaDistribuidora(casosCotizar));
  correrMatriz('PATCH /orders/{id}', ver, conMismaDistribuidora(casosEditar));
  correrMatriz(
    'PATCH /orders/{id}/address',
    ver,
    conMismaDistribuidora(casosDireccion),
  );
  correrMatriz(
    'PATCH /orders/{id}/receiver',
    ver,
    conMismaDistribuidora(casosRecibe),
  );
  correrMatriz(
    'PATCH /orders/{id}/cancel',
    ver,
    conMismaDistribuidora(casosCancelar),
  );
  correrMatriz('DELETE /orders/{id}', ver, conMismaDistribuidora(casosBorrar));
  correrMatriz(
    'PATCH /orders/{id}/status',
    ver,
    conMismaDistribuidora(casosEstado),
  );
  correrMatriz(
    'PATCH /orders/{id}/assign/{deliveryId}',
    ver,
    conMismaDistribuidora(casosAsignar),
  );
  correrMatriz(
    'POST /orders/{id}/reject',
    ver,
    conMismaDistribuidora(casosRechazar),
  );
  correrMatriz(
    'PATCH /orders/{id}/arrived',
    ver,
    conMismaDistribuidora(casosLlego),
  );
  correrMatriz(
    'PATCH /orders/{id}/location',
    ver,
    conMismaDistribuidora(casosPosicion),
  );
  correrMatriz(
    'POST /orders/{id}/confirm-delivery',
    ver,
    conMismaDistribuidora(casosConfirmar, {
      'cliente de otro pedido': 403,
    }),
  );
  correrMatriz(
    'POST /v2/orders/{id}/delivery-code/regenerate',
    ver,
    conMismaDistribuidora(casosRegenerar),
  );
  correrMatriz('DELETE /users/me', ver, conMismaDistribuidora(casosBajaPropia));
  correrMatriz(
    'DELETE /users/{id}',
    ver,
    conMismaDistribuidora(casosBajaDeUsuario),
  );
});
