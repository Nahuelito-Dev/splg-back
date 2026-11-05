/**
 * Matriz HTTP T2 (3/3): Ratings. Cada caso es una fila de la tabla (ver
 * `matriz.ts`); el pedido entregado y la calificación que necesita cada caso
 * los arma su `antes`.
 */
import { OrderStatus } from '../../../src/order/entities/order.entity';
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

describe('Matriz HTTP T2: Ratings (e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    ctx = await sembrarBaseT2(env.app, await sembrarEscenario(env.app));
    ctx.reiniciarCupos = () => reiniciarCuposDelThrottler(env);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  const sinToken = { cabeceras: { 'X-Client-Source': 'panel-app' } };

  /** Un pedido entregado de A, listo para calificar. */
  const entregado = (clave: string) => async (c: Ctx) => {
    c.p[clave] = await sembrarPedido(c, { estado: OrderStatus.DELIVERED });
  };
  /** Un pedido entregado de B (cliente y chofer de la otra distribuidora). */
  const entregadoB = (clave: string) => async (c: Ctx) => {
    c.p[clave] = await sembrarPedido(c, {
      estado: OrderStatus.DELIVERED,
      cliente: 'B',
      chofer: 'B',
    });
  };
  /** Califica el pedido como el cliente y guarda el id de la calificación. */
  const calificado =
    (clave: string, oculta = false) =>
    async (c: Ctx) => {
      await entregado(`${clave}-pedido`)(c);
      const r = await llamar(c, 'post', '/ratings', 'clienteA', {
        orderId: c.p[`${clave}-pedido`],
        stars: 4,
        comment: 'Buen servicio',
      });
      c.p[clave] = (r.body as { rating_id: string }).rating_id;
      if (oculta) {
        await llamar(c, 'patch', `/ratings/${c.p[clave]}/hide`, 'adminA', {
          reason: 'Lenguaje ofensivo',
        });
      }
    };
  /** Calificación de un pedido de B, para el aislamiento entre distribuidoras. */
  const calificadoB = (clave: string) => async (c: Ctx) => {
    await entregadoB(`${clave}-pedido`)(c);
    const r = await llamar(c, 'post', '/ratings', 'clienteB', {
      orderId: c.p[`${clave}-pedido`],
      stars: 2,
    });
    c.p[clave] = (r.body as { rating_id: string }).rating_id;
  };

  // ============================================================== POST /ratings
  const crear = endpoint<Ctx>('post', '/ratings', '/ratings');
  const orden = (clave: string) => (c: Ctx) => ({
    orderId: c.p[clave],
    stars: 5,
    comment: 'Todo bien',
  });
  const casosCrear: Array<Caso<Ctx>> = [
    crear('cliente califica al chofer de su pedido', 'clienteA', 201, {
      antes: entregado('c1'),
      body: orden('c1'),
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          order_id: c.p.c1,
          to_user_id: c.choferA.userId,
          from_user_id: c.clienteA.userId,
          from_role: 'customer',
          stars: 5,
          hidden: false,
        }),
    }),
    crear('chofer califica al cliente del pedido que entregó', 'chofer', 201, {
      antes: entregado('c2'),
      body: orden('c2'),
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          to_user_id: c.clienteA.userId,
          from_role: 'delivery',
        }),
    }),
    crear('sin comentario', 'clienteA', 201, {
      antes: entregado('c3'),
      body: (c) => ({ orderId: c.p.c3, stars: 1 }),
    }),
    crear('sin token', undefined, 401, {
      ...sinToken,
      body: (c) => ({ orderId: c.inexistente, stars: 5 }),
    }),
    crear('administrador no califica', 'adminA', 403, {
      antes: entregado('c4'),
      body: orden('c4'),
    }),
    crear('super administrador no califica', 'superEnA', 403, {
      antes: entregado('c5'),
      body: orden('c5'),
    }),
    crear('cliente sobre el pedido de otro cliente', 'clienteB', 403, {
      antes: entregado('c6'),
      body: orden('c6'),
      mensaje: 'No podés calificar un pedido de otro cliente',
    }),
    crear('chofer de otra distribuidora', 'choferB', 403, {
      antes: entregado('c7'),
      body: orden('c7'),
      mensaje: 'No podés calificar un pedido que no entregaste',
    }),
    crear('otro chofer de la misma distribuidora', 'choferA2', 403, {
      antes: entregado('c8'),
      body: orden('c8'),
      mensaje: 'No podés calificar un pedido que no entregaste',
    }),
    crear('pedido todavía pendiente', 'clienteA', 400, {
      antes: async (c) => {
        c.p.c9 = await sembrarPedido(c);
      },
      body: orden('c9'),
      mensaje: 'Solo se puede calificar un pedido entregado',
    }),
    crear('pedido cancelado', 'clienteA', 400, {
      antes: async (c) => {
        c.p.c10 = await sembrarPedido(c, { estado: OrderStatus.CANCELLED });
      },
      body: orden('c10'),
      mensaje: 'Solo se puede calificar un pedido entregado',
    }),
    crear('pedido inexistente', 'clienteA', 404, {
      body: (c) => ({ orderId: c.inexistente, stars: 5 }),
      mensaje: 'Pedido no encontrado',
    }),
    crear('pedido de otra distribuidora', 'clienteA', 403, {
      antes: entregadoB('c11'),
      body: orden('c11'),
    }),
    crear('estrellas en cero', 'clienteA', 400, {
      antes: entregado('c12'),
      body: (c) => ({ orderId: c.p.c12, stars: 0 }),
      mensaje: 'Estrellas',
    }),
    crear('estrellas por encima de 5', 'clienteA', 400, {
      antes: entregado('c13'),
      body: (c) => ({ orderId: c.p.c13, stars: 6 }),
      mensaje: 'Estrellas',
    }),
    crear('estrellas con decimales', 'clienteA', 400, {
      antes: entregado('c14'),
      body: (c) => ({ orderId: c.p.c14, stars: 3.5 }),
      mensaje: 'Estrellas',
    }),
    crear('sin estrellas', 'clienteA', 400, {
      antes: entregado('c15'),
      body: (c) => ({ orderId: c.p.c15 }),
      mensaje: 'Estrellas',
    }),
    crear('comentario de más de 500 caracteres', 'clienteA', 400, {
      antes: entregado('c16'),
      body: (c) => ({ orderId: c.p.c16, stars: 4, comment: 'a'.repeat(501) }),
      mensaje: 'Comentario',
    }),
    crear('comentario que no es texto', 'clienteA', 400, {
      antes: entregado('c17'),
      body: (c) => ({ orderId: c.p.c17, stars: 4, comment: 12 }),
      mensaje: 'Comentario',
    }),
    crear('pedido que no es un UUID', 'clienteA', 400, {
      body: { orderId: 'no-es-uuid', stars: 4 },
      mensaje: 'Pedido',
    }),
    crear('sin pedido', 'clienteA', 400, { body: { stars: 4 } }),
    crear('la misma calificación dos veces', 'clienteA', 409, {
      antes: calificado('c18'),
      body: (c) => ({ orderId: c.p['c18-pedido'], stars: 3 }),
      mensaje: 'Ya calificaste este pedido',
    }),
  ];

  // ====================================================== GET /ratings/{id}
  const ficha = endpoint<Ctx>(
    'get',
    '/ratings/{id}',
    (c) => `/ratings/${c.p.f}`,
  );
  const casosFicha: Array<Caso<Ctx>> = [
    ficha('administrador de la distribuidora', 'adminA', 200, {
      antes: calificado('f'),
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          rating_id: c.p.f,
          distributor_id: c.distA.id,
          stars: 4,
          comment: 'Buen servicio',
        }),
    }),
    ficha('super administrador viendo como A', 'superEnA', 200, {
      antes: calificado('f'),
    }),
    ficha('super administrador sin distribuidora ve todas', 'super', 200, {
      antes: calificado('f'),
    }),
    ficha('una oculta también la ve el administrador', 'adminA', 200, {
      antes: calificado('f', true),
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          hidden: true,
          hiddenReason: 'Lenguaje ofensivo',
        }),
    }),
    ficha('sin token', undefined, 401, {
      ...sinToken,
      ruta: (c) => `/ratings/${c.inexistente}`,
    }),
    ficha('cliente', 'clienteA', 403, { antes: calificado('f') }),
    ficha('chofer', 'chofer', 403, { antes: calificado('f') }),
    ficha('id mal formado', 'adminA', 400, { ruta: '/ratings/xx' }),
    ficha('inexistente', 'adminA', 404, {
      ruta: (c) => `/ratings/${c.inexistente}`,
      mensaje: 'Calificación no encontrada',
    }),
    ficha('de otra distribuidora', 'adminB', 404, {
      antes: calificado('f'),
      mensaje: 'Calificación no encontrada',
    }),
    ficha('super viendo como B la de A', 'superEnB', 404, {
      antes: calificado('f'),
    }),
  ];

  // ============================================== GET /ratings/user/{userId}
  const historial = endpoint<Ctx>(
    'get',
    '/ratings/user/{userId}',
    (c) => `/ratings/user/${c.choferA.userId}`,
  );
  const casosHistorial: Array<Caso<Ctx>> = [
    historial('administrador: trae las del chofer', 'adminA', 200, {
      antes: calificado('h'),
      verificar: (cuerpo, c) => {
        const lista = cuerpo as Array<{
          rating_id: string;
          to_user_id: string;
        }>;
        expect({
          ids: lista.map((r) => r.rating_id),
          todasDelChofer: lista.every((r) => r.to_user_id === c.choferA.userId),
        }).toMatchObject({
          ids: expect.arrayContaining([c.p.h]) as unknown,
          todasDelChofer: true,
        });
      },
    }),
    historial('administrador de B no ve las de un chofer de A', 'adminB', 200, {
      antes: calificado('h'),
      verificar: (cuerpo) => expect(cuerpo).toEqual([]),
    }),
    historial('super sin distribuidora las ve todas', 'super', 200, {
      antes: calificado('h'),
      verificar: (cuerpo, c) =>
        expect(
          (cuerpo as Array<{ rating_id: string }>).map((r) => r.rating_id),
        ).toContain(c.p.h),
    }),
    historial('super viendo como B no ve las de A', 'superEnB', 200, {
      antes: calificado('h'),
      verificar: (cuerpo) => expect(cuerpo).toEqual([]),
    }),
    historial('administrador de A no ve las de un chofer de B', 'adminA', 200, {
      antes: calificadoB('hb'),
      ruta: (c) => `/ratings/user/${c.choferB.userId}`,
      verificar: (cuerpo) => expect(cuerpo).toEqual([]),
    }),
    historial('administrador de B ve las de su chofer', 'adminB', 200, {
      antes: calificadoB('hb'),
      ruta: (c) => `/ratings/user/${c.choferB.userId}`,
      verificar: (cuerpo, c) =>
        expect(
          (cuerpo as Array<{ rating_id: string }>).map((r) => r.rating_id),
        ).toContain(c.p.hb),
    }),
    historial('usuario sin calificaciones', 'adminA', 200, {
      ruta: (c) => `/ratings/user/${c.inexistente}`,
      verificar: (cuerpo) => expect(cuerpo).toEqual([]),
    }),
    historial('sin token', undefined, 401, sinToken),
    historial('cliente', 'clienteA', 403),
    historial('chofer', 'chofer', 403),
    historial('id mal formado', 'adminA', 400, { ruta: '/ratings/user/xx' }),
  ];

  // ====================================== GET /ratings/user/{userId}/summary
  const resumen = endpoint<Ctx>(
    'get',
    '/ratings/user/{userId}/summary',
    (c) => `/ratings/user/${c.choferA.userId}/summary`,
  );
  const casosResumen: Array<Caso<Ctx>> = [
    resumen('administrador: cuenta las visibles', 'adminA', 200, {
      antes: async (c) => {
        await calificado('s1')(c);
        await calificado('s2', true)(c);
      },
      verificar: (cuerpo) => {
        const r = cuerpo as { average: number; count: number };
        expect(r.count).toBeGreaterThanOrEqual(1);
        expect(r.average).toBeGreaterThan(0);
      },
    }),
    resumen('administrador de B ve cero del chofer de A', 'adminB', 200, {
      antes: calificado('s1'),
      verificar: (cuerpo) => expect(cuerpo).toEqual({ average: 0, count: 0 }),
    }),
    resumen('cliente', 'clienteA', 200),
    resumen('chofer', 'chofer', 200),
    resumen('super sin distribuidora', 'super', 200),
    resumen('sin token', undefined, 401, sinToken),
    resumen('id mal formado', 'adminA', 400, {
      ruta: '/ratings/user/xx/summary',
    }),
  ];

  // ============================================ PATCH /ratings/{id}/hide
  const ocultar = endpoint<Ctx>(
    'patch',
    '/ratings/{id}/hide',
    (c) => `/ratings/${c.p.o}/hide`,
  );
  const motivo = { body: { reason: 'Lenguaje ofensivo' } };
  const casosOcultar: Array<Caso<Ctx>> = [
    ocultar('administrador', 'adminA', 200, {
      antes: calificado('o'),
      ...motivo,
      verificar: (cuerpo, c) =>
        expect(cuerpo).toMatchObject({
          rating_id: c.p.o,
          hidden: true,
          hiddenReason: 'Lenguaje ofensivo',
          hiddenByUserId: c.adminA.userId,
        }),
    }),
    ocultar('super viendo como A', 'superEnA', 200, {
      antes: calificado('o'),
      ...motivo,
    }),
    ocultar('sin token', undefined, 401, {
      ...sinToken,
      ruta: (c) => `/ratings/${c.inexistente}/hide`,
      ...motivo,
    }),
    ocultar('cliente', 'clienteA', 403, { antes: calificado('o'), ...motivo }),
    ocultar('chofer', 'chofer', 403, { antes: calificado('o'), ...motivo }),
    ocultar('id mal formado', 'adminA', 400, {
      ruta: '/ratings/xx/hide',
      ...motivo,
    }),
    ocultar('sin motivo', 'adminA', 400, {
      antes: calificado('o'),
      body: {},
      mensaje: 'Motivo',
    }),
    ocultar('motivo en blanco', 'adminA', 400, {
      antes: calificado('o'),
      body: { reason: '   ' },
      mensaje: 'Motivo',
    }),
    ocultar('motivo de más de 500 caracteres', 'adminA', 400, {
      antes: calificado('o'),
      body: { reason: 'a'.repeat(501) },
      mensaje: 'Motivo',
    }),
    ocultar('inexistente', 'adminA', 404, {
      ruta: (c) => `/ratings/${c.inexistente}/hide`,
      ...motivo,
    }),
    ocultar('de otra distribuidora', 'adminB', 404, {
      antes: calificado('o'),
      ...motivo,
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/ratings/${c.p.o}`, 'adminA');
        expect(r.body).toMatchObject({ hidden: false });
      },
    }),
    ocultar('super viendo como B la de A', 'superEnB', 404, {
      antes: calificado('o'),
      ...motivo,
    }),
    ocultar('ya está oculta', 'adminA', 409, {
      antes: calificado('o', true),
      ...motivo,
      mensaje: 'La calificación ya está oculta',
    }),
  ];

  // ========================================== PATCH /ratings/{id}/unhide
  const mostrar = endpoint<Ctx>(
    'patch',
    '/ratings/{id}/unhide',
    (c) => `/ratings/${c.p.u}/unhide`,
  );
  const motivoMostrar = { body: { reason: 'Se revisó y es válida' } };
  const casosMostrar: Array<Caso<Ctx>> = [
    mostrar('administrador', 'adminA', 200, {
      antes: calificado('u', true),
      ...motivoMostrar,
      verificar: (cuerpo) =>
        expect(cuerpo).toMatchObject({
          hidden: false,
          hiddenReason: null,
          hiddenByUserId: null,
        }),
    }),
    mostrar('super viendo como A', 'superEnA', 200, {
      antes: calificado('u', true),
      ...motivoMostrar,
    }),
    mostrar('sin token', undefined, 401, {
      ...sinToken,
      ruta: (c) => `/ratings/${c.inexistente}/unhide`,
      ...motivoMostrar,
    }),
    mostrar('cliente', 'clienteA', 403, {
      antes: calificado('u', true),
      ...motivoMostrar,
    }),
    mostrar('chofer', 'chofer', 403, {
      antes: calificado('u', true),
      ...motivoMostrar,
    }),
    mostrar('id mal formado', 'adminA', 400, {
      ruta: '/ratings/xx/unhide',
      ...motivoMostrar,
    }),
    mostrar('sin motivo', 'adminA', 400, {
      antes: calificado('u', true),
      body: {},
      mensaje: 'Motivo',
    }),
    mostrar('motivo en blanco', 'adminA', 400, {
      antes: calificado('u', true),
      body: { reason: '  ' },
      mensaje: 'Motivo',
    }),
    mostrar('inexistente', 'adminA', 404, {
      ruta: (c) => `/ratings/${c.inexistente}/unhide`,
      ...motivoMostrar,
    }),
    mostrar('de otra distribuidora', 'adminB', 404, {
      antes: calificado('u', true),
      ...motivoMostrar,
      verificar: async (_cuerpo, c) => {
        const r = await llamar(c, 'get', `/ratings/${c.p.u}`, 'adminA');
        expect(r.body).toMatchObject({ hidden: true });
      },
    }),
    mostrar('no está oculta', 'adminA', 409, {
      antes: calificado('u'),
      ...motivoMostrar,
      mensaje: 'La calificación no está oculta',
    }),
  ];

  correrMatriz('POST /ratings', ver, conMismaDistribuidora(casosCrear));
  correrMatriz('GET /ratings/{id}', ver, conMismaDistribuidora(casosFicha));
  correrMatriz(
    'GET /ratings/user/{userId}',
    ver,
    conMismaDistribuidora(casosHistorial),
  );
  correrMatriz(
    'GET /ratings/user/{userId}/summary',
    ver,
    conMismaDistribuidora(casosResumen),
  );
  correrMatriz(
    'PATCH /ratings/{id}/hide',
    ver,
    conMismaDistribuidora(casosOcultar),
  );
  correrMatriz(
    'PATCH /ratings/{id}/unhide',
    ver,
    conMismaDistribuidora(casosMostrar),
  );
});
