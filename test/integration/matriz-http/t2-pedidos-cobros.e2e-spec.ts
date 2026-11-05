/**
 * Matriz HTTP T2 (3/4): pedidos, cobros y comprobantes. Cobro en efectivo y
 * por transferencia, pagos impagos, retención por fraude, seña de las reservas,
 * datos bancarios y comprobantes (contra un MinIO efímero). Cada caso arma su
 * pedido en el `antes`.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../../src/order/entities/order.entity';
import { TestEnv, createTestApp } from '../setup/test-env';
import { TestMinio, startMinio } from '../setup/minio';
import { PNG_REAL } from '../setup/imagenes';
import { conBypassManager } from '../setup/bypass';
import {
  Adjunto,
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
  conMismaDistribuidora,
  sembrarBaseT2,
  sembrarPedido,
  usarClave,
} from './t2-base';

type Ctx = EscenarioT2;
const E = OrderStatus;

const png: Adjunto = {
  campo: 'file',
  contenido: PNG_REAL,
  nombre: 'comprobante.png',
  tipo: 'image/png',
};
const pdf: Adjunto = {
  campo: 'file',
  contenido: Buffer.from(
    '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF',
  ),
  nombre: 'comprobante.pdf',
  tipo: 'application/pdf',
};
const htmlComoPng: Adjunto = {
  campo: 'file',
  contenido: Buffer.from('<html><script>alert(1)</script></html>'),
  nombre: 'comprobante.png',
  tipo: 'image/png',
};
const textoPlano: Adjunto = {
  campo: 'file',
  contenido: Buffer.from('hola'),
  nombre: 'nota.txt',
  tipo: 'text/plain',
};
const gigante: Adjunto = {
  campo: 'file',
  contenido: Buffer.concat([PNG_REAL, Buffer.alloc(11 * 1024 * 1024)]),
  nombre: 'comprobante.png',
  tipo: 'image/png',
};

describe('Matriz HTTP T2: pedidos, cobros y comprobantes (e2e)', () => {
  let env: TestEnv;
  let minio: TestMinio;
  let ctx: Ctx;
  const ver = () => ctx;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    minio = await startMinio();
    env = await createTestApp({ s3: minio.env });
    ctx = await sembrarBaseT2(env.app, await sembrarEscenario(env.app));
    ctx.reiniciarCupos = () => reiniciarCuposDelThrottler(env);
  }, 300000);

  afterAll(async () => {
    await env.cleanup();
    await minio.stop();
  });

  const sinToken = { cabeceras: { 'X-Client-Source': 'panel-app' } };
  const sinTokenCliente = { cabeceras: { 'X-Client-Source': 'customer-app' } };
  const sinTokenChofer = { cabeceras: { 'X-Client-Source': 'driver-app' } };

  const nuevo =
    (clave: string, o: OpcionesPedido = {}) =>
    async (c: Ctx): Promise<void> => {
      c.p[clave] = await sembrarPedido(c, o);
    };
  /** Con campos del pedido escritos directo (estados que la API no deja armar). */
  const nuevoCon =
    (clave: string, o: OpcionesPedido, campos: Partial<Order>) =>
    async (c: Ctx): Promise<void> => {
      await nuevo(clave, o)(c);
      await conBypassManager(
        c.app.get(DataSource),
        ['transiciones', 'saldos', 'reglas'],
        (m) => m.update(Order, { orderId: c.p[clave] }, campos),
      );
    };
  const ruta = (swagger: string, clave: string) => (c: Ctx) =>
    swagger.replace('{id}', c.p[clave]);
  const idMalo = (swagger: string) => swagger.replace('{id}', 'xx');
  const idInexistente = (swagger: string) => (c: Ctx) =>
    swagger.replace('{id}', c.inexistente);
  const pedidoDe = (c: Ctx, clave: string) =>
    c.app.get(DataSource).getRepository(Order).findOneByOrFail({
      orderId: c.p[clave],
    });
  const entregadoEfectivo = (clave: string) =>
    nuevo(clave, { estado: E.DELIVERED });
  /** Como pasa de verdad: el chofer informa que el cliente no pagó. */
  const impago = (clave: string) => async (c: Ctx) => {
    await nuevo(clave, { estado: E.DELIVERED })(c);
    const r = await llamar(
      c,
      'patch',
      `/orders/${c.p[clave]}/payment/unpaid`,
      'chofer',
      { note: 'El cliente dice que paga mañana' },
    );
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  };
  const entregadoTransfer = (clave: string) =>
    nuevo(clave, { estado: E.DELIVERED, metodo: PaymentMethod.TRANSFER });

  // ===================================== PATCH /orders/{id}/payment/cash-received
  const SW_CASH = '/orders/{id}/payment/cash-received';
  const recibido = endpoint<Ctx>('patch', SW_CASH, ruta(SW_CASH, 'c'));
  const casosRecibido: Array<Caso<Ctx>> = [
    recibido('el chofer confirma que cobró', 'chofer', 200, {
      antes: entregadoEfectivo('c'),
      verificar: async (cuerpo, c) => {
        expect(cuerpo).toMatchObject({ paymentStatus: 'paid' });
        const p = await pedidoDe(c, 'c');
        expect(p.paymentStatus).toBe(PaymentStatus.PAID);
        expect(p.paymentConfirmedBy).toBe(c.choferA.userId);
      },
    }),
    recibido('repetirlo devuelve el pedido tal cual', 'chofer', 200, {
      antes: async (c) => {
        await entregadoEfectivo('c')(c);
        await llamar(
          c,
          'patch',
          `/orders/${c.p.c}/payment/cash-received`,
          'chofer',
        );
      },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ paymentStatus: 'paid' }),
    }),
    recibido('sin token', undefined, 401, {
      ...sinTokenChofer,
      ruta: idInexistente(SW_CASH),
    }),
    recibido('cliente', 'clienteA', 403, { antes: entregadoEfectivo('c') }),
    recibido('administrador', 'adminA', 403, { antes: entregadoEfectivo('c') }),
    recibido('chofer de otro pedido', 'choferA2', 403, {
      antes: entregadoEfectivo('c'),
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 'c')).paymentStatus).toBe(
          PaymentStatus.PENDING,
        ),
    }),
    recibido('id mal formado', 'chofer', 400, { ruta: idMalo(SW_CASH) }),
    recibido('pedido que todavía no se entregó', 'chofer', 400, {
      antes: nuevo('c', { estado: E.ON_THE_WAY }),
    }),
    recibido('pedido que no es en efectivo', 'chofer', 400, {
      antes: entregadoTransfer('c'),
    }),
    recibido('inexistente', 'chofer', 404, { ruta: idInexistente(SW_CASH) }),
    recibido('chofer de otra distribuidora', 'choferB', 404, {
      antes: entregadoEfectivo('c'),
    }),
    recibido('el pago ya se informó como impago', 'chofer', 409, {
      antes: impago('c'),
    }),
  ];

  // ================================ PATCH /orders/{id}/payment/register-cash
  const SW_REG = '/orders/{id}/payment/register-cash';
  const registrar = endpoint<Ctx>('patch', SW_REG, ruta(SW_REG, 'r'));
  const motivoCobro = {
    body: { reason: 'El chofer fue dado de baja antes de rendir' },
  };
  const casosRegistrar: Array<Caso<Ctx>> = [
    registrar('administrador', 'adminA', 200, {
      antes: entregadoEfectivo('r'),
      ...motivoCobro,
      verificar: async (cuerpo, c) => {
        expect(cuerpo).toMatchObject({ paymentStatus: 'paid' });
        const p = await pedidoDe(c, 'r');
        expect(p.paymentConfirmedBy).toBe(c.adminA.userId);
        expect(p.paymentResolutionNote).toBe(
          'El chofer fue dado de baja antes de rendir',
        );
      },
    }),
    registrar('repetirlo no asienta otra vez', 'adminA', 200, {
      antes: async (c) => {
        await entregadoEfectivo('r')(c);
        await llamar(
          c,
          'patch',
          `/orders/${c.p.r}/payment/register-cash`,
          'adminA',
          motivoCobro.body,
        );
      },
      ...motivoCobro,
    }),
    registrar('super viendo como A', 'superEnA', 200, {
      antes: entregadoEfectivo('r'),
      ...motivoCobro,
    }),
    registrar('sin token', undefined, 401, {
      ...sinToken,
      ruta: idInexistente(SW_REG),
      ...motivoCobro,
    }),
    registrar('cliente', 'clienteA', 403, {
      antes: entregadoEfectivo('r'),
      ...motivoCobro,
    }),
    registrar('chofer', 'chofer', 403, {
      antes: entregadoEfectivo('r'),
      ...motivoCobro,
    }),
    registrar('id mal formado', 'adminA', 400, {
      ruta: idMalo(SW_REG),
      ...motivoCobro,
    }),
    registrar('sin motivo', 'adminA', 400, {
      antes: entregadoEfectivo('r'),
      body: {},
    }),
    registrar('motivo corto', 'adminA', 400, {
      antes: entregadoEfectivo('r'),
      body: { reason: 'corto' },
    }),
    registrar('motivo en blanco', 'adminA', 400, {
      antes: entregadoEfectivo('r'),
      body: { reason: '           ' },
    }),
    registrar('motivo de más de 500 caracteres', 'adminA', 400, {
      antes: entregadoEfectivo('r'),
      body: { reason: 'a'.repeat(501) },
    }),
    registrar('caja que no es un UUID', 'adminA', 400, {
      antes: entregadoEfectivo('r'),
      body: { ...motivoCobro.body, cashBoxId: 'xx' },
    }),
    registrar('campo desconocido', 'adminA', 400, {
      antes: entregadoEfectivo('r'),
      body: { ...motivoCobro.body, foo: 1 },
    }),
    registrar('pedido que todavía no se entregó', 'adminA', 400, {
      antes: nuevo('r'),
      ...motivoCobro,
    }),
    registrar('pedido que no es en efectivo', 'adminA', 400, {
      antes: entregadoTransfer('r'),
      ...motivoCobro,
    }),
    registrar('super sin X-Distributor', 'super', 400, {
      antes: entregadoEfectivo('r'),
      ...motivoCobro,
    }),
    registrar('inexistente', 'adminA', 404, {
      ruta: idInexistente(SW_REG),
      ...motivoCobro,
    }),
    registrar('administrador de otra distribuidora', 'adminB', 404, {
      antes: entregadoEfectivo('r'),
      ...motivoCobro,
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 'r')).paymentStatus).toBe(
          PaymentStatus.PENDING,
        ),
    }),
    registrar('super viendo como B', 'superEnB', 404, {
      antes: entregadoEfectivo('r'),
      ...motivoCobro,
    }),
    registrar('el pago ya se informó como impago', 'adminA', 409, {
      antes: impago('r'),
      ...motivoCobro,
    }),
    registrar('la misma clave con otro cuerpo', 'adminA', 422, {
      antes: async (c) => {
        await entregadoEfectivo('r')(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          `/orders/${c.p.r}/payment/register-cash`,
          'adminA',
          motivoCobro.body,
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: { reason: 'Otro motivo bien distinto' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  // ================================= PATCH /orders/{id}/payment/resolve-unpaid
  const SW_RES = '/orders/{id}/payment/resolve-unpaid';
  const resolver = endpoint<Ctx>('patch', SW_RES, ruta(SW_RES, 'u'));
  const paga = {
    body: { resolution: 'paid', note: 'El cliente transfirió el lunes' },
  };
  const casosResolver: Array<Caso<Ctx>> = [
    resolver('el cliente pagó después', 'adminA', 200, {
      antes: impago('u'),
      ...paga,
      verificar: async (cuerpo, c) => {
        expect(cuerpo).toMatchObject({
          paymentStatus: 'paid',
          alreadyResolved: false,
        });
        expect((await pedidoDe(c, 'u')).paymentResolvedBy).toBe(
          c.adminA.userId,
        );
      },
    }),
    resolver('se da por perdido', 'adminA', 200, {
      antes: impago('u'),
      body: { resolution: 'written_off', note: 'No se pudo cobrar' },
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ paymentStatus: 'written_off' }),
    }),
    resolver('repetir la resolución es idempotente', 'adminA', 200, {
      antes: async (c) => {
        await impago('u')(c);
        await llamar(
          c,
          'patch',
          `/orders/${c.p.u}/payment/resolve-unpaid`,
          'adminA',
          paga.body,
        );
      },
      ...paga,
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ alreadyResolved: true }),
    }),
    resolver('super viendo como A', 'superEnA', 200, {
      antes: impago('u'),
      ...paga,
    }),
    resolver('sin token', undefined, 401, {
      ...sinToken,
      ruta: idInexistente(SW_RES),
      ...paga,
    }),
    resolver('cliente', 'clienteA', 403, { antes: impago('u'), ...paga }),
    resolver('chofer', 'chofer', 403, { antes: impago('u'), ...paga }),
    resolver('id mal formado', 'adminA', 400, {
      ruta: idMalo(SW_RES),
      ...paga,
    }),
    resolver('resolución inexistente', 'adminA', 400, {
      antes: impago('u'),
      body: { resolution: 'regalado', note: 'El cliente transfirió el lunes' },
    }),
    resolver('sin resolución', 'adminA', 400, {
      antes: impago('u'),
      body: { note: 'El cliente transfirió el lunes' },
    }),
    resolver('sin nota', 'adminA', 400, {
      antes: impago('u'),
      body: { resolution: 'paid' },
    }),
    resolver('nota corta', 'adminA', 400, {
      antes: impago('u'),
      body: { resolution: 'paid', note: 'corta' },
    }),
    resolver('nota de más de 500 caracteres', 'adminA', 400, {
      antes: impago('u'),
      body: { resolution: 'paid', note: 'a'.repeat(501) },
    }),
    resolver('caja que no es un UUID', 'adminA', 400, {
      antes: impago('u'),
      body: { ...paga.body, cashBoxId: 'xx' },
    }),
    resolver('super sin X-Distributor', 'super', 400, {
      antes: impago('u'),
      ...paga,
    }),
    resolver('inexistente', 'adminA', 404, {
      ruta: idInexistente(SW_RES),
      ...paga,
    }),
    resolver('administrador de otra distribuidora', 'adminB', 404, {
      antes: impago('u'),
      ...paga,
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 'u')).paymentStatus).toBe(
          PaymentStatus.UNPAID,
        ),
    }),
    resolver('super viendo como B', 'superEnB', 404, {
      antes: impago('u'),
      ...paga,
    }),
    resolver('el pedido no tiene el pago como impago', 'adminA', 409, {
      antes: entregadoEfectivo('u'),
      ...paga,
    }),
    resolver('la misma clave con otro cuerpo', 'adminA', 422, {
      antes: async (c) => {
        await impago('u')(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          `/orders/${c.p.u}/payment/resolve-unpaid`,
          'adminA',
          paga.body,
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: { resolution: 'written_off', note: 'Otra nota bien distinta' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  // ================================ PATCH /orders/{id}/payment/confirm-transfer
  const SW_TRF = '/orders/{id}/payment/confirm-transfer';
  const transferir = endpoint<Ctx>('patch', SW_TRF, ruta(SW_TRF, 't'));
  const recibida = {
    body: { received: true, reason: 'Figura en el extracto del banco' },
  };
  const noRecibida = {
    body: { received: false, reason: 'No figura en el extracto del banco' },
  };
  const casosTransferir: Array<Caso<Ctx>> = [
    transferir('se recibió', 'adminA', 200, {
      antes: entregadoTransfer('t'),
      ...recibida,
      verificar: async (cuerpo, c) => {
        expect(cuerpo).toMatchObject({ paymentStatus: 'paid' });
        expect((await pedidoDe(c, 't')).paymentConfirmedBy).toBe(
          c.adminA.userId,
        );
      },
    }),
    transferir('no se recibió', 'adminA', 200, {
      antes: entregadoTransfer('t'),
      ...noRecibida,
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({ paymentStatus: 'failed' }),
    }),
    transferir(
      'repetir la misma decisión devuelve el pedido tal cual',
      'adminA',
      200,
      {
        antes: async (c) => {
          await entregadoTransfer('t')(c);
          await llamar(
            c,
            'patch',
            `/orders/${c.p.t}/payment/confirm-transfer`,
            'adminA',
            recibida.body,
          );
        },
        ...recibida,
      },
    ),
    transferir('pedido pendiente de transferencia', 'adminA', 200, {
      antes: nuevo('t', { metodo: PaymentMethod.TRANSFER }),
      ...recibida,
    }),
    transferir('super viendo como A', 'superEnA', 200, {
      antes: entregadoTransfer('t'),
      ...recibida,
    }),
    transferir('sin token', undefined, 401, {
      ...sinToken,
      ruta: idInexistente(SW_TRF),
      ...recibida,
    }),
    transferir('cliente', 'clienteA', 403, {
      antes: entregadoTransfer('t'),
      ...recibida,
    }),
    transferir('chofer', 'chofer', 403, {
      antes: entregadoTransfer('t'),
      ...recibida,
    }),
    transferir('id mal formado', 'adminA', 400, {
      ruta: idMalo(SW_TRF),
      ...recibida,
    }),
    transferir('sin decisión', 'adminA', 400, {
      antes: entregadoTransfer('t'),
      body: { reason: 'Figura en el extracto del banco' },
    }),
    transferir('decisión que no es un booleano', 'adminA', 400, {
      antes: entregadoTransfer('t'),
      body: { received: 'si', reason: 'Figura en el extracto del banco' },
    }),
    transferir('sin motivo', 'adminA', 400, {
      antes: entregadoTransfer('t'),
      body: { received: true },
    }),
    transferir('motivo corto', 'adminA', 400, {
      antes: entregadoTransfer('t'),
      body: { received: true, reason: 'corto' },
    }),
    transferir('motivo de más de 500 caracteres', 'adminA', 400, {
      antes: entregadoTransfer('t'),
      body: { received: true, reason: 'a'.repeat(501) },
    }),
    transferir('campo desconocido', 'adminA', 400, {
      antes: entregadoTransfer('t'),
      body: { ...recibida.body, foo: 1 },
    }),
    transferir('pedido que no es una transferencia', 'adminA', 400, {
      antes: entregadoEfectivo('t'),
      ...recibida,
    }),
    transferir('pedido cancelado', 'adminA', 400, {
      antes: nuevo('t', {
        metodo: PaymentMethod.TRANSFER,
        estado: E.CANCELLED,
      }),
      ...recibida,
    }),
    transferir('super sin X-Distributor', 'super', 400, {
      antes: entregadoTransfer('t'),
      ...recibida,
    }),
    transferir('inexistente', 'adminA', 404, {
      ruta: idInexistente(SW_TRF),
      ...recibida,
    }),
    transferir('administrador de otra distribuidora', 'adminB', 404, {
      antes: entregadoTransfer('t'),
      ...recibida,
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 't')).paymentStatus).toBe(
          PaymentStatus.PENDING,
        ),
    }),
    transferir('super viendo como B', 'superEnB', 404, {
      antes: entregadoTransfer('t'),
      ...recibida,
    }),
    transferir('la decisión contraria sobre algo ya decidido', 'adminA', 409, {
      antes: async (c) => {
        await entregadoTransfer('t')(c);
        await llamar(
          c,
          'patch',
          `/orders/${c.p.t}/payment/confirm-transfer`,
          'adminA',
          recibida.body,
        );
      },
      ...noRecibida,
    }),
    transferir('la misma clave con otro cuerpo', 'adminA', 422, {
      antes: async (c) => {
        await entregadoTransfer('t')(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          `/orders/${c.p.t}/payment/confirm-transfer`,
          'adminA',
          recibida.body,
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: { received: true, reason: 'Otro motivo bien distinto' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  // ===================== PATCH /orders/{id}/payment/fraud-hold/release (v2)
  const SW_FRA = '/orders/{id}/payment/fraud-hold/release';
  const liberar = endpoint<Ctx>(
    'patch',
    `/v2${SW_FRA}`,
    (c) => `/v2${ruta(SW_FRA, 'h')(c)}`,
  );
  const retenido = (clave: string) =>
    nuevoCon(clave, {}, { paymentFraudHold: true });
  const liberacion = {
    body: { reason: 'Se verificó el pago con el cliente' },
  };
  const casosLiberar: Array<Caso<Ctx>> = [
    liberar('administrador', 'adminA', 200, {
      antes: retenido('h'),
      ...liberacion,
      verificar: async (_cuerpo, c) => {
        const p = await pedidoDe(c, 'h');
        expect(p.paymentFraudHold).toBe(false);
        expect(p.paymentFraudReleasedBy).toBe(c.adminA.userId);
        expect(p.paymentFraudReleasedReason).toBe(
          'Se verificó el pago con el cliente',
        );
      },
    }),
    liberar('super viendo como A', 'superEnA', 200, {
      antes: retenido('h'),
      ...liberacion,
    }),
    liberar('sin token', undefined, 401, {
      ...sinToken,
      ruta: (c) => `/v2/orders/${c.inexistente}/payment/fraud-hold/release`,
      ...liberacion,
    }),
    liberar('cliente', 'clienteA', 403, {
      antes: retenido('h'),
      ...liberacion,
    }),
    liberar('chofer', 'chofer', 403, { antes: retenido('h'), ...liberacion }),
    liberar('id mal formado', 'adminA', 400, {
      ruta: '/v2/orders/xx/payment/fraud-hold/release',
      ...liberacion,
    }),
    liberar('sin motivo', 'adminA', 400, { antes: retenido('h'), body: {} }),
    liberar('motivo corto', 'adminA', 400, {
      antes: retenido('h'),
      body: { reason: 'corto' },
    }),
    liberar('motivo de más de 500 caracteres', 'adminA', 400, {
      antes: retenido('h'),
      body: { reason: 'a'.repeat(501) },
    }),
    liberar('super sin X-Distributor', 'super', 400, {
      antes: retenido('h'),
      ...liberacion,
    }),
    liberar('inexistente', 'adminA', 404, {
      ruta: (c) => `/v2/orders/${c.inexistente}/payment/fraud-hold/release`,
      ...liberacion,
    }),
    liberar('administrador de otra distribuidora', 'adminB', 404, {
      antes: retenido('h'),
      ...liberacion,
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 'h')).paymentFraudHold).toBe(true),
    }),
    liberar('super viendo como B', 'superEnB', 404, {
      antes: retenido('h'),
      ...liberacion,
    }),
    liberar('el pedido no está retenido', 'adminA', 409, {
      antes: nuevo('h'),
      ...liberacion,
    }),
    liberar('la misma clave con otro cuerpo', 'adminA', 422, {
      antes: async (c) => {
        await retenido('h')(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          `/v2/orders/${c.p.h}/payment/fraud-hold/release`,
          'adminA',
          liberacion.body,
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: { reason: 'Otro motivo bien distinto' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  // ===================== PATCH /orders/{id}/confirm-deposit (v1 y v2)
  const SW_SENA = '/orders/{id}/confirm-deposit';
  const sena = endpoint<Ctx>('patch', SW_SENA, ruta(SW_SENA, 'd'));
  const reserva = (clave: string, o: OpcionesPedido = {}) =>
    nuevo(clave, { reserva: { sena: 300 }, ...o });
  const casosSena: Array<Caso<Ctx>> = [
    sena('administrador: seña en efectivo', 'adminA', 200, {
      antes: reserva('d'),
      verificar: async (cuerpo, c) => {
        expect(cuerpo).toMatchObject({ depositPaid: true });
        expect((await pedidoDe(c, 'd')).depositPaid).toBe(true);
      },
    }),
    sena('seña por transferencia', 'adminA', 200, {
      antes: reserva('d', { metodo: PaymentMethod.TRANSFER }),
    }),
    sena('super viendo como A', 'superEnA', 200, { antes: reserva('d') }),
    sena('sin token', undefined, 401, {
      ...sinToken,
      ruta: idInexistente(SW_SENA),
    }),
    sena('cliente', 'clienteA', 403, { antes: reserva('d') }),
    sena('chofer', 'chofer', 403, { antes: reserva('d') }),
    sena('id mal formado', 'adminA', 400, { ruta: idMalo(SW_SENA) }),
    sena('pedido que no es una reserva', 'adminA', 400, { antes: nuevo('d') }),
    sena('super sin X-Distributor', 'super', 400, { antes: reserva('d') }),
    sena('inexistente', 'adminA', 404, { ruta: idInexistente(SW_SENA) }),
    sena('administrador de otra distribuidora', 'adminB', 404, {
      antes: reserva('d'),
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 'd')).depositPaid).toBe(false),
    }),
    sena('super viendo como B', 'superEnB', 404, { antes: reserva('d') }),
  ];
  const SW_SENA2 = '/orders/{id}/confirm-deposit';
  const sena2 = endpoint<Ctx>(
    'patch',
    `/v2${SW_SENA2}`,
    (c) => `/v2${ruta(SW_SENA2, 'd')(c)}`,
  );
  const casosSena2: Array<Caso<Ctx>> = [
    sena2('administrador: seña en efectivo', 'adminA', 200, {
      antes: reserva('d'),
      body: {},
      verificar: async (cuerpo, c) => {
        expect(cuerpo).toMatchObject({ depositPaid: true });
        expect((await pedidoDe(c, 'd')).depositPaid).toBe(true);
      },
    }),
    sena2('seña por transferencia sin caja configurada', 'adminA', 200, {
      antes: reserva('d', { metodo: PaymentMethod.TRANSFER }),
      body: {},
    }),
    sena2('repetirlo no asienta otra vez', 'adminA', 200, {
      antes: async (c) => {
        await reserva('d')(c);
        await llamar(
          c,
          'patch',
          `/v2/orders/${c.p.d}/confirm-deposit`,
          'adminA',
          {},
        );
      },
      body: {},
    }),
    sena2('super viendo como A', 'superEnA', 200, {
      antes: reserva('d'),
      body: {},
    }),
    sena2('sin token', undefined, 401, {
      ...sinToken,
      ruta: (c) => `/v2/orders/${c.inexistente}/confirm-deposit`,
      body: {},
    }),
    sena2('cliente', 'clienteA', 403, { antes: reserva('d'), body: {} }),
    sena2('chofer', 'chofer', 403, { antes: reserva('d'), body: {} }),
    sena2('id mal formado', 'adminA', 400, {
      ruta: '/v2/orders/xx/confirm-deposit',
      body: {},
    }),
    sena2('caja que no es un UUID', 'adminA', 400, {
      antes: reserva('d'),
      body: { cashBoxId: 'xx' },
    }),
    sena2('campo desconocido', 'adminA', 400, {
      antes: reserva('d'),
      body: { foo: 1 },
    }),
    sena2('pedido que no es una reserva', 'adminA', 400, {
      antes: nuevo('d'),
      body: {},
    }),
    sena2('super sin X-Distributor', 'super', 400, {
      antes: reserva('d'),
      body: {},
    }),
    sena2('inexistente', 'adminA', 404, {
      ruta: (c) => `/v2/orders/${c.inexistente}/confirm-deposit`,
      body: {},
    }),
    sena2('caja inexistente', 'adminA', 404, {
      antes: reserva('d'),
      body: (c) => ({ cashBoxId: c.inexistente }),
    }),
    sena2('la caja rechaza el ingreso: sin sesión abierta', 'adminB', 409, {
      antes: async (c) => {
        const caja = await llamar(c, 'post', '/cash-boxes', 'adminB', {
          name: `Caja de efectivo ${randomUUID().slice(0, 6)}`,
          kind: 'cash',
          requiresSession: true,
        });
        if (caja.status !== 201) throw new Error(JSON.stringify(caja.body));
        c.p.caja = (caja.body as { cashBoxId: string }).cashBoxId;
        await reserva('d', { cliente: 'B', chofer: 'B' })(c);
      },
      body: (c) => ({ cashBoxId: c.p.caja }),
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 'd')).depositPaid).toBe(false),
    }),
    sena2('la misma clave con otro cuerpo', 'adminA', 422, {
      antes: async (c) => {
        await reserva('d')(c);
        c.p.clave = await usarClave(
          c,
          'patch',
          `/v2/orders/${c.p.d}/confirm-deposit`,
          'adminA',
          {},
        );
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      body: (c) => ({ cashBoxId: c.inexistente }),
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    sena2('administrador de otra distribuidora', 'adminB', 404, {
      antes: reserva('d'),
      body: {},
      verificar: async (_cuerpo, c) =>
        expect((await pedidoDe(c, 'd')).depositPaid).toBe(false),
    }),
    sena2('super viendo como B', 'superEnB', 404, {
      antes: reserva('d'),
      body: {},
    }),
  ];

  // ======================== GET /orders/{id}/bank-details (v2)
  const SW_BANCO = '/orders/{id}/bank-details';
  const banco = endpoint<Ctx>(
    'get',
    `/v2${SW_BANCO}`,
    (c) => `/v2${ruta(SW_BANCO, 'n')(c)}`,
  );
  const casosBanco: Array<Caso<Ctx>> = [
    banco('cliente dueño de un pedido por transferencia', 'clienteA', 200, {
      antes: nuevo('n', { metodo: PaymentMethod.TRANSFER }),
      verificar: (cuerpo) =>
        expect(Object.keys(cuerpo as object).sort()).toEqual(
          expect.arrayContaining(['alias', 'cbu']),
        ),
    }),
    banco('sin token', undefined, 401, {
      ...sinTokenCliente,
      ruta: (c) => `/v2/orders/${c.inexistente}/bank-details`,
    }),
    banco('administrador', 'adminA', 403, {
      antes: nuevo('n', { metodo: PaymentMethod.TRANSFER }),
    }),
    banco('chofer', 'chofer', 403, {
      antes: nuevo('n', { metodo: PaymentMethod.TRANSFER }),
    }),
    banco('id mal formado', 'clienteA', 400, {
      ruta: '/v2/orders/xx/bank-details',
    }),
    banco('pedido que no es una transferencia', 'clienteA', 400, {
      antes: nuevo('n'),
    }),
    banco('inexistente', 'clienteA', 404, {
      ruta: (c) => `/v2/orders/${c.inexistente}/bank-details`,
    }),
    banco('pedido de otro cliente', 'clienteB', 404, {
      antes: nuevo('n', { metodo: PaymentMethod.TRANSFER }),
    }),
  ];

  // ======================== comprobantes de transferencia (v2)
  const SW_COMP = '/orders/{id}/transfer-receipt';
  const subir = endpoint<Ctx>(
    'post',
    `/v2${SW_COMP}`,
    (c) => `/v2${ruta(SW_COMP, 'v')(c)}`,
  );
  const transferencia = (clave: string, o: OpcionesPedido = {}) =>
    nuevo(clave, { metodo: PaymentMethod.TRANSFER, ...o });
  /** Sube comprobantes como el cliente, sin pasar por la matriz. */
  const subirN = (clave: string, n: number) => async (c: Ctx) => {
    for (let i = 0; i < n; i += 1) {
      const r = await llamar(
        c,
        'post',
        `/v2/orders/${c.p[clave]}/transfer-receipt`,
        'clienteA',
        undefined,
        png,
      );
      if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    }
  };
  const casosSubir: Array<Caso<Ctx>> = [
    subir('imagen', 'clienteA', 201, {
      antes: transferencia('v'),
      adjunto: png,
      verificar: async (cuerpo, c) => {
        expect(cuerpo).toHaveProperty('attachmentId');
        const r = await llamar(
          c,
          'get',
          `/v2/orders/${c.p.v}/transfer-receipt`,
          'clienteA',
        );
        expect(r.body as unknown[]).toHaveLength(1);
      },
    }),
    subir('PDF', 'clienteA', 201, { antes: transferencia('v'), adjunto: pdf }),
    subir(
      'el pago figura como no recibido: sirve para corregirlo',
      'clienteA',
      201,
      {
        antes: nuevoCon(
          'v',
          { metodo: PaymentMethod.TRANSFER },
          {
            paymentStatus: PaymentStatus.FAILED,
          },
        ),
        adjunto: png,
      },
    ),
    subir('sin token', undefined, 401, {
      ...sinTokenCliente,
      ruta: (c) => `/v2/orders/${c.inexistente}/transfer-receipt`,
      adjunto: png,
    }),
    subir('administrador', 'adminA', 403, {
      antes: transferencia('v'),
      adjunto: png,
    }),
    subir('chofer', 'chofer', 403, { antes: transferencia('v'), adjunto: png }),
    subir('id mal formado', 'clienteA', 400, {
      ruta: '/v2/orders/xx/transfer-receipt',
      adjunto: png,
    }),
    subir('sin archivo', 'clienteA', 400, {
      antes: transferencia('v'),
      body: {},
    }),
    subir('pedido que no es una transferencia', 'clienteA', 400, {
      antes: nuevo('v'),
      adjunto: png,
    }),
    subir('inexistente', 'clienteA', 404, {
      ruta: (c) => `/v2/orders/${c.inexistente}/transfer-receipt`,
      adjunto: png,
    }),
    subir('pedido de otro cliente', 'clienteB', 404, {
      antes: transferencia('v'),
      adjunto: png,
    }),
    subir('pedido cancelado', 'clienteA', 409, {
      antes: transferencia('v', { estado: E.CANCELLED }),
      adjunto: png,
    }),
    subir('el pago ya está acreditado', 'clienteA', 409, {
      antes: transferencia('v', { pago: PaymentStatus.PAID }),
      adjunto: png,
    }),
    subir('ya tiene 5 comprobantes', 'clienteA', 409, {
      antes: async (c) => {
        await transferencia('v')(c);
        await subirN('v', 5)(c);
      },
      adjunto: png,
    }),
    subir('archivo de más de 10 MB', 'clienteA', 413, {
      antes: transferencia('v'),
      adjunto: gigante,
    }),
    subir('un HTML que dice ser PNG', 'clienteA', 415, {
      antes: transferencia('v'),
      adjunto: htmlComoPng,
    }),
    subir('texto plano', 'clienteA', 415, {
      antes: transferencia('v'),
      adjunto: textoPlano,
    }),
    subir('la misma clave con otro archivo', 'clienteA', 422, {
      antes: async (c) => {
        await transferencia('v')(c);
        c.p.clave = randomUUID();
        const r = await request(c.app.getHttpServer())
          .post(`/v2/orders/${c.p.v}/transfer-receipt`)
          .set({ ...c.actores.clienteA, 'Idempotency-Key': c.p.clave })
          .attach('file', png.contenido, {
            filename: png.nombre,
            contentType: png.tipo,
          });
        if (r.status !== 201) throw new Error(JSON.stringify(r.body));
      },
      cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
      adjunto: pdf,
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
  ];

  const listar = endpoint<Ctx>(
    'get',
    `/v2${SW_COMP}`,
    (c) => `/v2${ruta(SW_COMP, 'w')(c)}`,
  );
  const conComprobante = (clave: string) => async (c: Ctx) => {
    await transferencia(clave)(c);
    await subirN(clave, 1)(c);
  };
  const casosListar: Array<Caso<Ctx>> = [
    listar('cliente dueño', 'clienteA', 200, {
      antes: conComprobante('w'),
      verificar: (cuerpo) => {
        const lista = cuerpo as Array<Record<string, unknown>>;
        expect(lista).toHaveLength(1);
        expect(lista[0]).toHaveProperty('url');
        expect(lista[0]).not.toHaveProperty('uploadedByUserId');
      },
    }),
    listar('administrador: con quién lo subió', 'adminA', 200, {
      antes: conComprobante('w'),
      verificar: (cuerpo, c) => {
        const lista = cuerpo as Array<{ uploadedByUserId: string }>;
        expect(lista).toHaveLength(1);
        expect(lista[0].uploadedByUserId).toBe(c.clienteA.userId);
      },
    }),
    listar('super viendo como A', 'superEnA', 200, {
      antes: conComprobante('w'),
    }),
    listar('sin comprobantes', 'clienteA', 200, {
      antes: transferencia('w'),
      verificar: (cuerpo) => expect(cuerpo).toEqual([]),
    }),
    listar('sin token', undefined, 401, {
      ...sinTokenCliente,
      ruta: (c) => `/v2/orders/${c.inexistente}/transfer-receipt`,
    }),
    listar('chofer', 'chofer', 403, { antes: conComprobante('w') }),
    listar('id mal formado', 'adminA', 400, {
      ruta: '/v2/orders/xx/transfer-receipt',
    }),
    listar('super sin X-Distributor', 'super', 400, {
      antes: conComprobante('w'),
    }),
    listar('inexistente', 'adminA', 404, {
      ruta: (c) => `/v2/orders/${c.inexistente}/transfer-receipt`,
    }),
    listar('pedido de otro cliente', 'clienteB', 404, {
      antes: conComprobante('w'),
    }),
    listar('administrador de otra distribuidora', 'adminB', 404, {
      antes: conComprobante('w'),
    }),
    listar('super viendo como B', 'superEnB', 404, {
      antes: conComprobante('w'),
    }),
  ];

  correrMatriz(
    'PATCH /orders/{id}/payment/cash-received',
    ver,
    conMismaDistribuidora(casosRecibido),
  );
  correrMatriz(
    'PATCH /orders/{id}/payment/register-cash',
    ver,
    conMismaDistribuidora(casosRegistrar),
  );
  correrMatriz(
    'PATCH /orders/{id}/payment/resolve-unpaid',
    ver,
    conMismaDistribuidora(casosResolver),
  );
  correrMatriz(
    'PATCH /orders/{id}/payment/confirm-transfer',
    ver,
    conMismaDistribuidora(casosTransferir),
  );
  correrMatriz(
    'PATCH /v2/orders/{id}/payment/fraud-hold/release',
    ver,
    conMismaDistribuidora(casosLiberar),
  );
  correrMatriz(
    'PATCH /orders/{id}/confirm-deposit',
    ver,
    conMismaDistribuidora(casosSena),
  );
  correrMatriz(
    'PATCH /v2/orders/{id}/confirm-deposit',
    ver,
    conMismaDistribuidora(casosSena2),
  );
  correrMatriz(
    'GET /v2/orders/{id}/bank-details',
    ver,
    conMismaDistribuidora(casosBanco),
  );
  correrMatriz(
    'POST /v2/orders/{id}/transfer-receipt',
    ver,
    conMismaDistribuidora(casosSubir),
  );
  correrMatriz(
    'GET /v2/orders/{id}/transfer-receipt',
    ver,
    conMismaDistribuidora(casosListar),
  );
});
