import { DataSource } from 'typeorm';
import { RedisService } from '../../../src/redis/redis.service';
import { Order, OrderStatus } from '../../../src/order/entities/order.entity';
import { RouteBatchStatus } from '../../../src/order/entities/route-batch.entity';
import { createTestApp, TestEnv } from '../setup/test-env';
import { Caso, correrMatriz, endpoint, llamar } from './matriz';
import { ZONA_CENTRO, ubicarChofer, usarClave } from './t2-base';
import {
  ADMIN_O_CHOFER,
  EscenarioT5,
  EstadoRendicion,
  SOLO_ADMIN,
  SOLO_CHOFER,
  bordes,
  choferSinPerfil,
  comoChofer,
  hoy,
  marcarChofer,
  nuevoChofer,
  pedidoDe,
  sembrarBaseT5,
  sembrarCarga,
  sembrarLote,
  sembrarRendicion,
  sinCambios,
  sinCambiosEn,
  soltarCerrojo,
  tomarCerrojo,
  vencerDocumento,
} from './t5-base';
import { casosEnModoSoporte } from './soporte';

type C = EscenarioT5;
const ADMIN = 'adminA';
const id = (c: C) => c.p.rendicion ?? c.inexistente;
const lote = (c: C) => c.p.lote ?? c.inexistente;

/** Rendición del estado pedido en `c.p.rendicion` y su chofer en `c.ch.c`. */
const rendicion =
  (estado: EstadoRendicion = 'open', dist: 'A' | 'B' = 'A', declarado = 0) =>
  async (c: C) => {
    const r = await sembrarRendicion(c, { estado, dist, declarado });
    c.p.rendicion = r.settlementId;
    c.ch.c = r.chofer;
  };
const chofer =
  (dist: 'A' | 'B' = 'A') =>
  async (c: C) => {
    c.ch.c = await nuevoChofer(c, { dist });
  };

/** Presentada con un faltante real: un pedido en efectivo entregado y 0 declarado. */
const presentadaConFaltante = async (c: C) => {
  c.ch.c = await nuevoChofer(c, { legajo: true });
  await pedidoDe(c, c.ch.c, OrderStatus.DELIVERED);
  const r = await sembrarRendicion(c, {
    chofer: c.ch.c,
    estado: 'submitted',
    declarado: 0,
  });
  c.p.rendicion = r.settlementId;
};

const listar = endpoint<C>('get', '/driver-settlements', '/driver-settlements');
const abrir = endpoint<C>('post', '/driver-settlements', '/driver-settlements');
const mia = endpoint<C>(
  'get',
  '/driver-settlements/mine',
  '/driver-settlements/mine',
);
const una = endpoint<C>(
  'get',
  '/driver-settlements/{id}',
  (c) => `/driver-settlements/${id(c)}`,
);
const presentar = endpoint<C>(
  'post',
  '/driver-settlements/{id}/submit',
  (c) => `/driver-settlements/${id(c)}/submit`,
);
const aprobar = endpoint<C>(
  'patch',
  '/driver-settlements/{id}/approve',
  (c) => `/driver-settlements/${id(c)}/approve`,
);
const reabrir = endpoint<C>(
  'patch',
  '/driver-settlements/{id}/reopen',
  (c) => `/driver-settlements/${id(c)}/reopen`,
);
const previa = endpoint<C>(
  'post',
  '/v2/driver-settlements/{id}/preview',
  (c) => `/v2/driver-settlements/${id(c)}/preview`,
);

const abrirBody = (c: C, extra: object = {}) => ({
  deliveryId: c.ch.c.deliveryId,
  businessDate: hoy(),
  ...extra,
});
const abrirBad = (nombre: string, extra: (c: C) => object) =>
  abrir(nombre, ADMIN, 400, {
    antes: chofer(),
    body: (c) => abrirBody(c, extra(c)),
  });

const casosAbrir: Array<Caso<C>> = [
  abrir('abre la rendición', ADMIN, 201, {
    antes: chofer(),
    body: abrirBody,
    verificar: (b) =>
      expect(b).toMatchObject({ status: 'open', expectedCash: 0 }),
  }),
  abrir('Idempotency-Key repetida con otro cuerpo', ADMIN, 422, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c);
      c.p.clave = await usarClave(
        c,
        'post',
        '/driver-settlements',
        ADMIN,
        abrirBody(c),
      );
    },
    cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
    body: (c) => abrirBody(c, { businessDate: '2026-01-02' }),
  }),
  abrirBad('chofer falta', () => ({ deliveryId: undefined })),
  abrirBad('chofer no es UUID', () => ({ deliveryId: 'x' })),
  abrirBad('fecha falta', () => ({ businessDate: undefined })),
  abrirBad('fecha con otro formato', () => ({ businessDate: 'hoy' })),
  abrirBad('fecha irreal', () => ({ businessDate: '2026-02-30' })),
  abrirBad('fecha futura', () => ({ businessDate: '2099-01-01' })),
  abrirBad('campo extra', () => ({ ajeno: true })),
  abrir('chofer inexistente', ADMIN, 404, {
    antes: chofer(),
    body: (c) => abrirBody(c, { deliveryId: c.inexistente }),
  }),
  abrir('chofer de otra distribuidora no abre nada', ADMIN, 404, {
    ...sinCambios(
      'driver_settlement',
      'delivery_id',
      (c) => c.ch.c.deliveryId,
      chofer('B'),
    ),
    body: abrirBody,
  }),
  abrir('ya tiene la rendición de ese día', ADMIN, 409, {
    antes: rendicion(),
    body: abrirBody,
    mensaje: /ya tiene la rendición/,
  }),
  abrir('super admin en modo soporte sobre la distribuidora', 'soporteA', 403, {
    antes: chofer(),
    body: abrirBody,
    code: 'SUPPORT_READ_ONLY',
  }),
  abrir('super admin sin distribuidora (sin sesión de soporte)', 'super', 403, {
    antes: chofer(),
    body: abrirBody,
    code: 'SUPPORT_SESSION_REQUIRED',
  }),
  ...bordes(abrir, { prohibidos: SOLO_ADMIN, body: {} }),
];

const casosLecturas: Array<Caso<C>> = [
  listar('tablero de la distribuidora', ADMIN, 200, {
    antes: rendicion(),
    verificar: (b) => expect((b as { total: number }).total).toBeGreaterThan(0),
  }),
  listar('no muestra lo de otra distribuidora', ADMIN, 200, {
    antes: rendicion('open', 'B'),
    verificar: (b, c) =>
      expect(
        (b as { data: Array<{ settlementId: string }> }).data.map(
          (d) => d.settlementId,
        ),
      ).not.toContain(c.p.rendicion),
  }),
  listar('filtra por fecha, estado y chofer', ADMIN, 200, {
    antes: rendicion(),
    ruta: (c) =>
      `/driver-settlements?date=${hoy()}&status=open&deliveryId=${c.ch.c.deliveryId}&limit=5&page=1`,
    verificar: (b, c) =>
      expect(b).toMatchObject({
        total: 1,
        data: [{ settlementId: c.p.rendicion }],
      }),
  }),
  ...(
    [
      ['estado inválido', 'status=otro'],
      ['fecha inválida', 'date=hoy'],
      ['chofer no UUID', 'deliveryId=x'],
      ['limit cero', 'limit=0'],
      ['limit sobre el tope', 'limit=101'],
      ['parámetro extra', 'ajeno=1'],
    ] as const
  ).map(([nombre, q]) =>
    listar(nombre, ADMIN, 400, { ruta: `/driver-settlements?${q}` }),
  ),
  listar(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  ...bordes(listar, { prohibidos: SOLO_ADMIN }),

  mia('la abre si no existe', undefined, 200, {
    antes: chofer(),
    cabeceras: comoChofer,
    verificar: (b) => expect(b).toMatchObject({ status: 'open' }),
  }),
  mia('devuelve la existente', undefined, 200, {
    antes: rendicion(),
    cabeceras: comoChofer,
    verificar: (b, c) =>
      expect(b).toMatchObject({ settlementId: c.p.rendicion }),
  }),
  mia('de otra fecha', undefined, 200, {
    verificar: (b) => expect(b).toMatchObject({ businessDate: '2026-01-02' }),
    antes: chofer(),
    cabeceras: comoChofer,
    ruta: '/driver-settlements/mine?date=2026-01-02',
  }),
  mia('fecha inválida', undefined, 400, {
    antes: chofer(),
    cabeceras: comoChofer,
    ruta: '/driver-settlements/mine?date=hoy',
  }),
  mia('usuario sin perfil de chofer', undefined, 401, {
    antes: async (c) => {
      c.ch.c = await choferSinPerfil(c);
    },
    cabeceras: comoChofer,
  }),
  mia('fecha futura', undefined, 400, {
    antes: chofer(),
    cabeceras: comoChofer,
    ruta: '/driver-settlements/mine?date=2099-01-01',
  }),
  ...bordes(mia, { prohibidos: SOLO_CHOFER }),

  una('administrador', ADMIN, 200, {
    antes: rendicion(),
    verificar: (b, c) =>
      expect(b).toMatchObject({ settlementId: c.p.rendicion }),
  }),
  una('el chofer dueño', undefined, 200, {
    verificar: (b, c) =>
      expect(b).toMatchObject({ settlementId: c.p.rendicion }),
    antes: rendicion(),
    cabeceras: comoChofer,
  }),
  una('otro chofer de la misma distribuidora', 'choferA2', 404, {
    antes: rendicion(),
  }),
  una('inexistente', ADMIN, 404, {
    ruta: (c) => `/driver-settlements/${c.inexistente}`,
  }),
  una('de otra distribuidora', ADMIN, 404, { antes: rendicion('open', 'B') }),
  una('super admin sin distribuidora (sin sesión de soporte)', 'super', 403, {
    antes: rendicion(),
    code: 'SUPPORT_SESSION_REQUIRED',
  }),
  ...bordes(una, {
    prohibidos: ADMIN_O_CHOFER,
    idMalo: '/driver-settlements/no',
  }),
];

const gasto = (c: C, extra: object = {}) => ({
  categoryId: c.gastoA,
  amount: 100,
  ...extra,
});
const presentarBad = (nombre: string, extra: (c: C) => object) =>
  presentar(nombre, ADMIN, 400, {
    antes: rendicion(),
    body: (c) => ({ declaredCash: 10, ...extra(c) }),
  });
const reglasDelEfectivo = (
  ep: typeof presentar,
  antes: (c: C) => Promise<void>,
) => [
  ep('efectivo falta', ADMIN, 400, { antes, body: {} }),
  ep('efectivo negativo', ADMIN, 400, { antes, body: { declaredCash: -1 } }),
  ep('efectivo con más de dos decimales', ADMIN, 400, {
    antes,
    body: { declaredCash: 1.111 },
  }),
  ep('efectivo no es número', ADMIN, 400, {
    antes,
    body: { declaredCash: 'mil' },
  }),
  ep('efectivo sobre el tope', ADMIN, 400, {
    antes,
    body: { declaredCash: 99_999_999_999 },
  }),
];

const casosPresentar: Array<Caso<C>> = [
  presentar('el chofer dueño', undefined, 201, {
    antes: rendicion(),
    cabeceras: comoChofer,
    body: { declaredCash: 10 },
    verificar: (b) =>
      expect(b).toMatchObject({ status: 'submitted', declaredCash: 10 }),
  }),
  presentar('el administrador, con gastos y notas', ADMIN, 201, {
    antes: rendicion(),
    body: (c) => ({
      declaredCash: 10,
      expenses: [gasto(c, { description: 'Carga de nafta' })],
      notes: 'Sin novedad',
    }),
    verificar: (b) => expect(b).toMatchObject({ driverExpenses: 100 }),
  }),
  presentar('cero declarado', ADMIN, 201, {
    verificar: (b) =>
      expect(b).toMatchObject({ status: 'submitted', declaredCash: 0 }),
    antes: rendicion(),
    body: { declaredCash: 0 },
  }),
  ...reglasDelEfectivo(presentar, rendicion()),
  presentarBad('gastos no es lista', () => ({ expenses: 'x' })),
  presentarBad('más de 50 gastos', (c) => ({
    expenses: Array.from({ length: 51 }, () => gasto(c)),
  })),
  presentarBad('gasto sin categoría', (c) => ({
    expenses: [gasto(c, { categoryId: undefined })],
  })),
  presentarBad('categoría no es UUID', (c) => ({
    expenses: [gasto(c, { categoryId: 'x' })],
  })),
  presentarBad('gasto en cero', (c) => ({
    expenses: [gasto(c, { amount: 0 })],
  })),
  presentarBad('gasto con más de dos decimales', (c) => ({
    expenses: [gasto(c, { amount: 1.111 })],
  })),
  presentarBad('descripción vacía', (c) => ({
    expenses: [gasto(c, { description: '  ' })],
  })),
  presentarBad('descripción larga', (c) => ({
    expenses: [gasto(c, { description: 'x'.repeat(256) })],
  })),
  presentarBad('gasto con campo extra', (c) => ({
    expenses: [gasto(c, { ajeno: 1 })],
  })),
  presentarBad('notas vacías', () => ({ notes: '  ' })),
  presentarBad('notas largas', () => ({ notes: 'x'.repeat(501) })),
  presentarBad('campo extra', () => ({ ajeno: 1 })),
  presentarBad('categoría inexistente', (c) => ({
    expenses: [gasto(c, { categoryId: c.inexistente })],
  })),
  presentar('categoría de otra distribuidora no cambia nada', ADMIN, 400, {
    ...sinCambiosEn(
      [
        {
          tabla: 'driver_settlement',
          columna: 'settlement_id',
          id: (c) => c.p.rendicion,
        },
        {
          tabla: 'driver_settlement_expense',
          columna: 'settlement_id',
          id: (c) => c.p.rendicion,
        },
        { tabla: 'cash_category', columna: 'category_id', id: (c) => c.gastoB },
      ],
      rendicion(),
    ),
    body: (c) => ({
      declaredCash: 10,
      expenses: [gasto(c, { categoryId: c.gastoB })],
    }),
  }),
  presentarBad('categoría desactivada', (c) => ({
    expenses: [gasto(c, { categoryId: c.gastoInactivo })],
  })),
  presentarBad('categoría que no es de gastos', (c) => ({
    expenses: [gasto(c, { categoryId: c.ingresoA })],
  })),
  presentar('Idempotency-Key repetida con otro cuerpo', ADMIN, 422, {
    antes: async (c) => {
      await rendicion()(c);
      c.p.clave = await usarClave(
        c,
        'post',
        `/driver-settlements/${c.p.rendicion}/submit`,
        ADMIN,
        { declaredCash: 1 },
      );
    },
    cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
    body: { declaredCash: 2 },
  }),
  presentar('otro chofer de la misma distribuidora', 'choferA2', 404, {
    antes: rendicion(),
    body: { declaredCash: 10 },
  }),
  presentar('inexistente', ADMIN, 404, {
    ruta: (c) => `/driver-settlements/${c.inexistente}/submit`,
    body: { declaredCash: 10 },
  }),
  presentar('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios(
      'driver_settlement',
      'settlement_id',
      (c) => c.p.rendicion,
      rendicion('open', 'B'),
    ),
    body: { declaredCash: 10 },
  }),
  presentar(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    {
      antes: rendicion(),
      body: { declaredCash: 10 },
      code: 'SUPPORT_SESSION_REQUIRED',
    },
  ),
  presentar('ya presentada', ADMIN, 409, {
    antes: rendicion('submitted'),
    body: { declaredCash: 10 },
    mensaje: /sólo se presenta una abierta/,
  }),
  presentar('aprobada', ADMIN, 409, {
    antes: rendicion('approved'),
    body: { declaredCash: 10 },
    mensaje: /sólo se presenta una abierta/,
  }),
  ...bordes(presentar, {
    prohibidos: ADMIN_O_CHOFER,
    body: {},
    idMalo: '/driver-settlements/no/submit',
  }),
];

const aprobarBody = (c: C, extra: object = {}) => ({
  cashBoxId: c.cajaA,
  ...extra,
});
const aprobarBad = (nombre: string, extra: (c: C) => object) =>
  aprobar(nombre, ADMIN, 400, {
    antes: rendicion('submitted'),
    body: (c) => aprobarBody(c, extra(c)),
  });

const casosAprobar: Array<Caso<C>> = [
  aprobar('sin diferencia', ADMIN, 200, {
    antes: rendicion('submitted'),
    body: aprobarBody,
    verificar: (b) =>
      expect(b).toMatchObject({
        status: 'approved',
        differenceResolution: 'none',
      }),
  }),
  aprobar('con sobrante absorbido y efectivo a la caja', ADMIN, 200, {
    antes: rendicion('submitted', 'A', 10),
    body: (c) => aprobarBody(c, { differenceResolution: 'absorbed' }),
    verificar: (b) =>
      expect(b).toMatchObject({
        status: 'approved',
        differenceResolution: 'absorbed',
        cashMovementId: expect.any(String) as string,
      }),
  }),
  aprobar('faltante a cargo del chofer', ADMIN, 200, {
    antes: presentadaConFaltante,
    body: (c) => aprobarBody(c, { differenceResolution: 'charged_to_driver' }),
    verificar: (b) =>
      expect(b).toMatchObject({ differenceResolution: 'charged_to_driver' }),
  }),
  aprobar('faltante a cargo de un chofer sin legajo', ADMIN, 409, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c);
      await pedidoDe(c, c.ch.c, OrderStatus.DELIVERED);
      c.p.rendicion = (
        await sembrarRendicion(c, {
          chofer: c.ch.c,
          estado: 'submitted',
          declarado: 0,
        })
      ).settlementId;
    },
    body: (c) => aprobarBody(c, { differenceResolution: 'charged_to_driver' }),
    mensaje: /no tiene legajo/,
  }),
  aprobarBad('caja falta', () => ({ cashBoxId: undefined })),
  aprobarBad('caja no es UUID', () => ({ cashBoxId: 'x' })),
  aprobarBad('resolución inválida', () => ({ differenceResolution: 'otra' })),
  aprobarBad('notas vacías', () => ({ notes: '  ' })),
  aprobarBad('notas largas', () => ({ notes: 'x'.repeat(501) })),
  aprobarBad('campo extra', () => ({ ajeno: 1 })),
  aprobar('hay diferencia y no se resuelve', ADMIN, 400, {
    antes: rendicion('submitted', 'A', 10),
    body: aprobarBody,
    mensaje: /indicá cómo se resuelve/,
  }),
  aprobar('hay diferencia y se indica none', ADMIN, 400, {
    antes: rendicion('submitted', 'A', 10),
    body: (c) => aprobarBody(c, { differenceResolution: 'none' }),
    mensaje: /indicá cómo se resuelve/,
  }),
  aprobar('sobrante a cargo del chofer', ADMIN, 400, {
    antes: rendicion('submitted', 'A', 10),
    body: (c) => aprobarBody(c, { differenceResolution: 'charged_to_driver' }),
    mensaje: /sobrante no se le descuenta/,
  }),
  aprobar('Idempotency-Key repetida con otro cuerpo', ADMIN, 422, {
    antes: async (c) => {
      await rendicion('submitted')(c);
      c.p.clave = await usarClave(
        c,
        'patch',
        `/driver-settlements/${c.p.rendicion}/approve`,
        ADMIN,
        aprobarBody(c),
      );
    },
    cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
    body: (c) => aprobarBody(c, { notes: 'Otra' }),
  }),
  aprobar('caja inexistente', ADMIN, 404, {
    antes: rendicion('submitted'),
    body: (c) => aprobarBody(c, { cashBoxId: c.inexistente }),
  }),
  aprobar('caja de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambiosEn(
      [
        {
          tabla: 'driver_settlement',
          columna: 'settlement_id',
          id: (c) => c.p.rendicion,
        },
        { tabla: 'cash_box', columna: 'cash_box_id', id: (c) => c.cajaB },
      ],
      rendicion('submitted'),
    ),
    body: (c) => aprobarBody(c, { cashBoxId: c.cajaB }),
  }),
  aprobar('inexistente', ADMIN, 404, {
    ruta: (c) => `/driver-settlements/${c.inexistente}/approve`,
    body: aprobarBody,
  }),
  aprobar('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios(
      'driver_settlement',
      'settlement_id',
      (c) => c.p.rendicion,
      rendicion('submitted', 'B'),
    ),
    body: aprobarBody,
  }),
  aprobar(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    {
      antes: rendicion('submitted'),
      body: aprobarBody,
      code: 'SUPPORT_SESSION_REQUIRED',
    },
  ),
  aprobar('todavía abierta', ADMIN, 409, {
    antes: rendicion(),
    body: aprobarBody,
    mensaje: /sólo se aprueba una presentada/,
  }),
  aprobar('ya aprobada', ADMIN, 409, {
    antes: rendicion('approved'),
    body: aprobarBody,
    mensaje: /sólo se aprueba una presentada/,
  }),
  aprobar('la caja exige sesión y no la tiene', ADMIN, 409, {
    antes: rendicion('submitted', 'A', 10),
    body: (c) =>
      aprobarBody(c, {
        cashBoxId: c.cajaConSesion,
        differenceResolution: 'absorbed',
      }),
    mensaje: /exige una sesión abierta/,
  }),
  aprobar('la caja está desactivada', ADMIN, 409, {
    antes: rendicion('submitted', 'A', 10),
    body: (c) =>
      aprobarBody(c, {
        cashBoxId: c.cajaInactiva,
        differenceResolution: 'absorbed',
      }),
    mensaje: /desactivada/,
  }),
  aprobar('la carga del camión no está cerrada', ADMIN, 409, {
    antes: async (c) => {
      const { chofer: ch } = await sembrarCarga(c, { estado: 'on_route' });
      c.ch.c = ch;
      const r = await sembrarRendicion(c, { chofer: ch, estado: 'submitted' });
      c.p.rendicion = r.settlementId;
    },
    body: aprobarBody,
    mensaje: /carga del camión de este turno/,
  }),
  ...bordes(aprobar, {
    prohibidos: SOLO_ADMIN,
    body: {},
    idMalo: '/driver-settlements/no/approve',
  }),
];

const casosReabrir: Array<Caso<C>> = [
  reabrir('presentada', ADMIN, 200, {
    antes: rendicion('submitted'),
    verificar: (b) =>
      expect(b).toMatchObject({ status: 'open', declaredCash: null }),
  }),
  reabrir('inexistente', ADMIN, 404, {
    ruta: (c) => `/driver-settlements/${c.inexistente}/reopen`,
  }),
  reabrir('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios(
      'driver_settlement',
      'settlement_id',
      (c) => c.p.rendicion,
      rendicion('submitted', 'B'),
    ),
  }),
  reabrir(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { antes: rendicion('submitted'), code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  reabrir('abierta', ADMIN, 409, {
    antes: rendicion(),
    mensaje: /sólo se reabre una presentada/,
  }),
  reabrir('aprobada', ADMIN, 409, {
    antes: rendicion('approved'),
    mensaje: /sólo se reabre una presentada/,
  }),
  ...bordes(reabrir, {
    prohibidos: SOLO_ADMIN,
    idMalo: '/driver-settlements/no/reopen',
  }),
];

const casosPrevia: Array<Caso<C>> = [
  previa('el chofer dueño', undefined, 200, {
    antes: rendicion(),
    cabeceras: comoChofer,
    body: { declaredCash: 10, expenses: [{ amount: 5 }] },
    verificar: (b) =>
      expect(b).toMatchObject({
        expectedCash: 0,
        declaredCash: 10,
        driverExpenses: 5,
        difference: 15,
      }),
  }),
  previa('el administrador, sin escribir nada', ADMIN, 200, {
    ...sinCambios(
      'driver_settlement',
      'settlement_id',
      (c) => c.p.rendicion,
      rendicion(),
    ),
    body: { declaredCash: 10 },
  }),
  ...reglasDelEfectivo(previa as unknown as typeof presentar, rendicion()),
  previa('gastos no es lista', ADMIN, 400, {
    antes: rendicion(),
    body: { declaredCash: 1, expenses: 'x' },
  }),
  previa('más de 50 gastos', ADMIN, 400, {
    antes: rendicion(),
    body: {
      declaredCash: 1,
      expenses: Array.from({ length: 51 }, () => ({ amount: 1 })),
    },
  }),
  previa('gasto en cero', ADMIN, 400, {
    antes: rendicion(),
    body: { declaredCash: 1, expenses: [{ amount: 0 }] },
  }),
  previa('gasto con más de dos decimales', ADMIN, 400, {
    antes: rendicion(),
    body: { declaredCash: 1, expenses: [{ amount: 1.111 }] },
  }),
  previa('gasto con campo extra', ADMIN, 400, {
    antes: rendicion(),
    body: { declaredCash: 1, expenses: [{ amount: 1, ajeno: 1 }] },
  }),
  previa('campo extra', ADMIN, 400, {
    antes: rendicion(),
    body: { declaredCash: 1, ajeno: 1 },
  }),
  previa('otro chofer de la misma distribuidora', 'choferA2', 404, {
    antes: rendicion(),
    body: { declaredCash: 1 },
  }),
  previa('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/driver-settlements/${c.inexistente}/preview`,
    body: { declaredCash: 1 },
  }),
  previa('de otra distribuidora', ADMIN, 404, {
    antes: rendicion('open', 'B'),
    body: { declaredCash: 1 },
  }),
  previa(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    {
      antes: rendicion(),
      body: { declaredCash: 1 },
      code: 'SUPPORT_SESSION_REQUIRED',
    },
  ),
  previa('presentada', ADMIN, 409, {
    antes: rendicion('submitted'),
    body: { declaredCash: 1 },
    mensaje: /sólo se presenta una abierta/,
  }),
  previa('aprobada', ADMIN, 409, {
    antes: rendicion('approved'),
    body: { declaredCash: 1 },
    mensaje: /sólo se presenta una abierta/,
  }),
  ...bordes(previa, {
    prohibidos: ADMIN_O_CHOFER,
    body: {},
    idMalo: '/v2/driver-settlements/no/preview',
  }),
];

// --- Recorridos ---

const PARAMETROS_NUEVOS = {
  maxBatchSize: 4,
  groupingRadiusKm: 3.5,
  slotToleranceMinutes: 60,
  offerTtlSeconds: 60,
  evaluationFrequencyMinutes: 15,
  batchingHoldMinutes: 60,
};
const guardarParametros = async (c: C) => {
  const res = await llamar(c, 'get', '/v2/route-batches/settings', ADMIN);
  c.foto.params = JSON.stringify((res.body as { params: object }).params);
};
const restaurarParametros = async (c: C) => {
  const res = await llamar(
    c,
    'patch',
    '/v2/route-batches/settings',
    ADMIN,
    JSON.parse(c.foto.params) as object,
  );
  if (res.status !== 200) {
    throw new Error(`No se restauraron los parámetros (${res.status})`);
  }
};

const parametros = (c: C, enabled: 0 | 1) =>
  llamar(c, 'patch', '/v2/route-batches/settings', ADMIN, { enabled });

const lotes = endpoint<C>('get', '/v2/route-batches', '/v2/route-batches');
const ajustes = endpoint<C>(
  'get',
  '/v2/route-batches/settings',
  '/v2/route-batches/settings',
);
const cambiar = endpoint<C>(
  'patch',
  '/v2/route-batches/settings',
  '/v2/route-batches/settings',
);
const armar = endpoint<C>(
  'post',
  '/v2/route-batches/run',
  '/v2/route-batches/run',
);
const unLote = endpoint<C>(
  'get',
  '/v2/route-batches/{id}',
  (c) => `/v2/route-batches/${lote(c)}`,
);
const deshacer = endpoint<C>(
  'post',
  '/v2/route-batches/{id}/dissolve',
  (c) => `/v2/route-batches/${lote(c)}/dissolve`,
);
const misLotes = endpoint<C>(
  'get',
  '/v2/driver/route-batches',
  '/v2/driver/route-batches',
);
const miLote = endpoint<C>(
  'get',
  '/v2/driver/route-batches/{id}',
  (c) => `/v2/driver/route-batches/${lote(c)}`,
);
const aceptar = endpoint<C>(
  'post',
  '/v2/driver/route-batches/{id}/accept',
  (c) => `/v2/driver/route-batches/${lote(c)}/accept`,
);
const rechazar = endpoint<C>(
  'post',
  '/v2/driver/route-batches/{id}/reject',
  (c) => `/v2/driver/route-batches/${lote(c)}/reject`,
);

/** Lote ofrecido al chofer del caso, en `c.p.lote`. */
const ofrecido =
  (o: Partial<Parameters<typeof sembrarLote>[1]> = {}) =>
  async (c: C) => {
    c.ch.c = await nuevoChofer(c, { dist: o?.dist });
    const r = await sembrarLote(c, { ofrecidoA: c.ch.c, ...o });
    c.p.lote = r.batchId;
    c.p.pedido0 = r.pedidos[0];
    c.p.pedido1 = r.pedidos[1];
  };
const asignado = (estado: RouteBatchStatus) => async (c: C) => {
  c.ch.c = await nuevoChofer(c);
  const r = await sembrarLote(c, { estado, chofer: c.ch.c });
  c.p.lote = r.batchId;
};
const motivoDe = async (c: C) =>
  (
    await c.app
      .get(DataSource)
      .query<
        Array<{ close_reason: string }>
      >(`SELECT close_reason FROM route_batch WHERE batch_id = $1`, [c.p.lote])
  )[0].close_reason;
const estadoDe = async (c: C) =>
  (
    await c.app
      .get(DataSource)
      .query<
        Array<{ status: string }>
      >(`SELECT status FROM route_batch WHERE batch_id = $1`, [c.p.lote])
  )[0].status;
const reglaInt = (
  campo: string,
  fuera: number,
  decimal: number | null = null,
): Array<Caso<C>> => [
  cambiar(`${campo} fuera de rango`, ADMIN, 400, {
    body: { [campo]: fuera },
  }),
  cambiar(`${campo} no es número`, ADMIN, 400, { body: { [campo]: 'x' } }),
  ...(decimal !== null
    ? [
        cambiar(`${campo} no es entero`, ADMIN, 400, {
          body: { [campo]: decimal },
        }),
      ]
    : []),
];

function comprobarSoloOfrecidos(b: unknown, c: C): void {
  const { data } = b as { data: Array<{ batchId: string; status: string }> };
  expect(data.map((d) => d.batchId)).toContain(c.p.lote);
  expect(data.map((d) => d.batchId)).not.toContain(c.p.loteDisuelto);
  expect(new Set(data.map((d) => d.status))).toEqual(new Set(['offered']));
}

const casosRecorridosAdmin: Array<Caso<C>> = [
  lotes('lista vacía o con lotes', ADMIN, 200, {
    verificar: (b) => expect(b).toHaveProperty('counts'),
  }),
  lotes('filtra por estado', ADMIN, 200, {
    antes: async (c) => {
      await ofrecido()(c);
      c.p.loteDisuelto = (
        await sembrarLote(c, { estado: RouteBatchStatus.DISSOLVED })
      ).batchId;
    },
    ruta: '/v2/route-batches?status=offered&limit=100&offset=0',
    verificar: comprobarSoloOfrecidos,
  }),
  lotes('no muestra lo de otra distribuidora', ADMIN, 200, {
    antes: async (c) => {
      c.p.lote = (await sembrarLote(c, { dist: 'B' })).batchId;
    },
    verificar: (b, c) =>
      expect(
        (b as { data: Array<{ batchId: string }> }).data.map((d) => d.batchId),
      ).not.toContain(c.p.lote),
  }),
  ...(
    [
      ['estado inválido', 'status=otro'],
      ['limit cero', 'limit=0'],
      ['limit sobre el tope', 'limit=101'],
      ['offset negativo', 'offset=-1'],
      ['parámetro extra', 'ajeno=1'],
    ] as const
  ).map(([nombre, q]) =>
    lotes(nombre, ADMIN, 400, { ruta: `/v2/route-batches?${q}` }),
  ),
  lotes('super admin sin distribuidora (sin sesión de soporte)', 'super', 403, {
    code: 'SUPPORT_SESSION_REQUIRED',
  }),
  ...bordes(lotes, { prohibidos: SOLO_ADMIN }),

  ajustes('consulta', ADMIN, 200, {
    verificar: (b) => expect(b).toHaveProperty('params.maxBatchSize'),
  }),
  ajustes(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  ...bordes(ajustes, { prohibidos: SOLO_ADMIN }),

  cambiar('cambia todos los que vienen', ADMIN, 200, {
    antes: guardarParametros,
    body: PARAMETROS_NUEVOS,
    verificar: async (b, c) => {
      expect(b).toMatchObject({ params: PARAMETROS_NUEVOS });
      await restaurarParametros(c);
    },
  }),
  cambiar('cambia sólo lo enviado', ADMIN, 200, {
    antes: guardarParametros,
    body: { maxBatchSize: 7 },
    verificar: async (b, c) => {
      expect((b as { params: object }).params).toEqual({
        ...(JSON.parse(c.foto.params) as object),
        maxBatchSize: 7,
      });
      await restaurarParametros(c);
    },
  }),
  cambiar('cuerpo vacío conserva todo', ADMIN, 200, {
    antes: guardarParametros,
    body: {},
    verificar: (b, c) =>
      expect((b as { params: object }).params).toEqual(
        JSON.parse(c.foto.params),
      ),
  }),
  ...reglaInt('maxBatchSize', 1, 2.5),
  ...reglaInt('maxBatchSize', 21),
  ...reglaInt('groupingRadiusKm', 0.1),
  ...reglaInt('groupingRadiusKm', 51),
  ...reglaInt('slotToleranceMinutes', -1, 1.5),
  ...reglaInt('slotToleranceMinutes', 481),
  ...reglaInt('offerTtlSeconds', 9, 10.5),
  ...reglaInt('offerTtlSeconds', 601),
  ...reglaInt('evaluationFrequencyMinutes', 0, 1.5),
  ...reglaInt('evaluationFrequencyMinutes', 1441),
  ...reglaInt('enabled', -1, 0.5),
  ...reglaInt('enabled', 2),
  ...reglaInt('batchingHoldMinutes', -1, 1.5),
  ...reglaInt('batchingHoldMinutes', 721),
  cambiar('campo extra', ADMIN, 400, { body: { ajeno: 1 } }),
  cambiar(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { body: {}, code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  ...bordes(cambiar, { prohibidos: SOLO_ADMIN, body: {} }),

  armar('módulo apagado', ADMIN, 409, {
    antes: async (c) => {
      await parametros(c, 0);
    },
    mensaje: /está apagada/,
  }),
  armar('módulo encendido', ADMIN, 201, {
    antes: async (c) => {
      await parametros(c, 1);
    },
    verificar: async (_b, c) => {
      await parametros(c, 0);
    },
  }),
  armar('ya se están armando los lotes', ADMIN, 409, {
    antes: async (c) => {
      await parametros(c, 1);
      await tomarCerrojo(c.env, `route-batch:evaluar:${c.distA.id}`);
    },
    mensaje: /Ya se están armando/,
    verificar: async (_b, c) => {
      await soltarCerrojo(c.env, `route-batch:evaluar:${c.distA.id}`);
      await parametros(c, 0);
    },
  }),
  armar('super admin sin distribuidora (sin sesión de soporte)', 'super', 403, {
    code: 'SUPPORT_SESSION_REQUIRED',
  }),
  ...bordes(armar, { prohibidos: SOLO_ADMIN }),

  unLote('administrador', ADMIN, 200, {
    antes: ofrecido(),
    verificar: (b, c) =>
      expect(b).toMatchObject({ batchId: c.p.lote, status: 'offered' }),
  }),
  unLote('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/route-batches/${c.inexistente}`,
  }),
  unLote('de otra distribuidora', ADMIN, 404, {
    antes: async (c) => {
      c.p.lote = (await sembrarLote(c, { dist: 'B' })).batchId;
    },
  }),
  unLote(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { antes: ofrecido(), code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  ...bordes(unLote, { prohibidos: SOLO_ADMIN, idMalo: '/v2/route-batches/no' }),

  deshacer('ofrecido', ADMIN, 201, {
    antes: ofrecido(),
    verificar: async (b, c) => {
      expect(b).toMatchObject({ batchId: c.p.lote, status: 'dissolved' });
      expect(await estadoDe(c)).toBe('dissolved');
    },
  }),
  deshacer('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/route-batches/${c.inexistente}/dissolve`,
  }),
  deshacer('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios(
      'route_batch',
      'batch_id',
      (c) => c.p.lote,
      async (c) => {
        c.p.lote = (await sembrarLote(c, { dist: 'B' })).batchId;
      },
    ),
  }),
  deshacer(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { antes: ofrecido(), code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  deshacer('ya tiene chofer', ADMIN, 409, {
    antes: asignado(RouteBatchStatus.ASSIGNED),
    mensaje: /todavía no tiene chofer/,
  }),
  deshacer('ya se deshizo', ADMIN, 409, {
    antes: async (c) => {
      c.p.lote = (
        await sembrarLote(c, { estado: RouteBatchStatus.DISSOLVED })
      ).batchId;
    },
    mensaje: /todavía no tiene chofer/,
  }),
  deshacer('completado', ADMIN, 409, {
    antes: asignado(RouteBatchStatus.COMPLETED),
    mensaje: /todavía no tiene chofer/,
  }),
  deshacer('el lote se está procesando', ADMIN, 409, {
    antes: async (c) => {
      await ofrecido()(c);
      await tomarCerrojo(c.env, `route-batch:${c.p.lote}`);
    },
    mensaje: /se está procesando/,
    verificar: async (_b, c) => soltarCerrojo(c.env, `route-batch:${c.p.lote}`),
  }),
  ...bordes(deshacer, {
    prohibidos: SOLO_ADMIN,
    idMalo: '/v2/route-batches/no/dissolve',
  }),
];

const casosRecorridosChofer: Array<Caso<C>> = [
  misLotes('sin lotes', undefined, 200, {
    verificar: (b) => expect(b).toMatchObject({ data: [], total: 0 }),
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c);
    },
    cabeceras: comoChofer,
  }),
  misLotes('con una oferta vigente', undefined, 200, {
    antes: ofrecido(),
    cabeceras: comoChofer,
    verificar: (b, c) =>
      expect(b).toMatchObject({ data: [{ batchId: c.p.lote }] }),
  }),
  ...(
    [
      ['limit cero', 'limit=0'],
      ['limit sobre el tope', 'limit=101'],
      ['offset negativo', 'offset=-1'],
      ['parámetro extra', 'ajeno=1'],
    ] as const
  ).map(([nombre, q]) =>
    misLotes(nombre, 'chofer', 400, { ruta: `/v2/driver/route-batches?${q}` }),
  ),
  ...bordes(misLotes, { prohibidos: SOLO_CHOFER }),

  miLote('ofrecido a mí', undefined, 200, {
    antes: ofrecido(),
    cabeceras: comoChofer,
    verificar: (b, c) => expect(b).toMatchObject({ batchId: c.p.lote }),
  }),
  miLote('asignado a mí', undefined, 200, {
    verificar: (b, c) => expect(b).toMatchObject({ batchId: c.p.lote }),
    antes: asignado(RouteBatchStatus.ASSIGNED),
    cabeceras: comoChofer,
  }),
  miLote('ofrecido a otro chofer', 'choferA2', 404, { antes: ofrecido() }),
  miLote('de otra distribuidora', 'choferA2', 404, {
    antes: ofrecido({ dist: 'B' }),
  }),
  miLote('inexistente', 'chofer', 404, {
    ruta: (c) => `/v2/driver/route-batches/${c.inexistente}`,
  }),
  ...bordes(miLote, {
    prohibidos: SOLO_CHOFER,
    idMalo: '/v2/driver/route-batches/no',
    idMaloActor: 'chofer',
  }),

  aceptar('asigna los pedidos', undefined, 201, {
    antes: ofrecido(),
    cabeceras: comoChofer,
    verificar: async (b, c) => {
      expect(b).toMatchObject({ accepted: true, assignedOrders: 2 });
      expect(await estadoDe(c)).toBe('assigned');
      const pedidos = await c.app
        .get(DataSource)
        .getRepository(Order)
        .findBy([{ orderId: c.p.pedido0 }, { orderId: c.p.pedido1 }]);
      expect(pedidos.map((p) => p.deliveryId)).toEqual([
        c.ch.c.deliveryId,
        c.ch.c.deliveryId,
      ]);
    },
  }),
  aceptar('repetida: mismo resultado', undefined, 201, {
    antes: asignado(RouteBatchStatus.ASSIGNED),
    cabeceras: comoChofer,
    verificar: (b) => expect(b).toMatchObject({ accepted: true }),
  }),
  aceptar('chofer deshabilitado', undefined, 400, {
    antes: async (c) => {
      await ofrecido()(c);
      await marcarChofer(c, c.ch.c.deliveryId, { isEnabled: false });
    },
    cabeceras: comoChofer,
    mensaje: /deshabilitado/,
  }),
  aceptar('chofer sin validar', undefined, 400, {
    antes: async (c) => {
      await ofrecido()(c);
      await marcarChofer(c, c.ch.c.deliveryId, { validated: false });
    },
    cabeceras: comoChofer,
    mensaje: /no está validado/,
  }),
  aceptar('chofer con la licencia vencida', undefined, 400, {
    antes: async (c) => {
      await ofrecido()(c);
      await vencerDocumento(c, { deliveryId: c.ch.c.deliveryId });
    },
    cabeceras: comoChofer,
  }),
  aceptar('oferta vencida', undefined, 409, {
    antes: ofrecido({ vencida: true }),
    cabeceras: comoChofer,
    mensaje: /venció/,
  }),
  aceptar('ofrecido a otro chofer', 'choferA2', 409, {
    antes: ofrecido(),
    mensaje: /ya no está vigente/,
  }),
  aceptar('asignado a otro chofer', 'choferA2', 409, {
    antes: asignado(RouteBatchStatus.ASSIGNED),
    mensaje: /ya no está vigente/,
  }),
  aceptar('el vehículo no carga el peso', undefined, 409, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c, { capacidad: 1 });
      c.p.lote = (
        await sembrarLote(c, { ofrecidoA: c.ch.c, peso: 500 })
      ).batchId;
    },
    cabeceras: comoChofer,
    mensaje: /no carga el peso/,
  }),
  aceptar('los pedidos ya no están disponibles', undefined, 409, {
    antes: ofrecido({ pedidosCancelados: true }),
    cabeceras: comoChofer,
    mensaje: /ya no están disponibles/,
    verificar: async (_b, c) => expect(await estadoDe(c)).toBe('dissolved'),
  }),
  aceptar('el lote se está procesando', undefined, 409, {
    antes: async (c) => {
      await ofrecido()(c);
      await tomarCerrojo(c.env, `route-batch:${c.p.lote}`);
    },
    cabeceras: comoChofer,
    mensaje: /se está procesando/,
    verificar: async (_b, c) => soltarCerrojo(c.env, `route-batch:${c.p.lote}`),
  }),
  aceptar('inexistente', 'chofer', 404, {
    ruta: (c) => `/v2/driver/route-batches/${c.inexistente}/accept`,
  }),
  aceptar('de otra distribuidora no cambia nada', 'choferA2', 404, {
    ...sinCambios(
      'route_batch',
      'batch_id',
      (c) => c.p.lote,
      ofrecido({ dist: 'B' }),
    ),
  }),
  ...bordes(aceptar, {
    prohibidos: SOLO_CHOFER,
    idMalo: '/v2/driver/route-batches/no/accept',
    idMaloActor: 'chofer',
  }),

  rechazar(
    'módulo encendido y sin siguiente chofer: se agota',
    undefined,
    201,
    {
      antes: async (c) => {
        await parametros(c, 1);
        await ofrecido()(c);
      },
      cabeceras: comoChofer,
      verificar: async (b, c) => {
        expect(b).toMatchObject({ accepted: false, assignedOrders: 0 });
        expect(await estadoDe(c)).toBe('dissolved');
        expect(await motivoDe(c)).toBe('exhausted');
        await parametros(c, 0);
      },
    },
  ),
  rechazar('módulo encendido: pasa al siguiente chofer', undefined, 201, {
    antes: async (c) => {
      await parametros(c, 1);
      await ofrecido()(c);
      c.ch.siguiente = await nuevoChofer(c);
      await ubicarChofer(c.app, c.ch.siguiente.userId, ZONA_CENTRO);
    },
    cabeceras: comoChofer,
    verificar: async (b, c) => {
      expect(b).toMatchObject({ accepted: false });
      expect(await estadoDe(c)).toBe('offered');
      const [oferta] = await c.app
        .get(DataSource)
        .query<
          Array<{ delivery_id: string }>
        >(`SELECT delivery_id FROM route_batch_offer WHERE batch_id = $1 AND status = 'pending'`, [c.p.lote]);
      expect(oferta.delivery_id).toBe(c.ch.siguiente.deliveryId);
      await c.app.get(RedisService).removeDriver(c.ch.siguiente.userId);
      await parametros(c, 0);
    },
  }),
  rechazar('módulo encendido con pedidos que ya no están', undefined, 201, {
    antes: async (c) => {
      await parametros(c, 1);
      await ofrecido({ pedidosCancelados: true })(c);
    },
    cabeceras: comoChofer,
    verificar: async (_b, c) => {
      expect(await motivoDe(c)).toBe('orders_unavailable');
      await parametros(c, 0);
    },
  }),
  rechazar('módulo apagado: se deshace', undefined, 201, {
    antes: async (c) => {
      await parametros(c, 0);
      await ofrecido()(c);
    },
    cabeceras: comoChofer,
    verificar: async (_b, c) => expect(await motivoDe(c)).toBe('admin'),
  }),
  rechazar('ofrecido a otro chofer', 'choferA2', 409, {
    antes: ofrecido(),
    mensaje: /ya no está vigente/,
  }),
  rechazar('ya respondido', undefined, 409, {
    antes: async (c) => {
      await parametros(c, 0);
      await ofrecido()(c);
      await llamarComoChofer(c, 'reject');
    },
    cabeceras: comoChofer,
    mensaje: /ya no está vigente/,
  }),
  rechazar('el lote se está procesando', undefined, 409, {
    antes: async (c) => {
      await ofrecido()(c);
      await tomarCerrojo(c.env, `route-batch:${c.p.lote}`);
    },
    cabeceras: comoChofer,
    mensaje: /se está procesando/,
    verificar: async (_b, c) => soltarCerrojo(c.env, `route-batch:${c.p.lote}`),
  }),
  rechazar('inexistente', 'chofer', 404, {
    ruta: (c) => `/v2/driver/route-batches/${c.inexistente}/reject`,
  }),
  rechazar('de otra distribuidora no cambia nada', 'choferA2', 404, {
    ...sinCambios(
      'route_batch',
      'batch_id',
      (c) => c.p.lote,
      ofrecido({ dist: 'B' }),
    ),
  }),
  ...bordes(rechazar, {
    prohibidos: SOLO_CHOFER,
    idMalo: '/v2/driver/route-batches/no/reject',
    idMaloActor: 'chofer',
  }),
];

/** Rechaza con el chofer del caso (sin pasar por la tabla `actores`). */
async function llamarComoChofer(c: C, accion: 'reject' | 'accept') {
  c.actores.choferDelCaso = c.ch.c.cabeceras;
  const res = await llamar(
    c,
    'post',
    `/v2/driver/route-batches/${c.p.lote}/${accion}`,
    'choferDelCaso',
    undefined,
  );
  if (res.status >= 300) {
    throw new Error(`No se pudo responder el lote (${res.status})`);
  }
}

/** Matriz T5: rendiciones y lotes de recorrido. */
describe('Matriz HTTP T5: rendiciones y recorridos (e2e)', () => {
  let env: TestEnv;
  let ctx: C;
  beforeAll(async () => {
    env = await createTestApp();
    ctx = await sembrarBaseT5(env);
  }, 240000);
  afterAll(async () => env.cleanup());
  const ver = () => ctx;

  // Modo soporte: con sesión lee lo de su empresa y no escribe; sin sesión, nada.
  correrMatriz(
    'super admin en modo soporte',
    ver,
    casosEnModoSoporte(listar, abrir),
  );
  correrMatriz('abrir rendición', ver, casosAbrir);
  correrMatriz('lecturas de rendiciones', ver, casosLecturas);
  correrMatriz('presentar', ver, casosPresentar);
  correrMatriz('aprobar', ver, casosAprobar);
  correrMatriz('reabrir', ver, casosReabrir);
  correrMatriz('vista previa', ver, casosPrevia);
  correrMatriz('recorridos del administrador', ver, casosRecorridosAdmin);
  correrMatriz('recorridos del chofer', ver, casosRecorridosChofer);
});
