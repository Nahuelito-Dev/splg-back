import { createTestApp, TestEnv } from '../setup/test-env';
import { Caso, correrMatriz, endpoint, Metodo } from './matriz';
import { EscenarioT7, sembrarBaseT7 } from './t7-base';
import { casosEnModoSoporte } from './soporte';

type C = EscenarioT7;
const ADMIN = 'adminA';
const sinToken = (metodo: Metodo, swagger: string, ruta: string): Caso<C> => ({
  endpoint: `${metodo.toUpperCase()} ${swagger}`,
  caso: 'sin token',
  metodo,
  ruta,
  esperado: 401,
});

const tareas = endpoint<C>('get', '/v2/fleet/tasks', '/v2/fleet/tasks');
const tarea = endpoint<C>(
  'get',
  '/v2/fleet/tasks/{id}',
  (c) => `/v2/fleet/tasks/${c.tareaA}`,
);
const casosPlanner = endpoint<C>(
  'get',
  '/v2/fleet/maintenance-planner',
  '/v2/fleet/maintenance-planner',
);
const pronostico = endpoint<C>(
  'get',
  '/v2/fleet/maintenance-planner/forecast',
  '/v2/fleet/maintenance-planner/forecast',
);
const ajustes = endpoint<C>(
  'get',
  '/v2/fleet/maintenance-planner/settings',
  '/v2/fleet/maintenance-planner/settings',
);
const ajustesChofer = endpoint<C>(
  'get',
  '/v2/driver/maintenance-proposals/settings',
  '/v2/driver/maintenance-proposals/settings',
);
const propuestas = endpoint<C>(
  'get',
  '/v2/driver/maintenance-proposals',
  '/v2/driver/maintenance-proposals',
);

const casos: Array<Caso<C>> = [
  tareas('lista tareas con pago', ADMIN, 200),
  tareas('filtro inválido', ADMIN, 400, { ruta: '/v2/fleet/tasks?limit=0' }),
  tareas('rol sin permiso', 'clienteA', 403),
  tarea('lee tarea propia', ADMIN, 200),
  tarea('id inválido', ADMIN, 400, { ruta: '/v2/fleet/tasks/no' }),
  tarea('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/fleet/tasks/${c.inexistente}`,
  }),
  tarea('de otro tenant', ADMIN, 404, {
    ruta: (c) => `/v2/fleet/tasks/${c.tareaB}`,
  }),
  casosPlanner('lista casos del planificador', ADMIN, 200),
  casosPlanner('paginación inválida', ADMIN, 400, {
    ruta: '/v2/fleet/maintenance-planner?limit=0',
  }),
  casosPlanner('rol sin permiso', 'clienteA', 403),
  pronostico('consulta pronóstico', ADMIN, 200),
  pronostico('vehículo inválido', ADMIN, 400, {
    ruta: '/v2/fleet/maintenance-planner/forecast?carId=no',
  }),
  pronostico('rol sin permiso', 'clienteA', 403),
  ajustes('consulta parámetros', ADMIN, 200),
  ajustes('rol sin permiso', 'clienteA', 403),
  ajustesChofer('chofer consulta parámetros', 'chofer', 200),
  ajustesChofer('admin no puede consultar', ADMIN, 403),
  propuestas('chofer lista sus propuestas', 'chofer', 200),
  propuestas('paginación inválida', 'chofer', 400, {
    ruta: '/v2/driver/maintenance-proposals?limit=0',
  }),

  {
    endpoint: 'POST /v2/fleet/tasks/{id}/close',
    caso: 'cuerpo vacío',
    metodo: 'post',
    ruta: (c) => `/v2/fleet/tasks/${c.tareaA}/close`,
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'POST /v2/fleet/tasks/{id}/close',
    caso: 'id inválido',
    metodo: 'post',
    ruta: '/v2/fleet/tasks/no/close',
    actor: ADMIN,
    body: { performedAt: '2026-01-01' },
    esperado: 400,
    mensajeExacto: 'El identificador no es válido',
  },
  {
    endpoint: 'POST /v2/fleet/tasks/{id}/pay',
    caso: 'cuerpo vacío',
    metodo: 'post',
    ruta: (c) => `/v2/fleet/tasks/${c.tareaA}/pay`,
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'POST /v2/fleet/tasks/{id}/pay',
    caso: 'id inválido',
    metodo: 'post',
    ruta: '/v2/fleet/tasks/no/pay',
    actor: ADMIN,
    body: (c) => ({ cashBoxId: c.inexistente, paidAt: '2026-01-01' }),
    esperado: 400,
    mensajeExacto: 'El identificador no es válido',
  },
  {
    endpoint: 'PATCH /v2/fleet/maintenance-planner/settings',
    caso: 'valor fuera de rango',
    metodo: 'patch',
    ruta: '/v2/fleet/maintenance-planner/settings',
    actor: ADMIN,
    body: { cronHour: 24 },
    esperado: 400,
  },
  {
    endpoint: 'GET /v2/fleet/maintenance-planner/cases/{id}',
    caso: 'id inválido',
    metodo: 'get',
    ruta: '/v2/fleet/maintenance-planner/cases/no',
    actor: ADMIN,
    esperado: 400,
  },
  {
    endpoint: 'POST /v2/fleet/maintenance-planner/cases/{id}/confirm',
    caso: 'id inválido',
    metodo: 'post',
    ruta: '/v2/fleet/maintenance-planner/cases/no/confirm',
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'POST /v2/fleet/maintenance-planner/cases/{id}/cancel',
    caso: 'id inválido',
    metodo: 'post',
    ruta: '/v2/fleet/maintenance-planner/cases/no/cancel',
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'POST /v2/fleet/maintenance-planner/tasks/{taskId}/force-window',
    caso: 'cuerpo vacío',
    metodo: 'post',
    ruta: (c) => `/v2/fleet/maintenance-planner/tasks/${c.tareaA}/force-window`,
    actor: ADMIN,
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'POST /v2/fleet/maintenance-planner/tasks/{taskId}/force-window',
    caso: 'id inválido',
    metodo: 'post',
    ruta: '/v2/fleet/maintenance-planner/tasks/no/force-window',
    actor: ADMIN,
    body: {
      windowStart: '2030-01-01T09:00:00-03:00',
      windowEnd: '2030-01-01T11:00:00-03:00',
    },
    esperado: 400,
    mensajeExacto: 'El identificador no es válido',
  },
  {
    endpoint: 'POST /v2/fleet/maintenance-planner/tasks/{taskId}/replan',
    caso: 'id inválido',
    metodo: 'post',
    ruta: '/v2/fleet/maintenance-planner/tasks/no/replan',
    actor: ADMIN,
    esperado: 400,
  },
  {
    endpoint: 'GET /v2/driver/maintenance-proposals/{id}',
    caso: 'id inválido',
    metodo: 'get',
    ruta: '/v2/driver/maintenance-proposals/no',
    actor: 'chofer',
    esperado: 400,
  },
  {
    endpoint: 'POST /v2/driver/maintenance-proposals/{id}/accept',
    caso: 'id inválido',
    metodo: 'post',
    ruta: '/v2/driver/maintenance-proposals/no/accept',
    actor: 'chofer',
    esperado: 400,
  },
  {
    endpoint: 'POST /v2/driver/maintenance-proposals/{id}/reject',
    caso: 'cuerpo vacío',
    metodo: 'post',
    ruta: (c) => `/v2/driver/maintenance-proposals/${c.inexistente}/reject`,
    actor: 'chofer',
    body: {},
    esperado: 400,
  },
  {
    endpoint: 'POST /v2/driver/maintenance-proposals/{id}/reject',
    caso: 'id inválido',
    metodo: 'post',
    ruta: '/v2/driver/maintenance-proposals/no/reject',
    actor: 'chofer',
    body: { reason: 'No puedo ese día' },
    esperado: 400,
    mensajeExacto: 'El identificador no es válido',
  },

  sinToken('post', '/v2/fleet/tasks/{id}/close', '/v2/fleet/tasks/no/close'),
  sinToken('post', '/v2/fleet/tasks/{id}/pay', '/v2/fleet/tasks/no/pay'),
  sinToken(
    'patch',
    '/v2/fleet/maintenance-planner/settings',
    '/v2/fleet/maintenance-planner/settings',
  ),
  sinToken(
    'post',
    '/v2/fleet/maintenance-planner/run',
    '/v2/fleet/maintenance-planner/run',
  ),
  sinToken(
    'get',
    '/v2/fleet/maintenance-planner/cases/{id}',
    '/v2/fleet/maintenance-planner/cases/no',
  ),
  sinToken(
    'post',
    '/v2/fleet/maintenance-planner/cases/{id}/confirm',
    '/v2/fleet/maintenance-planner/cases/no/confirm',
  ),
  sinToken(
    'post',
    '/v2/fleet/maintenance-planner/cases/{id}/cancel',
    '/v2/fleet/maintenance-planner/cases/no/cancel',
  ),
  sinToken(
    'post',
    '/v2/fleet/maintenance-planner/tasks/{taskId}/force-window',
    '/v2/fleet/maintenance-planner/tasks/no/force-window',
  ),
  sinToken(
    'post',
    '/v2/fleet/maintenance-planner/tasks/{taskId}/replan',
    '/v2/fleet/maintenance-planner/tasks/no/replan',
  ),
  sinToken(
    'get',
    '/v2/driver/maintenance-proposals/{id}',
    '/v2/driver/maintenance-proposals/no',
  ),
  sinToken(
    'post',
    '/v2/driver/maintenance-proposals/{id}/accept',
    '/v2/driver/maintenance-proposals/no/accept',
  ),
  sinToken(
    'post',
    '/v2/driver/maintenance-proposals/{id}/reject',
    '/v2/driver/maintenance-proposals/no/reject',
  ),
  sinToken('get', '/v2/fleet/tasks', '/v2/fleet/tasks'),
  sinToken(
    'get',
    '/v2/fleet/maintenance-planner',
    '/v2/fleet/maintenance-planner',
  ),
  sinToken(
    'get',
    '/v2/fleet/maintenance-planner/forecast',
    '/v2/fleet/maintenance-planner/forecast',
  ),
  sinToken(
    'get',
    '/v2/fleet/maintenance-planner/settings',
    '/v2/fleet/maintenance-planner/settings',
  ),
  sinToken(
    'get',
    '/v2/driver/maintenance-proposals',
    '/v2/driver/maintenance-proposals',
  ),
  sinToken(
    'get',
    '/v2/driver/maintenance-proposals/settings',
    '/v2/driver/maintenance-proposals/settings',
  ),
];

describe('Matriz HTTP T7 · flota v2', () => {
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
      tareas,
      endpoint<C>('patch', '/orders/{id}', (c) => `/orders/${c.inexistente}`),
    ),
  );
  correrMatriz('Fleet v2', () => ctx, casos);
});
