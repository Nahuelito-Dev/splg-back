import { DataSource } from 'typeorm';
import { Delivery } from '../../../src/delivery/entities/delivery.entity';
import { OrderStatus } from '../../../src/order/entities/order.entity';
import { createTestApp, TestEnv } from '../setup/test-env';
import { Caso, correrMatriz, endpoint } from './matriz';
import {
  ADMIN_O_CHOFER,
  ChoferT5,
  EscenarioT5,
  SOLO_ADMIN,
  bordes,
  choferSinPerfil,
  comoChofer,
  dejarFueraDeServicio,
  marcarChofer,
  nuevoChofer,
  pedidoDe,
  sembrarCarga,
  sembrarBaseT5,
  sembrarRendicion,
  sinCambios,
  sinCambiosEn,
  vencerDocumento,
} from './t5-base';

type C = EscenarioT5;
const ADMIN = 'adminA';
const chId = (c: C) => (c.ch.c ?? c.choferA).deliveryId;
const usId = (c: C) => (c.ch.c ?? c.choferA).userId;

const chofer =
  (dist: 'A' | 'B' = 'A', o: { vehiculo?: boolean } = {}) =>
  async (c: C) => {
    c.ch.c = await nuevoChofer(c, { dist, ...o });
  };
const conAjeno = async (c: C) => {
  c.ch.c = await nuevoChofer(c, { dist: 'B' });
};
const filaDelChofer = (c: C) => c.ch.c.deliveryId;
const noCambiaElChofer = () =>
  sinCambios('delivery', 'delivery_id', filaDelChofer, conAjeno);

const FILTRO = {
  enabled: { dato: { isEnabled: true }, campo: 'isEnabled', valor: true },
  disabled: { dato: { isEnabled: false }, campo: 'isEnabled', valor: false },
  online: { dato: { isAvailable: true }, campo: 'isAvailable', valor: true },
  unvalidated: { dato: { validated: false }, campo: 'validated', valor: false },
} as const;

function comprobarFiltro(b: unknown, c: C, s: keyof typeof FILTRO): void {
  const filas = b as Array<Record<string, unknown>>;
  expect(filas.map((f) => f.delivery_id)).toContain(c.ch.c.deliveryId);
  expect(filas.map((f) => f[FILTRO[s].campo])).toEqual(
    filas.map(() => FILTRO[s].valor),
  );
}

const lista = endpoint<C>('get', '/delivery', '/delivery');
const activos = endpoint<C>('get', '/delivery/active', '/delivery/active');
const uno = endpoint<C>('get', '/delivery/{id}', (c) => `/delivery/${chId(c)}`);
const porUsuario = endpoint<C>(
  'get',
  '/delivery/user/{userId}',
  (c) => `/delivery/user/${usId(c)}`,
);
const editar = endpoint<C>(
  'patch',
  '/delivery/{id}',
  (c) => `/delivery/${chId(c)}`,
);
const validar = endpoint<C>(
  'patch',
  '/delivery/{id}/validate',
  (c) => `/delivery/${chId(c)}/validate`,
);
const invalidar = endpoint<C>(
  'patch',
  '/delivery/{id}/invalidate',
  (c) => `/delivery/${chId(c)}/invalidate`,
);
const ubicar = endpoint<C>(
  'patch',
  '/delivery/{id}/location',
  (c) => `/delivery/${chId(c)}/location`,
);
const saldo = endpoint<C>(
  'patch',
  '/delivery/{id}/balance',
  (c) => `/delivery/${chId(c)}/balance`,
);
const estado = endpoint<C>(
  'patch',
  '/delivery/{id}/status',
  (c) => `/delivery/${chId(c)}/status`,
);
const baja = endpoint<C>(
  'delete',
  '/delivery/{id}',
  (c) => `/delivery/${chId(c)}`,
);
const disponibilidad = endpoint<C>(
  'patch',
  '/delivery/user/{userId}/availability',
  (c) => `/delivery/user/${usId(c)}/availability`,
);
const vehiculo = endpoint<C>(
  'get',
  '/delivery/{id}/vehicle',
  (c) => `/delivery/${chId(c)}/vehicle`,
);
const miVehiculo = endpoint<C>(
  'get',
  '/delivery/me/vehicle',
  '/delivery/me/vehicle',
);
const asignar = endpoint<C>(
  'put',
  '/delivery/{id}/vehicle',
  (c) => `/delivery/${chId(c)}/vehicle`,
);
const liberar = endpoint<C>(
  'delete',
  '/delivery/{id}/vehicle',
  (c) => `/delivery/${chId(c)}/vehicle`,
);
const historial = endpoint<C>(
  'get',
  '/delivery/{id}/vehicle-history',
  (c) => `/delivery/${chId(c)}/vehicle-history`,
);
const documentos = endpoint<C>(
  'get',
  '/delivery/{id}/documents',
  (c) => `/delivery/${chId(c)}/documents`,
);

/** Para los que escriben con `required: 'staff'`: el super admin sin tenant. */
const superSinTenant = (
  ep: ReturnType<typeof endpoint<C>>,
  body?: object,
): Caso<C> =>
  ep('super admin sin distribuidora', 'super', 400, {
    antes: chofer(),
    body,
    mensaje: /X-Distributor/,
  });
const inexistente = (
  ep: ReturnType<typeof endpoint<C>>,
  sufijo: string,
  body?: object,
): Caso<C> =>
  ep('inexistente', ADMIN, 404, {
    ruta: (c) => `/delivery/${c.inexistente}${sufijo}`,
    body,
  });

const casosLecturas: Array<Caso<C>> = [
  lista('lista de la distribuidora', ADMIN, 200, {
    verificar: (b) => expect((b as unknown[]).length).toBeGreaterThan(0),
  }),
  lista('no muestra choferes de otra distribuidora', ADMIN, 200, {
    antes: conAjeno,
    ruta: '/delivery?limit=100',
    verificar: (b, c) => {
      expect(JSON.stringify(b)).not.toContain(c.ch.c.deliveryId);
    },
  }),
  lista('super admin sin distribuidora ve todas', 'super', 200, {
    antes: conAjeno,
    ruta: '/delivery?limit=100',
    verificar: (b, c) => expect(JSON.stringify(b)).toContain(c.ch.c.deliveryId),
  }),
  ...(['enabled', 'disabled', 'online', 'unvalidated'] as const).map((s) =>
    lista(`filtra por ${s}`, ADMIN, 200, {
      antes: async (c) => {
        await chofer()(c);
        await marcarChofer(c, c.ch.c.deliveryId, FILTRO[s].dato);
      },
      ruta: `/delivery?status=${s}&limit=100`,
      verificar: (b, c) => comprobarFiltro(b, c, s),
    }),
  ),
  lista('busca por término', ADMIN, 200, {
    antes: chofer(),
    ruta: (c) => `/delivery?term=${c.ch.c.email}`,
    verificar: (b, c) =>
      expect(b).toMatchObject([{ delivery_id: c.ch.c.deliveryId }]),
  }),
  ...(
    [
      ['estado inválido', 'status=otro'],
      ['limit cero', 'limit=0'],
      ['limit sobre el tope', 'limit=101'],
      ['offset negativo', 'offset=-1'],
      ['parámetro extra', 'ajeno=1'],
    ] as const
  ).map(([nombre, q]) => lista(nombre, ADMIN, 400, { ruta: `/delivery?${q}` })),
  ...bordes(lista, { prohibidos: SOLO_ADMIN }),

  activos('sólo los que están en línea', ADMIN, 200, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c);
      await marcarChofer(c, c.ch.c.deliveryId, { isAvailable: true });
      c.ch.apagado = await nuevoChofer(c);
    },
    ruta: '/delivery/active?limit=100',
    verificar: (b, c) => {
      const texto = JSON.stringify(b);
      expect(texto).toContain(c.ch.c.deliveryId);
      expect(texto).not.toContain(c.ch.apagado.deliveryId);
    },
  }),
  activos('no muestra de otra distribuidora', ADMIN, 200, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c, { dist: 'B' });
      await marcarChofer(c, c.ch.c.deliveryId, { isAvailable: true });
    },
    ruta: '/delivery/active?limit=100',
    verificar: (b, c) =>
      expect(JSON.stringify(b)).not.toContain(c.ch.c.deliveryId),
  }),
  activos('limit cero', ADMIN, 400, { ruta: '/delivery/active?limit=0' }),
  activos('limit sobre el tope', ADMIN, 400, {
    ruta: '/delivery/active?limit=101',
  }),
  activos('offset negativo', ADMIN, 400, {
    ruta: '/delivery/active?offset=-1',
  }),
  activos('parámetro extra', ADMIN, 400, { ruta: '/delivery/active?ajeno=1' }),
  ...bordes(activos, { prohibidos: SOLO_ADMIN }),

  uno('administrador', ADMIN, 200, {
    verificar: (b, c) =>
      expect(b).toMatchObject({ delivery_id: c.ch.c.deliveryId }),
    antes: chofer(),
  }),
  uno('el propio chofer', undefined, 200, {
    verificar: (b, c) =>
      expect(b).toMatchObject({ delivery_id: c.ch.c.deliveryId }),
    antes: chofer(),
    cabeceras: comoChofer,
  }),
  uno('otro chofer', 'choferA2', 403, { antes: chofer() }),
  uno('super admin sin distribuidora ve cualquiera', 'super', 200, {
    verificar: (b, c) =>
      expect(b).toMatchObject({ delivery_id: c.ch.c.deliveryId }),
    antes: conAjeno,
  }),
  inexistente(uno, ''),
  uno('de otra distribuidora', ADMIN, 404, { antes: conAjeno }),
  ...bordes(uno, { prohibidos: ADMIN_O_CHOFER, idMalo: '/delivery/no' }),

  porUsuario('administrador', ADMIN, 200, {
    verificar: (b, c) => expect(b).toMatchObject({ user_id: c.ch.c.userId }),
    antes: chofer(),
  }),
  porUsuario('el propio chofer', undefined, 200, {
    verificar: (b, c) => expect(b).toMatchObject({ user_id: c.ch.c.userId }),
    antes: chofer(),
    cabeceras: comoChofer,
  }),
  porUsuario('otro chofer', 'choferA2', 403, { antes: chofer() }),
  porUsuario('super admin sin distribuidora ve cualquiera', 'super', 200, {
    verificar: (b, c) => expect(b).toMatchObject({ user_id: c.ch.c.userId }),
    antes: conAjeno,
  }),
  porUsuario('inexistente', ADMIN, 404, {
    ruta: (c) => `/delivery/user/${c.inexistente}`,
  }),
  porUsuario('un usuario que no es chofer', ADMIN, 404, {
    ruta: (c) => `/delivery/user/${c.clienteA.userId}`,
  }),
  porUsuario('de otra distribuidora', ADMIN, 404, { antes: conAjeno }),
  ...bordes(porUsuario, {
    prohibidos: ADMIN_O_CHOFER,
    idMalo: '/delivery/user/no',
  }),
];

const casosEscritura: Array<Caso<C>> = [
  editar('actualiza y relee', ADMIN, 200, {
    antes: chofer(),
    body: { validated: false },
    verificar: async (_b, c) => {
      const fila = await c.app
        .get(DataSource)
        .getRepository(Delivery)
        .findOneByOrFail({ deliveryId: c.ch.c.deliveryId });
      expect(fila.validated).toBe(false);
    },
  }),
  editar('cuerpo vacío', ADMIN, 200, {
    verificar: (b) => expect(b).toMatchObject({ validated: true }),
    antes: chofer(),
    body: {},
  }),
  editar('booleano inválido', ADMIN, 400, {
    antes: chofer(),
    body: { validated: 'si' },
  }),
  editar('campo extra', ADMIN, 400, {
    antes: chofer(),
    body: { ajeno: true },
  }),
  inexistente(editar, '', {}),
  editar('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...noCambiaElChofer(),
    body: { validated: false },
  }),
  superSinTenant(editar, {}),
  ...bordes(editar, {
    prohibidos: SOLO_ADMIN,
    body: {},
    idMalo: '/delivery/no',
  }),

  validar('valida', ADMIN, 200, {
    antes: async (c) => {
      await chofer()(c);
      await marcarChofer(c, c.ch.c.deliveryId, { validated: false });
    },
    verificar: (b) => expect(b).toMatchObject({ validated: true }),
  }),
  inexistente(validar, '/validate'),
  validar('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...noCambiaElChofer(),
  }),
  superSinTenant(validar),
  ...bordes(validar, {
    prohibidos: SOLO_ADMIN,
    idMalo: '/delivery/no/validate',
  }),

  invalidar('invalida', ADMIN, 200, {
    antes: chofer(),
    verificar: (b) => expect(b).toMatchObject({ validated: false }),
  }),
  inexistente(invalidar, '/invalidate'),
  invalidar('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...noCambiaElChofer(),
  }),
  superSinTenant(invalidar),
  ...bordes(invalidar, {
    prohibidos: SOLO_ADMIN,
    idMalo: '/delivery/no/invalidate',
  }),

  ubicar('administrador', ADMIN, 200, {
    verificar: (b) =>
      expect(b).toMatchObject({
        actual_location: 'Av. Mitre 1234',
        latLng: expect.stringContaining('-27.3671') as string,
      }),
    antes: chofer(),
    body: { latLng: '-27.3671,-55.8961', actualLocation: 'Av. Mitre 1234' },
  }),
  ubicar('el propio chofer', undefined, 200, {
    verificar: (b) =>
      expect(b).toMatchObject({
        latLng: expect.stringContaining('-27.3671') as string,
      }),
    antes: chofer(),
    cabeceras: comoChofer,
    body: { latLng: '-27.3671,-55.8961' },
  }),
  ubicar('coordenadas faltan', ADMIN, 400, { antes: chofer(), body: {} }),
  ubicar('coordenadas inválidas', ADMIN, 400, {
    antes: chofer(),
    body: { latLng: 'ninguna' },
  }),
  ubicar('dirección no es texto', ADMIN, 400, {
    antes: chofer(),
    body: { latLng: '-27.3671,-55.8961', actualLocation: 5 },
  }),
  ubicar('dirección larga', ADMIN, 400, {
    antes: chofer(),
    body: { latLng: '-27.3671,-55.8961', actualLocation: 'x'.repeat(201) },
  }),
  ubicar('campo extra', ADMIN, 400, {
    antes: chofer(),
    body: { latLng: '-27.3671,-55.8961', ajeno: 1 },
  }),
  ubicar('otro chofer', 'choferA2', 403, {
    antes: chofer(),
    body: { latLng: '-27.3671,-55.8961' },
  }),
  inexistente(ubicar, '/location', { latLng: '-27.3671,-55.8961' }),
  ubicar('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...noCambiaElChofer(),
    body: { latLng: '-27.3671,-55.8961' },
  }),
  superSinTenant(ubicar, { latLng: '-27.3671,-55.8961' }),
  ...bordes(ubicar, {
    prohibidos: ADMIN_O_CHOFER,
    body: {},
    idMalo: '/delivery/no/location',
  }),

  saldo('acredita', ADMIN, 200, {
    antes: chofer(),
    body: { amount: 1500.5 },
    verificar: async (_b, c) => {
      const fila = await c.app
        .get(DataSource)
        .getRepository(Delivery)
        .findOneByOrFail({ deliveryId: c.ch.c.deliveryId });
      expect(Number(fila.balance)).toBe(1500.5);
    },
  }),
  saldo('debita', ADMIN, 200, {
    verificar: (b) => expect(b).toMatchObject({ balance: -10 }),
    antes: chofer(),
    body: { amount: -10 },
  }),
  saldo('monto falta', ADMIN, 400, { antes: chofer(), body: {} }),
  saldo('no es número', ADMIN, 400, {
    antes: chofer(),
    body: { amount: 'mil' },
  }),
  saldo('más de dos decimales', ADMIN, 400, {
    antes: chofer(),
    body: { amount: 1.111 },
  }),
  saldo('sobre el tope', ADMIN, 400, {
    antes: chofer(),
    body: { amount: 1000001 },
  }),
  saldo('bajo el tope', ADMIN, 400, {
    antes: chofer(),
    body: { amount: -1000001 },
  }),
  saldo('campo extra', ADMIN, 400, {
    antes: chofer(),
    body: { amount: 1, ajeno: 1 },
  }),
  inexistente(saldo, '/balance', { amount: 1 }),
  saldo('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...noCambiaElChofer(),
    body: { amount: 1 },
  }),
  superSinTenant(saldo, { amount: 1 }),
  ...bordes(saldo, {
    prohibidos: SOLO_ADMIN,
    body: {},
    idMalo: '/delivery/no/balance',
  }),

  estado('deshabilita y lo desconecta', ADMIN, 200, {
    antes: async (c) => {
      await chofer()(c);
      await marcarChofer(c, c.ch.c.deliveryId, { isAvailable: true });
    },
    body: { isEnabled: false },
    verificar: async (_b, c) => {
      const fila = await c.app
        .get(DataSource)
        .getRepository(Delivery)
        .findOneByOrFail({ deliveryId: c.ch.c.deliveryId });
      expect(fila).toMatchObject({ isEnabled: false, isAvailable: false });
    },
  }),
  estado('habilita', ADMIN, 200, {
    verificar: (b) => expect(b).toMatchObject({ isEnabled: true }),
    antes: chofer(),
    body: { isEnabled: true },
  }),
  estado('falta el campo', ADMIN, 400, { antes: chofer(), body: {} }),
  estado('booleano inválido', ADMIN, 400, {
    antes: chofer(),
    body: { isEnabled: 'si' },
  }),
  estado('campo extra', ADMIN, 400, {
    antes: chofer(),
    body: { isEnabled: true, ajeno: 1 },
  }),
  inexistente(estado, '/status', { isEnabled: true }),
  estado('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...noCambiaElChofer(),
    body: { isEnabled: false },
  }),
  superSinTenant(estado, { isEnabled: true }),
  ...bordes(estado, {
    prohibidos: SOLO_ADMIN,
    body: {},
    idMalo: '/delivery/no/status',
  }),

  baja('da de baja', ADMIN, 200, {
    antes: chofer(),
    verificar: async (_b, c) => {
      const fila = await c.app
        .get(DataSource)
        .getRepository(Delivery)
        .findOneBy({ deliveryId: c.ch.c.deliveryId });
      expect(fila).toBeNull();
    },
  }),
  baja('tiene un pedido en curso', ADMIN, 409, {
    antes: async (c) => {
      await chofer()(c);
      await pedidoDe(c, c.ch.c, OrderStatus.ACCEPTED);
    },
    mensaje: /pedido\(s\) en curso/,
  }),
  baja('tiene una carga de camión abierta', ADMIN, 409, {
    antes: async (c) => {
      c.ch.c = (await sembrarCarga(c, { estado: 'loading' })).chofer;
    },
    mensaje: /carga de camión abierta/,
  }),
  baja('con legajo y una rendición sin cerrar', ADMIN, 409, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c, { legajo: true });
      await sembrarRendicion(c, { estado: 'open', chofer: c.ch.c });
    },
    mensaje: /rendición pendiente/,
  }),
  baja('con legajo y efectivo sin rendir', ADMIN, 409, {
    antes: async (c) => {
      c.ch.c = await nuevoChofer(c, { legajo: true });
      await pedidoDe(c, c.ch.c, OrderStatus.DELIVERED);
    },
    mensaje: /efectivo sin rendir/,
  }),
  inexistente(baja, ''),
  baja('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...noCambiaElChofer(),
  }),
  superSinTenant(baja),
  ...bordes(baja, { prohibidos: SOLO_ADMIN, idMalo: '/delivery/no' }),

  disponibilidad('el chofer se conecta', undefined, 200, {
    antes: chofer(),
    cabeceras: comoChofer,
    body: { available: true },
    verificar: (b) => expect(b).toMatchObject({ isAvailable: true }),
  }),
  disponibilidad('el chofer se desconecta', undefined, 200, {
    verificar: (b) => expect(b).toMatchObject({ isAvailable: false }),
    antes: chofer(),
    cabeceras: comoChofer,
    body: { available: false },
  }),
  disponibilidad('un administrador de la distribuidora', ADMIN, 200, {
    verificar: (b) => expect(b).toMatchObject({ isAvailable: false }),
    antes: chofer(),
    body: { available: false },
  }),
  disponibilidad('falta el campo', undefined, 400, {
    antes: chofer(),
    cabeceras: comoChofer,
    body: {},
  }),
  disponibilidad('booleano inválido', undefined, 400, {
    antes: chofer(),
    cabeceras: comoChofer,
    body: { available: 1 },
  }),
  disponibilidad('campo extra', undefined, 400, {
    antes: chofer(),
    cabeceras: comoChofer,
    body: { available: true, ajeno: 1 },
  }),
  disponibilidad('sobre otro chofer', 'choferA2', 403, {
    antes: chofer(),
    body: { available: false },
    mensaje: /otro chofer/,
  }),
  disponibilidad('deshabilitado no se pone en línea', undefined, 403, {
    antes: async (c) => {
      await chofer()(c);
      await marcarChofer(c, c.ch.c.deliveryId, { isEnabled: false });
    },
    cabeceras: comoChofer,
    body: { available: true },
    mensaje: /deshabilitada/,
  }),
  disponibilidad('sin validar no se pone en línea', undefined, 403, {
    antes: async (c) => {
      await chofer()(c);
      await marcarChofer(c, c.ch.c.deliveryId, { validated: false });
    },
    cabeceras: comoChofer,
    body: { available: true },
    mensaje: /no fue validado/,
  }),
  disponibilidad('deshabilitado sí se desconecta', undefined, 200, {
    verificar: (b) => expect(b).toMatchObject({ isAvailable: false }),
    antes: async (c) => {
      await chofer()(c);
      await marcarChofer(c, c.ch.c.deliveryId, { isEnabled: false });
    },
    cabeceras: comoChofer,
    body: { available: false },
  }),
  disponibilidad('usuario que no es chofer', ADMIN, 404, {
    ruta: (c) => `/delivery/user/${c.clienteA.userId}/availability`,
    body: { available: false },
  }),
  disponibilidad('inexistente', ADMIN, 404, {
    ruta: (c) => `/delivery/user/${c.inexistente}/availability`,
    body: { available: false },
  }),
  disponibilidad('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...noCambiaElChofer(),
    body: { available: true },
  }),
  disponibilidad('super admin sin distribuidora', 'super', 400, {
    antes: chofer(),
    body: { available: false },
  }),
  ...bordes(disponibilidad, {
    prohibidos: ADMIN_O_CHOFER,
    body: {},
    idMalo: '/delivery/user/no/availability',
  }),
];

/** Otro chofer de la A con un vehículo propio en uso. */
const tenedor = async (c: C): Promise<ChoferT5> => nuevoChofer(c);
const noCambiaLaAsignacion = () =>
  sinCambios('vehicle_assignment', 'delivery_id', filaDelChofer, conAjeno);

const casosVehiculo: Array<Caso<C>> = [
  vehiculo('con vehículo en uso', ADMIN, 200, {
    antes: chofer(),
    verificar: (b, c) => expect(b).toMatchObject({ carId: c.ch.c.carId }),
  }),
  vehiculo('sin vehículo en uso', ADMIN, 200, {
    verificar: (b) => expect(b).toEqual({}),
    antes: chofer('A', { vehiculo: false }),
  }),
  inexistente(vehiculo, '/vehicle'),
  vehiculo('de otra distribuidora', ADMIN, 404, { antes: conAjeno }),
  vehiculo('super admin sin distribuidora', 'super', 400, { antes: chofer() }),
  ...bordes(vehiculo, {
    prohibidos: SOLO_ADMIN,
    idMalo: '/delivery/no/vehicle',
  }),

  miVehiculo('con vehículo en uso', undefined, 200, {
    antes: chofer(),
    cabeceras: comoChofer,
    verificar: (b, c) => expect(b).toMatchObject({ carId: c.ch.c.carId }),
  }),
  miVehiculo('sin vehículo en uso', undefined, 200, {
    verificar: (b) => expect(b).toEqual({}),
    antes: chofer('A', { vehiculo: false }),
    cabeceras: comoChofer,
  }),
  miVehiculo('usuario sin perfil de chofer', undefined, 401, {
    antes: async (c) => {
      c.ch.c = await choferSinPerfil(c);
    },
    cabeceras: comoChofer,
  }),
  ...bordes(miVehiculo, { prohibidos: ['adminA', 'super', 'clienteA'] }),

  asignar('pone el vehículo en uso', ADMIN, 200, {
    antes: chofer(),
    body: (c) => ({ carId: c.autoA, note: 'Reemplazo' }),
    verificar: (b, c) => expect(b).toMatchObject({ carId: c.autoA }),
  }),
  asignar('el mismo vehículo: no cambia', ADMIN, 200, {
    ...sinCambios('vehicle_assignment', 'delivery_id', filaDelChofer, chofer()),
    body: (c) => ({ carId: c.ch.c.carId }),
  }),
  asignar('dto requerido', ADMIN, 400, { antes: chofer(), body: {} }),
  asignar('vehículo no es UUID', ADMIN, 400, {
    antes: chofer(),
    body: { carId: 'x' },
  }),
  asignar('nota no es texto', ADMIN, 400, {
    antes: chofer(),
    body: (c) => ({ carId: c.autoA, note: 5 }),
  }),
  asignar('campo extra', ADMIN, 400, {
    antes: chofer(),
    body: (c) => ({ carId: c.autoA, ajeno: 1 }),
  }),
  asignar('vehículo con documentación vencida', ADMIN, 400, {
    antes: async (c) => {
      await chofer()(c);
      c.ch.vencido = await tenedor(c);
      await vencerDocumento(c, { carId: c.ch.vencido.carId });
    },
    body: (c) => ({ carId: c.ch.vencido.carId }),
    mensaje: /No se puede asignar/,
  }),
  asignar('inexistente', ADMIN, 404, {
    ruta: (c) => `/delivery/${c.inexistente}/vehicle`,
    body: (c) => ({ carId: c.autoA }),
  }),
  asignar('vehículo inexistente', ADMIN, 404, {
    antes: chofer(),
    body: (c) => ({ carId: c.inexistente }),
  }),
  asignar('vehículo de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambiosEn(
      [
        {
          tabla: 'vehicle_assignment',
          columna: 'delivery_id',
          id: filaDelChofer,
        },
        { tabla: 'vehicle_assignment', columna: 'car_id', id: (c) => c.autoB },
        { tabla: 'car', columna: 'car_id', id: (c) => c.autoB },
      ],
      chofer(),
    ),
    body: (c) => ({ carId: c.autoB }),
  }),
  asignar('chofer de otra distribuidora no cambia nada', ADMIN, 404, {
    ...noCambiaLaAsignacion(),
    body: (c) => ({ carId: c.autoA }),
  }),
  asignar('super admin sin distribuidora', 'super', 400, {
    antes: chofer(),
    body: (c) => ({ carId: c.autoA }),
  }),
  asignar('el chofer tiene un pedido en curso', ADMIN, 409, {
    antes: async (c) => {
      await chofer()(c);
      await pedidoDe(c, c.ch.c, OrderStatus.ON_THE_WAY);
    },
    body: (c) => ({ carId: c.autoA }),
    mensaje: /pedido en curso/,
  }),
  asignar('se lo saca a otro con un pedido en curso', ADMIN, 409, {
    antes: async (c) => {
      await chofer()(c);
      c.ch.otro = await tenedor(c);
      await pedidoDe(c, c.ch.otro, OrderStatus.ACCEPTED);
    },
    body: (c) => ({ carId: c.ch.otro.carId }),
    mensaje: /pedido en curso/,
  }),
  asignar('el chofer tiene una carga abierta', ADMIN, 409, {
    antes: async (c) => {
      c.ch.c = (await sembrarCarga(c)).chofer;
    },
    body: (c) => ({ carId: c.autoA }),
    mensaje: /carga de camión abierta/,
  }),
  asignar('vehículo fuera de servicio', ADMIN, 409, {
    antes: async (c) => {
      await chofer()(c);
      c.ch.otro = await nuevoChofer(c, { vehiculo: false });
      await dejarFueraDeServicio(c, c.ch.otro.carId);
    },
    body: (c) => ({ carId: c.ch.otro.carId }),
    mensaje: /fuera de servicio/,
  }),
  ...bordes(asignar, {
    prohibidos: SOLO_ADMIN,
    body: {},
    idMalo: '/delivery/no/vehicle',
  }),

  liberar('libera el vehículo', ADMIN, 200, {
    antes: chofer(),
    verificar: async (_b, c) => {
      const [fila] = await c.app
        .get(DataSource)
        .query<
          Array<{ abiertas: number }>
        >(`SELECT count(*)::int AS abiertas FROM vehicle_assignment WHERE delivery_id = $1 AND released_at IS NULL`, [c.ch.c.deliveryId]);
      expect(fila.abiertas).toBe(0);
    },
  }),
  liberar('no tiene vehículo en uso', ADMIN, 404, {
    antes: chofer('A', { vehiculo: false }),
    mensaje: /no tiene un vehículo en uso/,
  }),
  inexistente(liberar, '/vehicle'),
  liberar('chofer de otra distribuidora no cambia nada', ADMIN, 404, {
    ...noCambiaLaAsignacion(),
  }),
  liberar('super admin sin distribuidora', 'super', 400, { antes: chofer() }),
  liberar('tiene un pedido en curso', ADMIN, 409, {
    antes: async (c) => {
      await chofer()(c);
      await pedidoDe(c, c.ch.c, OrderStatus.ACCEPTED);
    },
    mensaje: /pedido en curso/,
  }),
  liberar('tiene una carga abierta', ADMIN, 409, {
    antes: async (c) => {
      c.ch.c = (await sembrarCarga(c)).chofer;
    },
    mensaje: /carga de camión abierta/,
  }),
  ...bordes(liberar, {
    prohibidos: SOLO_ADMIN,
    idMalo: '/delivery/no/vehicle',
  }),

  historial('consulta', ADMIN, 200, {
    antes: chofer(),
    verificar: (b) => expect((b as unknown[]).length).toBe(1),
  }),
  historial('limit cero', ADMIN, 400, {
    antes: chofer(),
    ruta: (c) => `/delivery/${c.ch.c.deliveryId}/vehicle-history?limit=0`,
  }),
  historial('limit sobre el tope', ADMIN, 400, {
    antes: chofer(),
    ruta: (c) => `/delivery/${c.ch.c.deliveryId}/vehicle-history?limit=101`,
  }),
  historial('offset negativo', ADMIN, 400, {
    antes: chofer(),
    ruta: (c) => `/delivery/${c.ch.c.deliveryId}/vehicle-history?offset=-1`,
  }),
  inexistente(historial, '/vehicle-history'),
  historial('de otra distribuidora', ADMIN, 404, { antes: conAjeno }),
  historial('super admin sin distribuidora', 'super', 400, {
    antes: chofer(),
  }),
  ...bordes(historial, {
    prohibidos: SOLO_ADMIN,
    idMalo: '/delivery/no/vehicle-history',
  }),

  documentos('sin documentación', ADMIN, 200, {
    antes: chofer(),
    verificar: (b) => expect(b).toMatchObject({ tasks: [], isLocked: false }),
  }),
  documentos('con la licencia vencida: inhabilitado', ADMIN, 200, {
    antes: async (c) => {
      await chofer()(c);
      await vencerDocumento(c, { deliveryId: c.ch.c.deliveryId });
    },
    verificar: (b) => expect(b).toMatchObject({ isLocked: true }),
  }),
  inexistente(documentos, '/documents'),
  documentos('de otra distribuidora', ADMIN, 404, { antes: conAjeno }),
  documentos('super admin sin distribuidora', 'super', 400, {
    antes: chofer(),
  }),
  ...bordes(documentos, {
    prohibidos: SOLO_ADMIN,
    idMalo: '/delivery/no/documents',
  }),
];

/** Matriz T5: perfil, disponibilidad, vehículo y documentación del chofer. */
describe('Matriz HTTP T5: entregas (e2e)', () => {
  let env: TestEnv;
  let ctx: C;
  beforeAll(async () => {
    env = await createTestApp();
    ctx = await sembrarBaseT5(env);
  }, 240000);
  afterAll(async () => env.cleanup());
  const ver = () => ctx;

  correrMatriz('lecturas', ver, casosLecturas);
  correrMatriz('escrituras', ver, casosEscritura);
  correrMatriz('vehículo y documentos', ver, casosVehiculo);
});
