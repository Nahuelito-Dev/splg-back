import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { VehicleAssignment } from '../../../src/car/entities/vehicle-assignment.entity';
import { OrderStatus } from '../../../src/order/entities/order.entity';
import { StockLedgerPort } from '../../../src/stock/domain/ports/stock-ledger.port';
import { StockLocationService } from '../../../src/stock/application/stock-location.service';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../../src/stock/domain/stock.enums';
import { createTestApp, TestEnv } from '../setup/test-env';
import { Caso, correrMatriz, endpoint, llamar } from './matriz';
import { usarClave } from './t2-base';
import {
  ADMIN_O_CHOFER,
  EscenarioT5,
  abrirCargaCon,
  EstadoCarga,
  SOLO_ADMIN,
  bordes,
  choferSinPerfil,
  comoChofer,
  entregar,
  garrafasNuevas,
  hoy,
  nuevoChofer,
  pedidoDe,
  sembrarBaseT5,
  sembrarCarga,
  sinCambios,
  sinCambiosEn,
} from './t5-base';
import { casosEnModoSoporte } from './soporte';

type C = EscenarioT5;
const ADMIN = 'adminA';
const conClave = () => ({ 'Idempotency-Key': randomUUID() });
const OTROS_ESTADOS = (excepto: EstadoCarga[]): EstadoCarga[] =>
  (
    [
      'loading',
      'on_route',
      'returned',
      'closed',
      'closed_with_difference',
      'cancelled',
    ] as EstadoCarga[]
  ).filter((e) => !excepto.includes(e));

/** Prepara una carga (y su chofer) del estado pedido en `c.p.carga` / `c.ch.c`. */
const carga =
  (estado: EstadoCarga = 'loading', dist: 'A' | 'B' = 'A') =>
  async (c: C) => {
    const r = await sembrarCarga(c, { estado, dist });
    c.p.carga = r.loadId;
    c.ch.c = r.chofer;
  };
const chofer =
  (dist: 'A' | 'B' = 'A') =>
  async (c: C) => {
    c.ch.c = await nuevoChofer(c, { dist });
  };
const id = (c: C) => c.p.carga ?? c.inexistente;
const devuelta = (c: C, llenas = 5) => ({
  items: [
    { gasCylinderId: c.garrafaA, declaredFull: llenas, declaredEmpty: 0 },
  ],
});

/** Las reglas del renglón de carga, comunes a abrir y a reemplazar. */
function reglasDeRenglon(
  ep: ReturnType<typeof endpoint<C>>,
  antes: (c: C) => Promise<void>,
  cuerpo: (c: C, items: unknown) => object,
): Array<Caso<C>> {
  const item = (c: C, extra: object) => ({
    gasCylinderId: c.garrafaA,
    loadedFull: 1,
    ...extra,
  });
  const con = (nombre: string, items: (c: C) => unknown) =>
    ep(nombre, ADMIN, 400, { antes, body: (c) => cuerpo(c, items(c)) });
  return [
    con('items falta', () => undefined),
    con('items no es lista', () => 'x'),
    con('items vacío', () => []),
    con('más de 20 renglones', (c) =>
      Array.from({ length: 21 }, () => item(c, {})),
    ),
    con('renglón con campo extra', (c) => [item(c, { ajeno: 1 })]),
    con('garrafa falta', (c) => [item(c, { gasCylinderId: undefined })]),
    con('garrafa no es UUID', (c) => [item(c, { gasCylinderId: 'x' })]),
    con('llenas falta', (c) => [item(c, { loadedFull: undefined })]),
    con('llenas no es entero', (c) => [item(c, { loadedFull: 1.5 })]),
    con('llenas negativas', (c) => [item(c, { loadedFull: -1 })]),
    con('llenas sobre el tope', (c) => [item(c, { loadedFull: 2001 })]),
    con('vacías no es entero', (c) => [item(c, { loadedEmpty: 1.5 })]),
    con('vacías negativas', (c) => [item(c, { loadedEmpty: -1 })]),
    con('vacías sobre el tope', (c) => [item(c, { loadedEmpty: 2001 })]),
    con('garrafa repetida', (c) => [item(c, {}), item(c, {})]),
  ];
}

const mine = endpoint<C>('get', '/truck-loads/mine', '/truck-loads/mine');
const settings = endpoint<C>(
  'get',
  '/truck-loads/settings',
  '/truck-loads/settings',
);
const settingsPut = endpoint<C>(
  'put',
  '/truck-loads/settings',
  '/truck-loads/settings',
);
const stock = endpoint<C>(
  'get',
  '/truck-loads/cars/{carId}/stock',
  (c) => `/truck-loads/cars/${c.autoA}/stock`,
);
const crear = endpoint<C>('post', '/truck-loads', '/truck-loads');
const listar = endpoint<C>('get', '/truck-loads', '/truck-loads');
const una = endpoint<C>(
  'get',
  '/truck-loads/{id}',
  (c) => `/truck-loads/${id(c)}`,
);
const items = endpoint<C>(
  'put',
  '/truck-loads/{id}/items',
  (c) => `/truck-loads/${id(c)}/items`,
);
const salir = endpoint<C>(
  'patch',
  '/truck-loads/{id}/depart',
  (c) => `/truck-loads/${id(c)}/depart`,
);
const reponer = endpoint<C>(
  'patch',
  '/truck-loads/{id}/reload',
  (c) => `/truck-loads/${id(c)}/reload`,
);
const volver = endpoint<C>(
  'patch',
  '/truck-loads/{id}/return',
  (c) => `/truck-loads/${id(c)}/return`,
);
const cerrar = endpoint<C>(
  'patch',
  '/truck-loads/{id}/close',
  (c) => `/truck-loads/${id(c)}/close`,
);
const cancelar = endpoint<C>(
  'patch',
  '/truck-loads/{id}/cancel',
  (c) => `/truck-loads/${id(c)}/cancel`,
);

const abrirBody = (c: C, extra: object = {}) => ({
  carId: c.ch.c.carId,
  deliveryId: c.ch.c.deliveryId,
  items: [{ gasCylinderId: c.garrafaA, loadedFull: 5 }],
  ...extra,
});
const conExtra = (nombre: string, extra: (c: C) => object, esperado = 400) =>
  crear(nombre, ADMIN, esperado, {
    antes: chofer(),
    body: (c) => abrirBody(c, extra(c)),
  });

const casosApertura: Array<Caso<C>> = [
  crear('abre la carga', ADMIN, 201, {
    antes: chofer(),
    body: (c) => abrirBody(c),
    verificar: (b) => expect(b).toMatchObject({ status: 'loading' }),
  }),
  conExtra(
    'depósito explícito',
    (c) => ({ originWarehouseId: c.depositoA }),
    201,
  ),
  conExtra('fecha de jornada', () => ({ businessDate: hoy() }), 201),
  conExtra('notas', () => ({ notes: 'Salida temprana' }), 201),
  crear('Idempotency-Key repetida con otro cuerpo', ADMIN, 422, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c);
      c.p.clave = await usarClave(
        c,
        'post',
        '/truck-loads',
        ADMIN,
        abrirBody(c),
      );
    },
    cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
    body: (c) => abrirBody(c, { notes: 'otra' }),
  }),
  conExtra('camión falta', () => ({ carId: undefined })),
  conExtra('camión no es UUID', () => ({ carId: 'x' })),
  conExtra('chofer falta', () => ({ deliveryId: undefined })),
  conExtra('chofer no es UUID', () => ({ deliveryId: 'x' })),
  conExtra('ayudante no es UUID', () => ({ helperEmployeeId: 'x' })),
  conExtra('depósito no es UUID', () => ({ originWarehouseId: 'x' })),
  conExtra('fecha con otro formato', () => ({ businessDate: '12/10/2026' })),
  conExtra('fecha irreal', () => ({ businessDate: '2026-02-30' })),
  conExtra('notas no es texto', () => ({ notes: 5 })),
  conExtra('notas largas', () => ({ notes: 'x'.repeat(301) })),
  conExtra('campo extra', () => ({ ajeno: true })),
  ...reglasDeRenglon(crear, chofer(), (c, items) => abrirBody(c, { items })),
  crear('el camión no está en uso por el chofer', ADMIN, 400, {
    antes: chofer(),
    body: (c) => abrirBody(c, { carId: c.autoA }),
  }),
  conExtra('depósito inactivo', (c) => ({
    originWarehouseId: c.depositoInactivo,
  })),
  crear('camión inexistente', ADMIN, 404, {
    antes: chofer(),
    body: (c) => abrirBody(c, { carId: c.inexistente }),
  }),
  crear('camión de otra distribuidora no abre nada', ADMIN, 404, {
    ...sinCambiosEn(
      [
        {
          tabla: 'truck_load',
          columna: 'delivery_id',
          id: (c) => c.ch.c.deliveryId,
        },
        { tabla: 'truck_load', columna: 'car_id', id: (c) => c.autoB },
        { tabla: 'car', columna: 'car_id', id: (c) => c.autoB },
      ],
      chofer(),
    ),
    body: (c) => abrirBody(c, { carId: c.autoB }),
  }),
  crear('chofer inexistente', ADMIN, 404, {
    antes: chofer(),
    body: (c) => abrirBody(c, { deliveryId: c.inexistente }),
  }),
  crear('chofer de otra distribuidora no abre nada', ADMIN, 404, {
    ...sinCambiosEn(
      [
        {
          tabla: 'truck_load',
          columna: 'delivery_id',
          id: (c) => c.ch.b.deliveryId,
        },
        {
          tabla: 'delivery',
          columna: 'delivery_id',
          id: (c) => c.ch.b.deliveryId,
        },
      ],
      async (c) => {
        c.ch.c = await nuevoChofer(c);
        c.ch.b = await nuevoChofer(c, { dist: 'B' });
      },
    ),
    body: (c) => abrirBody(c, { deliveryId: c.ch.b.deliveryId }),
  }),
  conExtra(
    'ayudante inexistente',
    (c) => ({ helperEmployeeId: c.inexistente }),
    404,
  ),
  conExtra(
    'depósito inexistente',
    (c) => ({ originWarehouseId: c.inexistente }),
    404,
  ),
  crear('depósito de otra distribuidora no abre nada', ADMIN, 404, {
    ...sinCambiosEn(
      [
        {
          tabla: 'truck_load',
          columna: 'delivery_id',
          id: (c) => c.ch.c.deliveryId,
        },
        { tabla: 'warehouse', columna: 'warehouse_id', id: (c) => c.depositoB },
      ],
      chofer(),
    ),
    body: (c) => abrirBody(c, { originWarehouseId: c.depositoB }),
  }),
  crear('garrafa inexistente', ADMIN, 404, {
    antes: chofer(),
    body: (c) =>
      abrirBody(c, {
        items: [{ gasCylinderId: c.inexistente, loadedFull: 1 }],
      }),
  }),
  crear('garrafa de otra distribuidora no abre nada', ADMIN, 404, {
    ...sinCambiosEn(
      [
        {
          tabla: 'truck_load',
          columna: 'delivery_id',
          id: (c) => c.ch.c.deliveryId,
        },
        {
          tabla: 'stock_balance',
          columna: 'gas_cylinder_id',
          id: (c) => c.garrafaB,
        },
        {
          tabla: 'gas_cylinder',
          columna: 'gas_cylinder_id',
          id: (c) => c.garrafaB,
        },
      ],
      chofer(),
    ),
    body: (c) =>
      abrirBody(c, { items: [{ gasCylinderId: c.garrafaB, loadedFull: 1 }] }),
  }),
  crear('el chofer ya tiene carga abierta', ADMIN, 409, {
    antes: async (c) => {
      const abierta = await sembrarCarga(c);
      c.ch.c = abierta.chofer;
      const repo = c.app.get(DataSource).getRepository(VehicleAssignment);
      await repo.update(
        { deliveryId: abierta.chofer.deliveryId },
        { releasedAt: new Date() },
      );
      c.ch.camion = await nuevoChofer(c, { vehiculo: false });
      await repo.save({
        distributorId: c.distA.id,
        carId: c.ch.camion.carId,
        deliveryId: abierta.chofer.deliveryId,
        assignedAt: new Date(),
      } as Partial<VehicleAssignment>);
    },
    body: (c) => abrirBody(c, { carId: c.ch.camion.carId }),
    mensaje: /chofer ya tiene abierta/,
  }),
  crear('el camión ya tiene carga abierta', ADMIN, 409, {
    antes: async (c) => {
      const primera = await sembrarCarga(c);
      c.ch.c = primera.chofer;
      c.ch.segundo = await nuevoChofer(c, { vehiculo: false });
      const repo = c.app.get(DataSource).getRepository(VehicleAssignment);
      await repo.update(
        { deliveryId: primera.chofer.deliveryId },
        { releasedAt: new Date() },
      );
      await repo.save({
        distributorId: c.distA.id,
        carId: primera.chofer.carId,
        deliveryId: c.ch.segundo.deliveryId,
        assignedAt: new Date(),
      } as Partial<VehicleAssignment>);
    },
    body: (c) => abrirBody(c, { deliveryId: c.ch.segundo.deliveryId }),
    mensaje: /camión .* ya tiene abierta/,
  }),
  crear('super admin en modo soporte sobre la distribuidora', 'soporteA', 403, {
    antes: chofer(),
    body: (c) => abrirBody(c),
    code: 'SUPPORT_READ_ONLY',
  }),
  crear('super admin sin distribuidora (sin sesión de soporte)', 'super', 403, {
    antes: chofer(),
    body: (c) => abrirBody(c),
    code: 'SUPPORT_SESSION_REQUIRED',
  }),
  ...bordes(crear, { prohibidos: SOLO_ADMIN, body: {} }),
];

const casosLecturas: Array<Caso<C>> = [
  mine('usuario sin perfil de chofer', undefined, 401, {
    antes: async (c) => {
      c.ch.c = await choferSinPerfil(c);
    },
    cabeceras: comoChofer,
  }),
  mine('chofer sin carga: load null', 'chofer', 200, {
    verificar: (b) => expect(b).toMatchObject({ load: null }),
  }),
  mine('chofer con carga abierta', undefined, 200, {
    antes: carga(),
    cabeceras: comoChofer,
    verificar: (b, c) =>
      expect(b).toMatchObject({ load: { loadId: c.p.carga } }),
  }),
  ...bordes(mine, { prohibidos: ['adminA', 'super', 'clienteA'] }),

  settings('valor por defecto', ADMIN, 200, {
    verificar: (b) => expect(b).toEqual({ requireOpenTruckLoad: false }),
  }),
  settings(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  ...bordes(settings, { prohibidos: SOLO_ADMIN }),

  settingsPut('cambia y se relee', ADMIN, 200, {
    body: { requireOpenTruckLoad: true },
    verificar: async (b, c) => {
      expect(b).toEqual({ requireOpenTruckLoad: true });
      const res = await llamar(c, 'put', '/truck-loads/settings', ADMIN, {
        requireOpenTruckLoad: false,
      });
      expect(res.body).toEqual({ requireOpenTruckLoad: false });
    },
  }),
  settingsPut('falta el campo', ADMIN, 400, { body: {} }),
  settingsPut('booleano inválido', ADMIN, 400, {
    body: { requireOpenTruckLoad: 'si' },
  }),
  settingsPut('campo extra', ADMIN, 400, {
    body: { requireOpenTruckLoad: false, ajeno: true },
  }),
  settingsPut(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { body: { requireOpenTruckLoad: false }, code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  ...bordes(settingsPut, { prohibidos: SOLO_ADMIN, body: {} }),

  stock('camión sin stock', ADMIN, 200, {
    verificar: (b, c) => expect(b).toMatchObject({ carId: c.autoA, items: [] }),
  }),
  stock('camión con la carga en ruta', ADMIN, 200, {
    antes: carga('on_route'),
    ruta: (c) => `/truck-loads/cars/${c.ch.c.carId}/stock`,
    verificar: (b, c) =>
      expect(b).toMatchObject({
        openLoadId: c.p.carga,
        items: [{ gasCylinderId: c.garrafaA, full: 5 }],
      }),
  }),
  stock('inexistente', ADMIN, 404, {
    ruta: (c) => `/truck-loads/cars/${c.inexistente}/stock`,
  }),
  stock('de otra distribuidora', ADMIN, 404, {
    ruta: (c) => `/truck-loads/cars/${c.autoB}/stock`,
  }),
  stock('super admin sin distribuidora (sin sesión de soporte)', 'super', 403, {
    code: 'SUPPORT_SESSION_REQUIRED',
  }),
  ...bordes(stock, {
    prohibidos: SOLO_ADMIN,
    idMalo: '/truck-loads/cars/no/stock',
  }),

  listar('sin filtros', ADMIN, 200, {
    antes: carga(),
    verificar: (b) => expect((b as { total: number }).total).toBeGreaterThan(0),
  }),
  listar('no muestra lo de otra distribuidora', ADMIN, 200, {
    antes: carga('loading', 'B'),
    verificar: (b, c) =>
      expect(
        (b as { data: Array<{ loadId: string }> }).data.map((d) => d.loadId),
      ).not.toContain(c.p.carga),
  }),
  listar('filtra por estado, fecha, rango, camión y chofer', ADMIN, 200, {
    antes: carga(),
    ruta: (c) =>
      `/truck-loads?status=loading&date=${hoy()}&from=${hoy()}&to=${hoy()}&carId=${c.ch.c.carId}&deliveryId=${c.ch.c.deliveryId}&page=1&limit=5`,
    verificar: (b, c) =>
      expect(b).toMatchObject({ total: 1, data: [{ loadId: c.p.carga }] }),
  }),
  ...(
    [
      ['estado inválido', 'status=otro'],
      ['fecha inválida', 'date=hoy'],
      ['desde inválido', 'from=hoy'],
      ['hasta inválido', 'to=hoy'],
      ['camión no UUID', 'carId=x'],
      ['chofer no UUID', 'deliveryId=x'],
      ['page cero', 'page=0'],
      ['limit cero', 'limit=0'],
      ['limit sobre el tope', 'limit=101'],
      ['parámetro extra', 'ajeno=1'],
    ] as const
  ).map(([nombre, q]) =>
    listar(nombre, ADMIN, 400, { ruta: `/truck-loads?${q}` }),
  ),
  listar(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  ...bordes(listar, { prohibidos: SOLO_ADMIN }),

  una('administrador', ADMIN, 200, {
    antes: carga(),
    verificar: (b, c) => expect(b).toMatchObject({ loadId: c.p.carga }),
  }),
  una('el chofer de la carga', undefined, 200, {
    verificar: (b, c) => expect(b).toMatchObject({ loadId: c.p.carga }),
    antes: carga(),
    cabeceras: comoChofer,
  }),
  una('otro chofer de la misma distribuidora', 'choferA2', 404, {
    antes: carga(),
  }),
  una('inexistente', ADMIN, 404, {
    ruta: (c) => `/truck-loads/${c.inexistente}`,
  }),
  una('de otra distribuidora', ADMIN, 404, { antes: carga('loading', 'B') }),
  una('super admin sin distribuidora (sin sesión de soporte)', 'super', 403, {
    antes: carga(),
    code: 'SUPPORT_SESSION_REQUIRED',
  }),
  ...bordes(una, { prohibidos: ADMIN_O_CHOFER, idMalo: '/truck-loads/no' }),
];

const nuevos = (c: C, llenas = 8) => ({
  items: [{ gasCylinderId: c.garrafaA, loadedFull: llenas }],
});

const casosItems: Array<Caso<C>> = [
  items('reemplaza los renglones', ADMIN, 200, {
    antes: carga(),
    body: (c) => nuevos(c),
    verificar: (b) => expect(b).toMatchObject({ items: [{ loadedFull: 8 }] }),
  }),
  ...reglasDeRenglon(items, carga(), (_c, items) => ({ items })),
  items('campo extra', ADMIN, 400, {
    antes: carga(),
    body: (c) => ({ ...nuevos(c), ajeno: true }),
  }),
  items('garrafa inexistente', ADMIN, 404, {
    antes: carga(),
    body: (c) => ({
      items: [{ gasCylinderId: c.inexistente, loadedFull: 1 }],
    }),
  }),
  items('garrafa de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambiosEn(
      [
        { tabla: 'truck_load_item', columna: 'load_id', id: (c) => c.p.carga },
        {
          tabla: 'stock_balance',
          columna: 'gas_cylinder_id',
          id: (c) => c.garrafaB,
        },
      ],
      carga(),
    ),
    body: (c) => ({ items: [{ gasCylinderId: c.garrafaB, loadedFull: 1 }] }),
  }),
  items('inexistente', ADMIN, 404, {
    ruta: (c) => `/truck-loads/${c.inexistente}/items`,
    body: (c) => nuevos(c),
  }),
  items('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios(
      'truck_load_item',
      'load_id',
      (c) => c.p.carga,
      carga('loading', 'B'),
    ),
    body: (c) => nuevos(c),
  }),
  items('super admin sin distribuidora (sin sesión de soporte)', 'super', 403, {
    antes: carga(),
    body: (c) => nuevos(c),
    code: 'SUPPORT_SESSION_REQUIRED',
  }),
  ...OTROS_ESTADOS(['loading']).map((e) =>
    items(`carga ${e}`, ADMIN, 409, {
      antes: carga(e),
      body: (c) => nuevos(c),
      mensaje: /no se puede cambiar los renglones/,
    }),
  ),
  ...bordes(items, {
    prohibidos: SOLO_ADMIN,
    body: {},
    idMalo: '/truck-loads/no/items',
  }),
];

/** Deja saldo a mano en el camión del chofer de `c.ch.c`. */
const conGarrafasEnElCamion = async (c: C) => {
  await carga()(c);
  const ds = c.app.get(DataSource);
  await ds.transaction(async (manager) => {
    const camion = await c.app
      .get(StockLocationService)
      .ubicacionDeVehiculo(manager, c.distA.id, c.ch.c.carId);
    await c.app.get(StockLedgerPort).aplicar(manager, {
      distributorId: c.distA.id,
      referenceType: StockReferenceType.INITIAL,
      referenceId: null,
      actorUserId: null,
      movimientos: [
        {
          gasCylinderId: c.garrafaA,
          quantity: 1,
          from: null,
          to: { locationId: camion.locationId, condition: StockCondition.FULL },
          reason: StockMovementReason.INITIAL_COUNT,
        },
      ],
    });
  });
};

const casosSalida: Array<Caso<C>> = [
  salir('administrador', ADMIN, 200, {
    antes: carga(),
    cabeceras: conClave,
    verificar: (b) => expect(b).toMatchObject({ status: 'on_route' }),
  }),
  salir('el chofer de la carga', undefined, 200, {
    verificar: (b) => expect(b).toMatchObject({ status: 'on_route' }),
    antes: carga(),
    cabeceras: comoChofer,
  }),
  salir('carga sin garrafas', ADMIN, 400, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c);
      c.p.carga = await abrirCargaCon(c, c.ch.c, [
        { gasCylinderId: c.garrafaA, loadedFull: 0 },
      ]);
    },
    mensaje: /no tiene garrafas/,
  }),
  salir('el camión todavía tiene garrafas', ADMIN, 400, {
    antes: conGarrafasEnElCamion,
    mensaje: /todavía tiene garrafas/,
  }),
  salir('stock insuficiente en el depósito', ADMIN, 400, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c);
      c.p.carga = await abrirCargaCon(c, c.ch.c, [
        { gasCylinderId: c.garrafaSinStock, loadedFull: 1 },
      ]);
    },
  }),
  salir('otro chofer de la misma distribuidora', 'choferA2', 404, {
    antes: carga(),
  }),
  salir('inexistente', ADMIN, 404, {
    ruta: (c) => `/truck-loads/${c.inexistente}/depart`,
  }),
  salir('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios(
      'truck_load',
      'load_id',
      (c) => c.p.carga,
      carga('loading', 'B'),
    ),
  }),
  salir('super admin sin distribuidora (sin sesión de soporte)', 'super', 403, {
    antes: carga(),
    code: 'SUPPORT_SESSION_REQUIRED',
  }),
  ...OTROS_ESTADOS(['loading']).map((e) =>
    salir(`carga ${e}`, ADMIN, 409, {
      antes: carga(e),
      mensaje: /no se puede confirmar la salida/,
    }),
  ),
  ...bordes(salir, {
    prohibidos: ADMIN_O_CHOFER,
    idMalo: '/truck-loads/no/depart',
  }),
];

const reposicion = (c: C, cantidad = 2) => ({
  items: [{ gasCylinderId: c.garrafaA, quantity: cantidad }],
});
const reponerBad = (nombre: string, items: (c: C) => unknown) =>
  reponer(nombre, ADMIN, 400, {
    antes: carga('on_route'),
    cabeceras: conClave,
    body: (c) => ({ items: items(c) }),
  });

const casosReposicion: Array<Caso<C>> = [
  reponer('suma llenas al camión', ADMIN, 200, {
    antes: carga('on_route'),
    cabeceras: conClave,
    body: (c) => reposicion(c),
    verificar: (b) => expect(b).toMatchObject({ items: [{ reloadedFull: 2 }] }),
  }),
  reponer('sin Idempotency-Key', ADMIN, 400, {
    antes: carga('on_route'),
    body: (c) => reposicion(c),
    mensaje: /exige el header Idempotency-Key/,
  }),
  reponer('Idempotency-Key repetida con otro cuerpo', ADMIN, 422, {
    antes: async (c) => {
      await carga('on_route')(c);
      c.p.clave = await usarClave(
        c,
        'patch',
        `/truck-loads/${c.p.carga}/reload`,
        ADMIN,
        reposicion(c),
      );
    },
    cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
    body: (c) => reposicion(c, 3),
  }),
  reponerBad('items falta', () => undefined),
  reponerBad('items no es lista', () => 'x'),
  reponerBad('items vacío', () => []),
  reponerBad('más de 20 renglones', (c) =>
    Array.from({ length: 21 }, () => reposicion(c).items[0]),
  ),
  reponerBad('garrafa falta', () => [{ quantity: 1 }]),
  reponerBad('garrafa no es UUID', () => [{ gasCylinderId: 'x', quantity: 1 }]),
  reponerBad('cantidad falta', (c) => [{ gasCylinderId: c.garrafaA }]),
  reponerBad('cantidad cero', (c) => [
    { gasCylinderId: c.garrafaA, quantity: 0 },
  ]),
  reponerBad('cantidad no entera', (c) => [
    { gasCylinderId: c.garrafaA, quantity: 1.5 },
  ]),
  reponerBad('cantidad sobre el tope', (c) => [
    { gasCylinderId: c.garrafaA, quantity: 2001 },
  ]),
  reponerBad('garrafa repetida', (c) => [
    { gasCylinderId: c.garrafaA, quantity: 1 },
    { gasCylinderId: c.garrafaA, quantity: 1 },
  ]),
  reponer('no alcanza el stock', ADMIN, 400, {
    antes: carga('on_route'),
    cabeceras: conClave,
    body: (c) => ({
      items: [{ gasCylinderId: c.garrafaSinStock, quantity: 1 }],
    }),
  }),
  reponer('pasaría de 20 tipos de garrafa', ADMIN, 400, {
    antes: async (c) => {
      const tipos = await garrafasNuevas(c, 21);
      c.ch.c = await nuevoChofer(c);
      c.p.carga = await abrirCargaCon(
        c,
        c.ch.c,
        tipos
          .slice(0, 20)
          .map((gasCylinderId) => ({ gasCylinderId, loadedFull: 1 })),
      );
      c.p.tipoExtra = tipos[20];
      await llamar(c, 'patch', `/truck-loads/${c.p.carga}/depart`, ADMIN);
    },
    cabeceras: conClave,
    body: (c) => ({ items: [{ gasCylinderId: c.p.tipoExtra, quantity: 1 }] }),
    mensaje: /máximo es 20/,
  }),
  reponer('garrafa inexistente', ADMIN, 404, {
    antes: carga('on_route'),
    cabeceras: conClave,
    body: (c) => ({ items: [{ gasCylinderId: c.inexistente, quantity: 1 }] }),
  }),
  reponer('garrafa de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambiosEn(
      [
        { tabla: 'truck_load_item', columna: 'load_id', id: (c) => c.p.carga },
        {
          tabla: 'stock_balance',
          columna: 'gas_cylinder_id',
          id: (c) => c.garrafaB,
        },
      ],
      carga('on_route'),
    ),
    cabeceras: conClave,
    body: (c) => ({ items: [{ gasCylinderId: c.garrafaB, quantity: 1 }] }),
  }),
  reponer('inexistente', ADMIN, 404, {
    ruta: (c) => `/truck-loads/${c.inexistente}/reload`,
    cabeceras: conClave,
    body: (c) => reposicion(c),
  }),
  reponer('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios(
      'truck_load_item',
      'load_id',
      (c) => c.p.carga,
      carga('on_route', 'B'),
    ),
    cabeceras: conClave,
    body: (c) => reposicion(c),
  }),
  ...OTROS_ESTADOS(['on_route']).map((e) =>
    reponer(`carga ${e}`, ADMIN, 409, {
      antes: carga(e),
      cabeceras: conClave,
      body: (c) => reposicion(c),
      mensaje: /no se puede reponer/,
    }),
  ),
  ...bordes(reponer, {
    prohibidos: SOLO_ADMIN,
    body: {},
    idMalo: '/truck-loads/no/reload',
  }),
];

const vueltaBad = (nombre: string, items: (c: C) => unknown) =>
  volver(nombre, ADMIN, 400, {
    antes: carga('on_route'),
    body: (c) => ({ items: items(c) }),
  });
const decl = (c: C, extra: object) => ({
  gasCylinderId: c.garrafaA,
  declaredFull: 5,
  declaredEmpty: 0,
  ...extra,
});

const casosVuelta: Array<Caso<C>> = [
  volver('administrador', ADMIN, 200, {
    antes: carga('on_route'),
    body: devuelta,
    verificar: (b) => expect(b).toMatchObject({ status: 'returned' }),
  }),
  volver('el chofer de la carga', undefined, 200, {
    verificar: (b) => expect(b).toMatchObject({ status: 'returned' }),
    antes: carga('on_route'),
    cabeceras: comoChofer,
    body: devuelta,
  }),
  volver('se vuelve a declarar antes de cerrar', ADMIN, 200, {
    antes: carga('returned'),
    body: (c) => devuelta(c, 4),
    verificar: (b) =>
      expect(b).toMatchObject({ items: [{ declaredReturnFull: 4 }] }),
  }),
  vueltaBad('items falta', () => undefined),
  vueltaBad('items vacío', () => []),
  vueltaBad('items no es lista', () => 'x'),
  vueltaBad('más de 20 renglones', (c) =>
    Array.from({ length: 21 }, () => decl(c, {})),
  ),
  vueltaBad('garrafa no es UUID', (c) => [decl(c, { gasCylinderId: 'x' })]),
  vueltaBad('llenas falta', (c) => [decl(c, { declaredFull: undefined })]),
  vueltaBad('llenas no entera', (c) => [decl(c, { declaredFull: 1.5 })]),
  vueltaBad('llenas negativas', (c) => [decl(c, { declaredFull: -1 })]),
  vueltaBad('llenas sobre el tope', (c) => [decl(c, { declaredFull: 4001 })]),
  vueltaBad('vacías falta', (c) => [decl(c, { declaredEmpty: undefined })]),
  vueltaBad('vacías no entera', (c) => [decl(c, { declaredEmpty: 1.5 })]),
  vueltaBad('vacías negativas', (c) => [decl(c, { declaredEmpty: -1 })]),
  vueltaBad('vacías sobre el tope', (c) => [decl(c, { declaredEmpty: 4001 })]),
  vueltaBad('garrafa repetida', (c) => [decl(c, {}), decl(c, {})]),
  vueltaBad('garrafa que no es de la carga', (c) => [
    decl(c, { gasCylinderId: c.garrafaA2 }),
  ]),
  volver('falta declarar una garrafa', ADMIN, 400, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c);
      c.p.carga = await abrirCargaCon(c, c.ch.c, [
        { gasCylinderId: c.garrafaA, loadedFull: 1 },
        { gasCylinderId: c.garrafaA2, loadedFull: 1 },
      ]);
      await llamar(c, 'patch', `/truck-loads/${c.p.carga}/depart`, ADMIN);
    },
    body: devuelta,
    mensaje: /Falta declarar/,
  }),
  volver('otro chofer de la misma distribuidora', 'choferA2', 404, {
    antes: carga('on_route'),
    body: devuelta,
  }),
  volver('inexistente', ADMIN, 404, {
    ruta: (c) => `/truck-loads/${c.inexistente}/return`,
    body: devuelta,
  }),
  volver('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios(
      'truck_load',
      'load_id',
      (c) => c.p.carga,
      carga('on_route', 'B'),
    ),
    body: devuelta,
  }),
  volver(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    {
      antes: carga('on_route'),
      body: devuelta,
      code: 'SUPPORT_SESSION_REQUIRED',
    },
  ),
  volver('el chofer tiene pedidos en curso', ADMIN, 409, {
    antes: async (c) => {
      await carga('on_route')(c);
      await pedidoDe(c, c.ch.c, OrderStatus.ON_THE_WAY);
    },
    body: devuelta,
    mensaje: /pedido en curso/,
  }),
  ...OTROS_ESTADOS(['on_route', 'returned']).map((e) =>
    volver(`carga ${e}`, ADMIN, 409, {
      antes: carga(e),
      body: devuelta,
      mensaje: /no se puede declarar la vuelta/,
    }),
  ),
  ...bordes(volver, {
    prohibidos: ADMIN_O_CHOFER,
    body: {},
    idMalo: '/truck-loads/no/return',
  }),
];

const casosCierre: Array<Caso<C>> = [
  cerrar('sin diferencia', ADMIN, 200, {
    antes: carga('returned'),
    cabeceras: conClave,
    body: {},
    verificar: (b) => expect(b).toMatchObject({ status: 'closed' }),
  }),
  cerrar('con diferencia y nota', ADMIN, 200, {
    antes: async (c) => {
      await carga('on_route')(c);
      await llamar(c, 'patch', `/truck-loads/${c.p.carga}/return`, ADMIN, {
        items: [
          { gasCylinderId: c.garrafaA, declaredFull: 4, declaredEmpty: 0 },
        ],
      });
    },
    cabeceras: conClave,
    body: { differenceNote: 'Faltó una garrafa' },
    verificar: (b) =>
      expect(b).toMatchObject({ status: 'closed_with_difference' }),
  }),
  cerrar('con diferencia y sin nota', ADMIN, 400, {
    antes: async (c) => {
      await carga('on_route')(c);
      await llamar(c, 'patch', `/truck-loads/${c.p.carga}/return`, ADMIN, {
        items: [
          { gasCylinderId: c.garrafaA, declaredFull: 4, declaredEmpty: 0 },
        ],
      });
    },
    body: {},
    mensaje: /indicá la nota de la diferencia/,
  }),
  cerrar('nota vacía', ADMIN, 400, {
    antes: carga('returned'),
    body: { differenceNote: '  ' },
  }),
  cerrar('nota no es texto', ADMIN, 400, {
    antes: carga('returned'),
    body: { differenceNote: 5 },
  }),
  cerrar('nota larga', ADMIN, 400, {
    antes: carga('returned'),
    body: { differenceNote: 'x'.repeat(501) },
  }),
  cerrar('campo extra', ADMIN, 400, {
    antes: carga('returned'),
    body: { ajeno: true },
  }),
  cerrar('Idempotency-Key repetida con otro cuerpo', ADMIN, 422, {
    antes: async (c) => {
      await carga('returned')(c);
      c.p.clave = await usarClave(
        c,
        'patch',
        `/truck-loads/${c.p.carga}/close`,
        ADMIN,
        {},
      );
    },
    cabeceras: (c) => ({ 'Idempotency-Key': c.p.clave }),
    body: { differenceNote: 'Otra' },
  }),
  cerrar('entregas después de declarar la vuelta', ADMIN, 409, {
    antes: async (c) => {
      await carga('on_route')(c);
      await llamar(c, 'patch', `/truck-loads/${c.p.carga}/return`, ADMIN, {
        items: [
          { gasCylinderId: c.garrafaA, declaredFull: 5, declaredEmpty: 0 },
        ],
      });
      const { orderId } = await pedidoDe(c, c.ch.c, OrderStatus.ON_THE_WAY);
      await entregar(c, orderId);
    },
    body: { differenceNote: 'x' },
    mensaje: /después de declarar la vuelta/,
  }),
  cerrar('inexistente', ADMIN, 404, {
    ruta: (c) => `/truck-loads/${c.inexistente}/close`,
    body: {},
  }),
  cerrar('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios(
      'truck_load',
      'load_id',
      (c) => c.p.carga,
      carga('returned', 'B'),
    ),
    body: {},
  }),
  cerrar(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { antes: carga('returned'), body: {}, code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  ...OTROS_ESTADOS(['returned']).map((e) =>
    cerrar(`carga ${e}`, ADMIN, 409, {
      antes: carga(e),
      body: { differenceNote: 'x' },
      mensaje: /no se puede cerrar la rendición/,
    }),
  ),
  ...bordes(cerrar, {
    prohibidos: SOLO_ADMIN,
    body: {},
    idMalo: '/truck-loads/no/close',
  }),
];

const casosCancelar: Array<Caso<C>> = [
  cancelar('carga en loading', ADMIN, 200, {
    antes: carga(),
    body: { reason: 'El camión no salió' },
    verificar: (b) =>
      expect(b).toMatchObject({
        status: 'cancelled',
        cancelReason: 'El camión no salió',
      }),
  }),
  cancelar('motivo falta', ADMIN, 400, { antes: carga(), body: {} }),
  cancelar('motivo vacío', ADMIN, 400, {
    antes: carga(),
    body: { reason: '   ' },
  }),
  cancelar('motivo no es texto', ADMIN, 400, {
    antes: carga(),
    body: { reason: 5 },
  }),
  cancelar('motivo largo', ADMIN, 400, {
    antes: carga(),
    body: { reason: 'x'.repeat(301) },
  }),
  cancelar('campo extra', ADMIN, 400, {
    antes: carga(),
    body: { reason: 'Prueba', ajeno: 1 },
  }),
  cancelar('inexistente', ADMIN, 404, {
    ruta: (c) => `/truck-loads/${c.inexistente}/cancel`,
    body: { reason: 'Prueba' },
  }),
  cancelar('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios(
      'truck_load',
      'load_id',
      (c) => c.p.carga,
      carga('loading', 'B'),
    ),
    body: { reason: 'Prueba' },
  }),
  cancelar(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    {
      antes: carga(),
      body: { reason: 'Prueba' },
      code: 'SUPPORT_SESSION_REQUIRED',
    },
  ),
  ...OTROS_ESTADOS(['loading']).map((e) =>
    cancelar(`carga ${e}`, ADMIN, 409, {
      antes: carga(e),
      body: { reason: 'Prueba' },
      mensaje: /no se puede cancelar/,
    }),
  ),
  ...bordes(cancelar, {
    prohibidos: SOLO_ADMIN,
    body: {},
    idMalo: '/truck-loads/no/cancel',
  }),
];

/** Matriz T5: carga del camión. */
describe('Matriz HTTP T5: cargas del camión (e2e)', () => {
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
    casosEnModoSoporte(listar, crear),
  );
  correrMatriz('abrir', ver, casosApertura);
  correrMatriz('lecturas y parámetros', ver, casosLecturas);
  correrMatriz('renglones', ver, casosItems);
  correrMatriz('salida', ver, casosSalida);
  correrMatriz('reposición', ver, casosReposicion);
  correrMatriz('vuelta', ver, casosVuelta);
  correrMatriz('cierre', ver, casosCierre);
  correrMatriz('cancelación', ver, casosCancelar);
});
