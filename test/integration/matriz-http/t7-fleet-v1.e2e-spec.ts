import { createTestApp, TestEnv } from '../setup/test-env';
import { Caso, correrMatriz, endpoint, Metodo } from './matriz';
import { EscenarioT7, sembrarBaseT7 } from './t7-base';
import { casosEnModoSoporte } from './soporte';

/**
 * Rutas v1 de Fleet. Las altas y transiciones que requieren un estado especial
 * se preparan en suites de dominio; acá queda la matriz HTTP de cada fachada,
 * incluidos los límites de autenticación y tenant de todos los controladores.
 */
type C = EscenarioT7;
const ADMIN = 'adminA';
const uuidAjeno = (c: C) => c.inexistente;

const sinToken = (metodo: Metodo, swagger: string, ruta: string): Caso<C> => ({
  endpoint: `${metodo.toUpperCase()} ${swagger}`,
  caso: 'sin token',
  metodo,
  ruta,
  esperado: 401,
});

const planes = endpoint<C>('get', '/fleet/plans', '/fleet/plans');
const plan = endpoint<C>(
  'get',
  '/fleet/plans/{id}',
  (c) => `/fleet/plans/${c.planA}`,
);
const tareas = endpoint<C>('get', '/fleet/tasks', '/fleet/tasks');
const tarea = endpoint<C>(
  'get',
  '/fleet/tasks/{id}',
  (c) => `/fleet/tasks/${c.tareaA}`,
);
const vencimientos = endpoint<C>(
  'get',
  '/fleet/expirations',
  '/fleet/expirations',
);
const documentosAuto = endpoint<C>(
  'get',
  '/cars/{carId}/documents',
  (c) => `/cars/${c.autoA}/documents`,
);
const historialAuto = endpoint<C>(
  'get',
  '/car/{id}/assignments',
  (c) => `/car/${c.autoA}/assignments`,
);
const vehiculoChofer = endpoint<C>(
  'get',
  '/delivery/{id}/vehicle',
  (c) => `/delivery/${c.choferA.deliveryId}/vehicle`,
);
const historialChofer = endpoint<C>(
  'get',
  '/delivery/{id}/vehicle-history',
  (c) => `/delivery/${c.choferA.deliveryId}/vehicle-history`,
);
const documentosChofer = endpoint<C>(
  'get',
  '/delivery/{id}/documents',
  (c) => `/delivery/${c.choferA.deliveryId}/documents`,
);
const miVehiculo = endpoint<C>(
  'get',
  '/delivery/me/vehicle',
  '/delivery/me/vehicle',
);

const casos: Array<Caso<C>> = [
  planes('lista planes propios', ADMIN, 200),
  planes('filtro inválido', ADMIN, 400, { ruta: '/fleet/plans?active=quizás' }),
  planes('rol sin permiso', 'clienteA', 403),
  planes('sin token', undefined, 401),
  plan('lee plan propio', ADMIN, 200),
  plan('id inválido', ADMIN, 400, { ruta: '/fleet/plans/no' }),
  plan('inexistente', ADMIN, 404, {
    ruta: (c) => `/fleet/plans/${uuidAjeno(c)}`,
  }),
  plan('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/fleet/plans/${c.planB}`,
  }),
  plan('sin token', undefined, 401),
  plan('rol sin permiso', 'clienteA', 403),
  tareas('lista tareas propias', ADMIN, 200),
  tareas('filtro inválido', ADMIN, 400, { ruta: '/fleet/tasks?limit=0' }),
  tareas('sin token', undefined, 401),
  tarea('lee tarea propia', ADMIN, 200),
  tarea('id inválido', ADMIN, 400, { ruta: '/fleet/tasks/no' }),
  tarea('inexistente', ADMIN, 404, {
    ruta: (c) => `/fleet/tasks/${uuidAjeno(c)}`,
  }),
  tarea('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/fleet/tasks/${c.tareaB}`,
  }),
  tarea('sin token', undefined, 401),
  tarea('rol sin permiso', 'clienteA', 403),
  vencimientos('consulta vencimientos', ADMIN, 200),
  vencimientos('filtro inválido', ADMIN, 400, {
    ruta: '/fleet/expirations?withinDays=-1',
  }),
  vencimientos('sin token', undefined, 401),
  vencimientos('rol sin permiso', 'clienteA', 403),
  documentosAuto('lee documentos del vehículo', ADMIN, 200),
  documentosAuto('id inválido', ADMIN, 400, { ruta: '/cars/no/documents' }),
  documentosAuto('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/cars/${c.autoB}/documents`,
  }),
  documentosAuto('inexistente', ADMIN, 404, {
    ruta: (c) => `/cars/${c.inexistente}/documents`,
  }),
  documentosAuto('sin token', undefined, 401),
  documentosAuto('rol sin permiso', 'clienteA', 403),
  historialAuto('lee historial del vehículo', ADMIN, 200),
  historialAuto('paginación inválida', ADMIN, 400, {
    ruta: (c) => `/car/${c.autoA}/assignments?limit=0`,
  }),
  historialAuto('id inválido', ADMIN, 400, { ruta: '/car/no/assignments' }),
  historialAuto('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/car/${c.autoB}/assignments`,
  }),
  historialAuto('sin token', undefined, 401),
  historialAuto('rol sin permiso', 'clienteA', 403),
  vehiculoChofer('lee vehículo en uso', ADMIN, 200),
  vehiculoChofer('id inválido', ADMIN, 400, { ruta: '/delivery/no/vehicle' }),
  vehiculoChofer('inexistente', ADMIN, 404, {
    ruta: (c) => `/delivery/${c.inexistente}/vehicle`,
  }),
  vehiculoChofer('sin token', undefined, 401),
  vehiculoChofer('rol sin permiso', 'clienteA', 403),
  historialChofer('lee historial del chofer', ADMIN, 200),
  historialChofer('id inválido', ADMIN, 400, {
    ruta: '/delivery/no/vehicle-history',
  }),
  historialChofer('inexistente', ADMIN, 404, {
    ruta: (c) => `/delivery/${c.inexistente}/vehicle-history`,
  }),
  historialChofer('sin token', undefined, 401),
  historialChofer('rol sin permiso', 'clienteA', 403),
  documentosChofer('lee documentos del chofer', ADMIN, 200),
  documentosChofer('id inválido', ADMIN, 400, {
    ruta: '/delivery/no/documents',
  }),
  documentosChofer('inexistente', ADMIN, 404, {
    ruta: (c) => `/delivery/${c.inexistente}/documents`,
  }),
  documentosChofer('sin token', undefined, 401),
  documentosChofer('rol sin permiso', 'clienteA', 403),
  miVehiculo('chofer consulta su vehículo', 'chofer', 200),
  miVehiculo('otro rol no puede consultar', ADMIN, 403),

  {
    endpoint: 'POST /fleet/plans',
    caso: 'DTO vacío',
    metodo: 'post',
    ruta: '/fleet/plans',
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'PATCH /fleet/plans/{id}',
    caso: 'id inválido',
    metodo: 'patch',
    ruta: '/fleet/plans/no',
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'POST /fleet/tasks',
    caso: 'DTO vacío',
    metodo: 'post',
    ruta: '/fleet/tasks',
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'PATCH /fleet/tasks/{id}',
    caso: 'id inválido',
    metodo: 'patch',
    ruta: '/fleet/tasks/no',
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'PATCH /fleet/tasks/{id}/close',
    caso: 'cuerpo vacío',
    metodo: 'patch',
    ruta: (c) => `/fleet/tasks/${c.tareaA}/close`,
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'PATCH /fleet/tasks/{id}/close',
    caso: 'id inválido',
    metodo: 'patch',
    ruta: '/fleet/tasks/no/close',
    actor: ADMIN,
    body: { performedAt: '2026-01-01' },
    esperado: 400,
    mensajeExacto: 'El identificador no es válido',
  },
  {
    endpoint: 'PATCH /fleet/tasks/{id}/cancel',
    caso: 'id inválido',
    metodo: 'patch',
    ruta: '/fleet/tasks/no/cancel',
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'POST /fleet/tasks/{id}/attachments',
    caso: 'falta el archivo',
    metodo: 'post',
    ruta: (c) => `/fleet/tasks/${c.tareaA}/attachments`,
    actor: ADMIN,
    esperado: 400,
  },

  sinToken('post', '/fleet/plans', '/fleet/plans'),
  sinToken('patch', '/fleet/plans/{id}', '/fleet/plans/no'),
  sinToken('post', '/fleet/tasks', '/fleet/tasks'),
  sinToken('patch', '/fleet/tasks/{id}', '/fleet/tasks/no'),
  sinToken('patch', '/fleet/tasks/{id}/close', '/fleet/tasks/no/close'),
  sinToken('patch', '/fleet/tasks/{id}/cancel', '/fleet/tasks/no/cancel'),
  sinToken(
    'post',
    '/fleet/tasks/{id}/attachments',
    '/fleet/tasks/no/attachments',
  ),
  sinToken(
    'get',
    '/fleet/tasks/{id}/attachments',
    '/fleet/tasks/no/attachments',
  ),
  sinToken(
    'get',
    '/fleet/tasks/{id}/attachments/{attachmentId}/download',
    '/fleet/tasks/no/attachments/no/download',
  ),
  sinToken(
    'delete',
    '/fleet/tasks/{id}/attachments/{attachmentId}',
    '/fleet/tasks/no/attachments/no',
  ),
  sinToken('post', '/car/{id}/reactivate', '/car/no/reactivate'),
  sinToken('put', '/delivery/{id}/vehicle', '/delivery/no/vehicle'),
  sinToken('delete', '/delivery/{id}/vehicle', '/delivery/no/vehicle'),
  sinToken('get', '/employees/{id}/documents', '/employees/no/documents'),
  sinToken('get', '/fleet/expirations', '/fleet/expirations'),
  sinToken('get', '/cars/{carId}/documents', '/cars/no/documents'),
  sinToken('get', '/car/{id}/assignments', '/car/no/assignments'),
  sinToken('get', '/delivery/{id}/vehicle', '/delivery/no/vehicle'),
  sinToken(
    'get',
    '/delivery/{id}/vehicle-history',
    '/delivery/no/vehicle-history',
  ),
  sinToken('get', '/delivery/{id}/documents', '/delivery/no/documents'),
  sinToken('get', '/delivery/me/vehicle', '/delivery/me/vehicle'),
];

describe('Matriz HTTP T7 · flota v1', () => {
  let env: TestEnv;
  let ctx: C;
  beforeAll(async () => {
    env = await createTestApp();
    ctx = await sembrarBaseT7(env);
  });
  afterAll(async () => env?.cleanup());
  // Modo soporte: con sesión lee lo de su empresa y no escribe; sin sesión, nada.
  correrMatriz(
    'super admin en modo soporte',
    () => ctx,
    casosEnModoSoporte(
      planes,
      endpoint<C>('patch', '/orders/{id}', (c) => `/orders/${c.inexistente}`),
    ),
  );
  correrMatriz('Fleet v1', () => ctx, casos);
});
