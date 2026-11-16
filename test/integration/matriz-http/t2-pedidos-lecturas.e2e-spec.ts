/**
 * Matriz HTTP T2 (1/4): pedidos, lecturas. Las lecturas no cambian nada, así
 * que los pedidos de la tabla se arman una vez en el `beforeAll` y todos los
 * casos los comparten. Cada caso es una fila (ver `matriz.ts`).
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Order, OrderStatus } from '../../../src/order/entities/order.entity';
import { PaymentMethod } from '../../../src/order/entities/order.entity';
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
  conMismaDistribuidora,
  sembrarBaseT2,
  sembrarPedido,
} from './t2-base';

type Ctx = EscenarioT2;

/** Los ids de pedido de un listado paginado. */
const idsDe = (cuerpo: unknown): string[] =>
  (cuerpo as { orders: Array<{ order_id: string }> }).orders.map(
    (o) => o.order_id,
  );

/** La reserva de un listado de reservas, por su id. */
const reservaDe = (cuerpo: unknown, id: string) =>
  (cuerpo as Array<{ id: string }>).find((r) => r.id === id);

describe('Matriz HTTP T2: pedidos, lecturas (e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    const c = await sembrarBaseT2(env.app, await sembrarEscenario(env.app));
    c.reiniciarCupos = () => reiniciarCuposDelThrottler(env);
    ctx = c;
    const p = c.p;
    p.pend = await sembrarPedido(c);
    p.pend2 = await sembrarPedido(c, { metodo: PaymentMethod.TRANSFER });
    p.acc = await sembrarPedido(c, { estado: OrderStatus.ACCEPTED });
    p.otw = await sembrarPedido(c, { estado: OrderStatus.ON_THE_WAY });
    p.del = await sembrarPedido(c, { estado: OrderStatus.DELIVERED });
    p.can = await sembrarPedido(c, { estado: OrderStatus.CANCELLED });
    p.reserva = await sembrarPedido(c, { reserva: { sena: 300 } });
    p.pendB = await sembrarPedido(c, { cliente: 'B' });
    p.delB = await sembrarPedido(c, {
      cliente: 'B',
      estado: OrderStatus.DELIVERED,
      chofer: 'B',
    });
    // Un pedido que el chofer A2 aceptó y quedó en manos de otro chofer: para el 410.
    p.liberado = await sembrarPedido(c);
    const asignar = await llamar(
      c,
      'patch',
      `/orders/${p.liberado}/status`,
      'choferA2',
      { status: 'accepted' },
    );
    if (asignar.status !== 200) {
      throw new Error(`No se pudo aceptar: ${JSON.stringify(asignar.body)}`);
    }
    // La constancia de que A2 lo aceptó queda; el pedido pasa a otro chofer.
    await env.app
      .get(DataSource)
      .getRepository(Order)
      .update({ orderId: p.liberado }, { deliveryId: c.choferA.deliveryId });
  }, 300000);

  afterAll(async () => {
    await env.cleanup();
  });

  const sinToken = { cabeceras: { 'X-Client-Source': 'panel-app' } };
  const sinTokenCliente = { cabeceras: { 'X-Client-Source': 'customer-app' } };

  // ============================================================ GET /orders
  const listar = endpoint<Ctx>('get', '/orders', '/orders');
  const casosListar: Array<Caso<Ctx>> = [
    listar('administrador: sólo los de su distribuidora', 'adminA', 200, {
      ruta: '/orders?limit=100',
      verificar: (cuerpo, c) => {
        const ids = idsDe(cuerpo);
        expect(ids).toEqual(
          expect.arrayContaining([c.p.pend, c.p.acc, c.p.del]),
        );
        expect(ids).not.toContain(c.p.pendB);
        expect(ids).not.toContain(c.p.delB);
      },
    }),
    listar('administrador de B: sólo los de B', 'adminB', 200, {
      ruta: '/orders?limit=100',
      verificar: (cuerpo, c) => {
        const ids = idsDe(cuerpo);
        expect(ids.sort()).toEqual([c.p.pendB, c.p.delB].sort());
        expect(cuerpo).toMatchObject({ total: 2 });
      },
    }),
    listar(
      'super sin distribuidora: todos (sin sesión de soporte)',
      'super',
      403,
      { ruta: '/orders?limit=100', code: 'SUPPORT_SESSION_REQUIRED' },
    ),
    listar('super en modo soporte sobre B', 'soporteB', 200, {
      ruta: '/orders?limit=100',
      verificar: (cuerpo, c) => {
        expect(idsDe(cuerpo)).toContain(c.p.pendB);
        expect(idsDe(cuerpo)).not.toContain(c.p.pend);
      },
    }),
    listar('filtra por estado', 'adminA', 200, {
      ruta: '/orders?status=accepted&limit=100',
      verificar: (cuerpo, c) => {
        expect(idsDe(cuerpo)).toContain(c.p.acc);
        expect(idsDe(cuerpo)).not.toContain(c.p.pend);
      },
    }),
    listar('filtra por «out_for_delivery»', 'adminA', 200, {
      ruta: '/orders?status=out_for_delivery&limit=100',
      verificar: (cuerpo, c) => expect(idsDe(cuerpo)).toEqual([c.p.otw]),
    }),
    listar('filtra por estado del pago', 'adminA', 200, {
      ruta: '/orders?paymentStatus=pending&limit=100',
      verificar: (cuerpo, c) => expect(idsDe(cuerpo)).toContain(c.p.pend),
    }),
    listar('busca por correo del cliente', 'adminA', 200, {
      ruta: (c) =>
        `/orders?term=${encodeURIComponent(c.clienteA.email)}&limit=100`,
      verificar: (cuerpo, c) => expect(idsDe(cuerpo)).toContain(c.p.pend),
    }),
    listar('busca algo que no existe', 'adminA', 200, {
      ruta: '/orders?term=zzzzzzzzzzzz',
      verificar: (cuerpo) => expect(idsDe(cuerpo)).toEqual([]),
    }),
    listar('pagina', 'adminA', 200, {
      ruta: '/orders?limit=2&offset=0',
      verificar: (cuerpo) => {
        expect(idsDe(cuerpo)).toHaveLength(2);
        expect(cuerpo).toMatchObject({ limit: 2, offset: 0 });
      },
    }),
    listar('rango de fechas', 'adminA', 200, {
      ruta: '/orders?from=2020-01-01&to=2099-12-31&limit=100',
      verificar: (cuerpo, c) => expect(idsDe(cuerpo)).toContain(c.p.pend),
    }),
    listar('ordena por entrega', 'adminA', 200, {
      ruta: '/orders?sort=deliveredAt&order=asc&limit=100',
    }),
    listar('entregados en un rango', 'adminA', 200, {
      ruta: '/orders?deliveredFrom=2020-01-01&deliveredTo=2099-12-31&limit=100',
      verificar: (cuerpo, c) => expect(idsDe(cuerpo)).toContain(c.p.del),
    }),
    listar('sin token', undefined, 401, sinToken),
    listar('cliente', 'clienteA', 403),
    listar('chofer', 'chofer', 403),
    listar('estado inexistente', 'adminA', 400, {
      ruta: '/orders?status=volando',
    }),
    listar('estado del pago inexistente', 'adminA', 400, {
      ruta: '/orders?paymentStatus=raro',
    }),
    listar('from con otro formato', 'adminA', 400, {
      ruta: '/orders?from=01/02/2026',
    }),
    listar('from que no es una fecha', 'adminA', 400, {
      ruta: '/orders?from=2026-02-31',
    }),
    listar('to con otro formato', 'adminA', 400, { ruta: '/orders?to=ayer' }),
    listar('from posterior a to', 'adminA', 400, {
      ruta: '/orders?from=2026-03-01&to=2026-02-01',
      mensajeExacto: '«Desde» no puede ser posterior a «Hasta»',
    }),
    listar('deliveredFrom posterior a deliveredTo', 'adminA', 400, {
      ruta: '/orders?deliveredFrom=2026-03-01&deliveredTo=2026-02-01',
      mensajeExacto:
        '«Entregado desde» no puede ser posterior a «Entregado hasta»',
    }),
    listar('deliveredFrom con otro formato', 'adminA', 400, {
      ruta: '/orders?deliveredFrom=x',
    }),
    listar('deliveredTo con otro formato', 'adminA', 400, {
      ruta: '/orders?deliveredTo=x',
    }),
    listar('orden inexistente', 'adminA', 400, { ruta: '/orders?sort=precio' }),
    listar('sentido inexistente', 'adminA', 400, {
      ruta: '/orders?order=arriba',
    }),
    listar('límite cero', 'adminA', 400, { ruta: '/orders?limit=0' }),
    listar('límite mayor a 100', 'adminA', 400, { ruta: '/orders?limit=101' }),
    listar('límite que no es número', 'adminA', 400, {
      ruta: '/orders?limit=a',
    }),
    listar('offset negativo', 'adminA', 400, { ruta: '/orders?offset=-1' }),
    listar('parámetro desconocido', 'adminA', 400, { ruta: '/orders?foo=1' }),
  ];

  // ====================================================== GET /orders/{id}
  const uno = endpoint<Ctx>(
    'get',
    '/orders/{id}',
    (c) => `/orders/${c.p.pend}`,
  );
  const de = (clave: string) => ({ ruta: (c: Ctx) => `/orders/${c.p[clave]}` });
  const casosUno: Array<Caso<Ctx>> = [
    uno('cliente dueño', 'clienteA', 200, {
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          order_id: c.p.pend,
          status: 'pending',
          payment_method: 'cash',
        }),
    }),
    uno('administrador', 'adminA', 200),
    uno('super en modo soporte sobre A', 'soporteA', 200),
    uno('chofer: un pedido del pool de su distribuidora', 'chofer', 200),
    uno('chofer: el que tiene asignado', 'chofer', 200, de('acc')),
    uno('sin token', undefined, 401, sinToken),
    uno('id mal formado', 'adminA', 400, { ruta: '/orders/xx' }),
    uno('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    uno('inexistente', 'adminA', 404, {
      ruta: (c) => `/orders/${c.inexistente}`,
      mensaje: 'Pedido no encontrado',
    }),
    uno('cliente: el pedido de otro cliente', 'clienteB', 404, {
      mensaje: 'Pedido no encontrado',
    }),
    uno('administrador de otra distribuidora', 'adminB', 404),
    uno('super en modo soporte sobre B el pedido de A', 'soporteB', 404),
    uno('chofer de otra distribuidora', 'choferB', 404),
    uno('chofer: el pedido asignado a otro', 'choferA2', 404, de('acc')),
    uno(
      'chofer de otra distribuidora: pedido aceptado',
      'choferB',
      404,
      de('acc'),
    ),
    uno(
      'chofer: pedido que tuvo y ya no es suyo',
      'choferA2',
      410,
      de('liberado'),
    ),
    uno(
      'chofer: pedido que otro chofer nunca tuvo',
      'choferA2',
      404,
      de('del'),
    ),
  ];

  // ================================================= GET /orders/{id}/status-history
  const historial = endpoint<Ctx>(
    'get',
    '/orders/{id}/status-history',
    (c) => `/orders/${c.p.acc}/status-history`,
  );
  const hist = (clave: string) => ({
    ruta: (c: Ctx) => `/orders/${c.p[clave]}/status-history`,
  });
  const casosHistorial: Array<Caso<Ctx>> = [
    historial('cliente dueño', 'clienteA', 200, {
      verificar: (cuerpo) => expect(Array.isArray(cuerpo)).toBe(true),
    }),
    historial('administrador', 'adminA', 200),
    historial('super en modo soporte sobre A', 'soporteA', 200),
    historial('chofer asignado', 'chofer', 200),
    historial('sin token', undefined, 401, sinToken),
    historial('id mal formado', 'adminA', 400, {
      ruta: '/orders/xx/status-history',
    }),
    historial('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    historial('inexistente', 'adminA', 404, {
      ruta: (c) => `/orders/${c.inexistente}/status-history`,
    }),
    historial('cliente de otro pedido', 'clienteB', 404),
    historial('administrador de otra distribuidora', 'adminB', 404),
    historial('super en modo soporte sobre B', 'soporteB', 404),
    historial('chofer de otra distribuidora', 'choferB', 404),
    historial(
      'chofer: pedido que tuvo y ya no es suyo',
      'choferA2',
      410,
      hist('liberado'),
    ),
  ];

  // ========================================== GET /orders/{id}/delivery-code
  const codigo = endpoint<Ctx>(
    'get',
    '/orders/{id}/delivery-code',
    (c) => `/orders/${c.p.acc}/delivery-code`,
  );
  const cod = (clave: string) => ({
    ruta: (c: Ctx) => `/orders/${c.p[clave]}/delivery-code`,
  });
  const casosCodigo: Array<Caso<Ctx>> = [
    codigo('chofer asignado', 'chofer', 200, {
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          orderId: c.p.acc,
          deliveryCode: '123456',
          attempts: 0,
          blocked: false,
        }),
    }),
    codigo('administrador', 'adminA', 200),
    codigo('super en modo soporte sobre A', 'soporteA', 200),
    codigo('sin token', undefined, 401, sinToken),
    codigo('cliente', 'clienteA', 403),
    codigo('chofer: pedido de otro chofer', 'choferA2', 403, {
      mensaje: 'no está asignado',
    }),
    codigo('id mal formado', 'adminA', 400, {
      ruta: '/orders/xx/delivery-code',
    }),
    codigo('pedido que aún no tiene código', 'adminA', 400, cod('pend')),
    codigo('inexistente', 'adminA', 404, {
      ruta: (c) => `/orders/${c.inexistente}/delivery-code`,
    }),
    codigo('administrador de otra distribuidora', 'adminB', 404),
    codigo('chofer de otra distribuidora', 'choferB', 404),
  ];

  // ============================================ GET /orders/{id}/driver-photo
  const foto = endpoint<Ctx>(
    'get',
    '/orders/{id}/driver-photo',
    (c) => `/orders/${c.p.acc}/driver-photo?modo=url`,
  );
  const casosFoto: Array<Caso<Ctx>> = [
    foto('cliente dueño: sin foto cargada', 'clienteA', 200, {
      verificar: (cuerpo) => expect(cuerpo).toMatchObject({ url: null }),
    }),
    foto('chofer asignado', 'chofer', 200),
    foto('administrador', 'adminA', 200),
    foto('super en modo soporte sobre A', 'soporteA', 200),
    foto('en camino', 'clienteA', 200, {
      ruta: (c) => `/orders/${c.p.otw}/driver-photo?modo=url`,
    }),
    foto('sin token', undefined, 401, sinToken),
    foto('id mal formado', 'adminA', 400, {
      ruta: '/orders/xx/driver-photo?modo=url',
    }),
    foto('modo inexistente', 'clienteA', 400, {
      ruta: (c) => `/orders/${c.p.acc}/driver-photo?modo=otro`,
    }),
    foto('chofer: pedido de otro chofer', 'choferA2', 403),
    foto('inexistente', 'adminA', 404, {
      ruta: (c) => `/orders/${c.inexistente}/driver-photo?modo=url`,
    }),
    foto('cliente de otro pedido', 'clienteB', 404),
    foto('administrador de otra distribuidora', 'adminB', 404),
    foto('chofer de otra distribuidora', 'choferB', 404),
    foto('el archivo mismo, sin foto cargada', 'clienteA', 404, {
      ruta: (c) => `/orders/${c.p.acc}/driver-photo?modo=archivo`,
      mensaje: 'No tiene foto',
    }),
    foto('pedido pendiente: todavía no hay chofer', 'clienteA', 409, {
      ruta: (c) => `/orders/${c.p.pend}/driver-photo?modo=url`,
    }),
    foto('pedido entregado', 'clienteA', 409, {
      ruta: (c) => `/orders/${c.p.del}/driver-photo?modo=url`,
    }),
  ];

  // ===================================== GET /orders/customer/{customerId}
  const porCliente = endpoint<Ctx>(
    'get',
    '/orders/customer/{customerId}',
    (c) => `/orders/customer/${c.clienteA.userId}`,
  );
  const casosPorCliente: Array<Caso<Ctx>> = [
    porCliente('cliente: los suyos', 'clienteA', 200, {
      ruta: (c) => `/orders/customer/${c.clienteA.userId}?limit=100`,
      verificar: (cuerpo, c) => {
        expect(idsDe(cuerpo)).toEqual(
          expect.arrayContaining([c.p.pend, c.p.del]),
        );
        expect(idsDe(cuerpo)).not.toContain(c.p.pendB);
      },
    }),
    porCliente('administrador', 'adminA', 200, {
      ruta: (c) => `/orders/customer/${c.clienteA.userId}?limit=100`,
      verificar: (cuerpo, c) => expect(idsDe(cuerpo)).toContain(c.p.pend),
    }),
    porCliente('super en modo soporte sobre A', 'soporteA', 200),
    porCliente(
      'administrador de B no ve los pedidos de un cliente de A',
      'adminB',
      200,
      {
        verificar: (cuerpo) => {
          expect(idsDe(cuerpo)).toEqual([]);
          expect(cuerpo).toMatchObject({ total: 0 });
        },
      },
    ),
    porCliente('pagina', 'clienteA', 200, {
      ruta: (c) => `/orders/customer/${c.clienteA.userId}?limit=1`,
      verificar: (cuerpo) => expect(idsDe(cuerpo)).toHaveLength(1),
    }),
    porCliente('sin token', undefined, 401, sinTokenCliente),
    porCliente('chofer', 'chofer', 403),
    porCliente('cliente: los pedidos de otro cliente', 'clienteB', 403, {
      mensaje: 'No autorizado a ver pedidos de otro cliente',
    }),
    porCliente('id mal formado', 'adminA', 400, {
      ruta: '/orders/customer/xx',
    }),
    porCliente('límite mayor a 100', 'adminA', 400, {
      ruta: (c) => `/orders/customer/${c.clienteA.userId}?limit=101`,
    }),
    porCliente('offset negativo', 'clienteA', 400, {
      ruta: (c) => `/orders/customer/${c.clienteA.userId}?offset=-1`,
    }),
  ];

  // ================================ GET /orders/delivery/{deliveryId}
  const porChofer = endpoint<Ctx>(
    'get',
    '/orders/delivery/{deliveryId}',
    (c) => `/orders/delivery/${c.choferA.deliveryId}?limit=100`,
  );
  const casosPorChofer: Array<Caso<Ctx>> = [
    porChofer('chofer: los suyos', 'chofer', 200, {
      verificar: (cuerpo, c) => {
        expect(idsDe(cuerpo)).toEqual(
          expect.arrayContaining([c.p.acc, c.p.otw]),
        );
      },
    }),
    porChofer('administrador', 'adminA', 200, {
      verificar: (cuerpo, c) => expect(idsDe(cuerpo)).toContain(c.p.acc),
    }),
    porChofer('super en modo soporte sobre A', 'soporteA', 200),
    porChofer(
      'administrador de B no ve los pedidos de un chofer de A',
      'adminB',
      200,
      {
        verificar: (cuerpo) => expect(idsDe(cuerpo)).toEqual([]),
      },
    ),
    porChofer('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'driver-app' },
    }),
    porChofer('cliente', 'clienteA', 403),
    porChofer('chofer: los de otro chofer', 'choferA2', 403),
    porChofer('id mal formado', 'adminA', 400, { ruta: '/orders/delivery/xx' }),
    porChofer('límite cero', 'adminA', 400, {
      ruta: (c) => `/orders/delivery/${c.choferA.deliveryId}?limit=0`,
    }),
  ];

  // ===================================== GET /orders/delivery/me/active
  const activo = endpoint<Ctx>(
    'get',
    '/orders/delivery/me/active',
    '/orders/delivery/me/active',
  );
  const casosActivo: Array<Caso<Ctx>> = [
    activo('chofer con un pedido en curso', 'chofer', 200, {
      verificar: (cuerpo, c) =>
        expect([c.p.otw, c.p.acc]).toContain(
          (cuerpo as { order_id: string }).order_id,
        ),
    }),
    activo(
      'chofer con un entregado hoy en efectivo sin cobro confirmado',
      'choferB',
      200,
      {
        verificar: (cuerpo, c) =>
          expect(cuerpo).toMatchObject({ order_id: c.p.delB }),
      },
    ),
    activo('chofer sin nada en curso: 204 sin cuerpo', 'choferA2', 204, {
      verificar: (cuerpo) => expect(cuerpo).toEqual({}),
    }),
    activo('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'driver-app' },
    }),
    activo('cliente', 'clienteA', 403),
    activo('administrador', 'adminA', 403),
    activo('super administrador', 'superEnA', 403),
  ];

  // ================================================= GET /orders/available
  const disponibles = endpoint<Ctx>(
    'get',
    '/orders/available',
    '/orders/available?limit=100',
  );
  const casosDisponibles: Array<Caso<Ctx>> = [
    disponibles('chofer: el pool de su distribuidora', 'chofer', 200, {
      verificar: (cuerpo, c) => {
        const ids = idsDe(cuerpo);
        expect(ids).toContain(c.p.pend);
        expect(ids).not.toContain(c.p.pendB);
        expect(ids).not.toContain(c.p.acc);
        expect(cuerpo).toMatchObject({
          openLoadRequired: false,
          message: null,
        });
      },
    }),
    disponibles('chofer de B: sólo el de B', 'choferB', 200, {
      verificar: (cuerpo, c) => {
        expect(idsDe(cuerpo)).toEqual([c.p.pendB]);
      },
    }),
    disponibles('administrador', 'adminA', 200, {
      verificar: (cuerpo, c) => {
        expect(idsDe(cuerpo)).toContain(c.p.pend);
        expect(idsDe(cuerpo)).not.toContain(c.p.pendB);
      },
    }),
    disponibles(
      'super sin distribuidora (sin sesión de soporte)',
      'super',
      403,
      { code: 'SUPPORT_SESSION_REQUIRED' },
    ),
    disponibles('sin token', undefined, 401, {
      cabeceras: { 'X-Client-Source': 'driver-app' },
    }),
    disponibles('cliente', 'clienteA', 403),
    disponibles('límite mayor a 100', 'chofer', 400, {
      ruta: '/orders/available?limit=500',
    }),
  ];

  // ============================================= GET /orders/reservations
  const reservas = endpoint<Ctx>(
    'get',
    '/orders/reservations',
    '/orders/reservations',
  );
  const casosReservas: Array<Caso<Ctx>> = [
    reservas('administrador', 'adminA', 200, {
      verificar: (cuerpo, c) =>
        expect(reservaDe(cuerpo, c.p.reserva)).toMatchObject({
          id: c.p.reserva,
          depositAmount: 300,
          depositPaid: false,
        }),
    }),
    reservas('administrador de B no ve las de A', 'adminB', 200, {
      verificar: (cuerpo) => expect(cuerpo).toEqual([]),
    }),
    reservas('super en modo soporte sobre A', 'soporteA', 200),
    reservas('sin token', undefined, 401, sinToken),
    reservas('cliente', 'clienteA', 403),
    reservas('chofer', 'chofer', 403),
    reservas('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
  ];

  // ===================================================== estadísticas
  const resumen = endpoint<Ctx>(
    'get',
    '/orders/stats/summary',
    '/orders/stats/summary',
  );
  const casosResumen: Array<Caso<Ctx>> = [
    resumen('administrador', 'adminA', 200, {
      verificar: (cuerpo) => {
        const r = cuerpo as {
          ordersSummary: {
            pending: number;
            accepted: number;
            onTheWay: number;
          };
        };
        expect(r.ordersSummary.pending).toBe(2);
        expect(r.ordersSummary.accepted).toBe(2);
        expect(r.ordersSummary.onTheWay).toBe(1);
      },
    }),
    resumen('administrador de B: sólo lo suyo', 'adminB', 200, {
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          ordersSummary: { pending: 1, accepted: 0, onTheWay: 0 },
        }),
    }),
    resumen('super sin distribuidora (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    resumen('sin token', undefined, 401, sinToken),
    resumen('cliente', 'clienteA', 403),
    resumen('chofer', 'chofer', 403),
  ];
  const grafico = endpoint<Ctx>(
    'get',
    '/orders/stats/chart',
    '/orders/stats/chart',
  );
  const casosGrafico: Array<Caso<Ctx>> = [
    grafico('administrador', 'adminA', 200, {
      verificar: (cuerpo) => expect(Array.isArray(cuerpo)).toBe(true),
    }),
    grafico('administrador de B', 'adminB', 200),
    grafico('super sin distribuidora (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    grafico('sin token', undefined, 401, sinToken),
    grafico('cliente', 'clienteA', 403),
    grafico('chofer', 'chofer', 403),
  ];

  // =========================================================== v2 pagos
  const pagos = endpoint<Ctx>(
    'get',
    '/v2/orders/payments',
    '/v2/orders/payments',
  );
  const ids =
    (...claves: string[]) =>
    (c: Ctx) =>
      `/v2/orders/payments?ids=${claves.map((k) => c.p[k]).join(',')}`;
  const casosPagos: Array<Caso<Ctx>> = [
    pagos('administrador: varios pedidos', 'adminA', 200, {
      ruta: ids('pend', 'pend2', 'del'),
      verificar: (cuerpo, c) =>
        expect(
          (cuerpo as Array<{ orderId: string }>).map((e) => e.orderId).sort(),
        ).toEqual([c.p.pend, c.p.pend2, c.p.del].sort()),
    }),
    pagos('los de otra distribuidora no aparecen', 'adminA', 200, {
      ruta: ids('pend', 'pendB'),
      verificar: (cuerpo, c) =>
        expect(
          (cuerpo as Array<{ orderId: string }>).map((e) => e.orderId),
        ).toEqual([c.p.pend]),
    }),
    pagos('uno inexistente no es error', 'adminA', 200, {
      ruta: (c) => `/v2/orders/payments?ids=${c.inexistente}`,
      verificar: (cuerpo) => expect(cuerpo).toEqual([]),
    }),
    pagos('super en modo soporte sobre A', 'soporteA', 200, {
      ruta: ids('pend'),
    }),
    pagos('sin token', undefined, 401, { ...sinToken, ruta: ids('pend') }),
    pagos('cliente', 'clienteA', 403, { ruta: ids('pend') }),
    pagos('chofer', 'chofer', 403, { ruta: ids('pend') }),
    pagos('sin ids', 'adminA', 400, { ruta: '/v2/orders/payments' }),
    pagos('ids vacío', 'adminA', 400, { ruta: '/v2/orders/payments?ids=' }),
    pagos('un id que no es UUID', 'adminA', 400, {
      ruta: '/v2/orders/payments?ids=xx',
      mensaje: 'no es un UUID',
    }),
    pagos('más de 50 ids', 'adminA', 400, {
      ruta: () =>
        `/v2/orders/payments?ids=${Array.from({ length: 51 }, () => randomUUID()).join(',')}`,
      mensaje: 'entre 1 y 50',
    }),
    pagos('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      ruta: ids('pend'),
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
  ];

  const pago = endpoint<Ctx>(
    'get',
    '/v2/orders/{id}/payment',
    (c) => `/v2/orders/${c.p.pend2}/payment`,
  );
  const casosPago: Array<Caso<Ctx>> = [
    pago('cliente dueño: sin historial', 'clienteA', 200, {
      verificar: (cuerpo, c) => {
        expect(cuerpo).toMatchObject({ orderId: c.p.pend2 });
        expect(cuerpo).not.toHaveProperty('history');
      },
    }),
    pago('administrador: con historial', 'adminA', 200, {
      verificar: (cuerpo) => expect(cuerpo).toHaveProperty('history'),
    }),
    pago('super en modo soporte sobre A', 'soporteA', 200),
    pago('sin token', undefined, 401, sinTokenCliente),
    pago('chofer', 'chofer', 403),
    pago('id mal formado', 'adminA', 400, { ruta: '/v2/orders/xx/payment' }),
    pago('super sin X-Distributor (sin sesión de soporte)', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    pago('inexistente', 'adminA', 404, {
      ruta: (c) => `/v2/orders/${c.inexistente}/payment`,
    }),
    pago('cliente de otro pedido', 'clienteB', 404),
    pago('administrador de otra distribuidora', 'adminB', 404),
    pago('super en modo soporte sobre B', 'soporteB', 404),
  ];

  // ==================================== v2 estadísticas del cliente
  const estadisticas = endpoint<Ctx>(
    'get',
    '/v2/orders/customer/{customerId}/stats',
    (c) => `/v2/orders/customer/${c.clienteA.userId}/stats`,
  );
  const casosEstadisticas: Array<Caso<Ctx>> = [
    estadisticas('administrador', 'adminA', 200, {
      verificar: (cuerpo) => {
        const r = cuerpo as { ordersCount: number; deliveredCount: number };
        expect(r.ordersCount).toBeGreaterThanOrEqual(6);
        expect(r.deliveredCount).toBe(1);
      },
    }),
    estadisticas('super en modo soporte sobre A', 'soporteA', 200),
    estadisticas('administrador de B: ceros', 'adminB', 200, {
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          ordersCount: 0,
          deliveredCount: 0,
          totalPurchased: 0,
          averageTicket: null,
          lastDeliveredAt: null,
        }),
    }),
    estadisticas('sin token', undefined, 401, sinToken),
    estadisticas('cliente', 'clienteA', 403),
    estadisticas('chofer', 'chofer', 403),
    estadisticas('id mal formado', 'adminA', 400, {
      ruta: '/v2/orders/customer/xx/stats',
    }),
    estadisticas(
      'super sin X-Distributor (sin sesión de soporte)',
      'super',
      403,
      { code: 'SUPPORT_SESSION_REQUIRED' },
    ),
  ];

  correrMatriz('GET /orders', ver, conMismaDistribuidora(casosListar));
  correrMatriz('GET /orders/{id}', ver, conMismaDistribuidora(casosUno));
  correrMatriz(
    'GET /orders/{id}/status-history',
    ver,
    conMismaDistribuidora(casosHistorial),
  );
  correrMatriz(
    'GET /orders/{id}/delivery-code',
    ver,
    conMismaDistribuidora(casosCodigo),
  );
  correrMatriz(
    'GET /orders/{id}/driver-photo',
    ver,
    conMismaDistribuidora(casosFoto),
  );
  correrMatriz(
    'GET /orders/customer/{customerId}',
    ver,
    conMismaDistribuidora(casosPorCliente),
  );
  correrMatriz(
    'GET /orders/delivery/{deliveryId}',
    ver,
    conMismaDistribuidora(casosPorChofer),
  );
  correrMatriz(
    'GET /orders/delivery/me/active',
    ver,
    conMismaDistribuidora(casosActivo),
  );
  correrMatriz(
    'GET /orders/available',
    ver,
    conMismaDistribuidora(casosDisponibles),
  );
  correrMatriz(
    'GET /orders/reservations',
    ver,
    conMismaDistribuidora(casosReservas),
  );
  correrMatriz(
    'GET /orders/stats/summary',
    ver,
    conMismaDistribuidora(casosResumen),
  );
  correrMatriz(
    'GET /orders/stats/chart',
    ver,
    conMismaDistribuidora(casosGrafico),
  );
  correrMatriz(
    'GET /v2/orders/payments',
    ver,
    conMismaDistribuidora(casosPagos),
  );
  correrMatriz(
    'GET /v2/orders/{id}/payment',
    ver,
    conMismaDistribuidora(casosPago),
  );
  correrMatriz(
    'GET /v2/orders/customer/{customerId}/stats',
    ver,
    conMismaDistribuidora(casosEstadisticas),
  );
});
