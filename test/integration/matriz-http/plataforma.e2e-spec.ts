/**
 * Matriz HTTP del panel de plataforma (E3 del modo soporte) y del pase del
 * monitoreo de procesos y de la frecuencia de las tareas programadas a la
 * plataforma. Contra Postgres y Redis efímeros.
 *
 * Además de la matriz:
 *  - los totales del tablero cuadran con la suma por empresa, con el SQL
 *    directo sobre `order` y con el reporte de ventas de cada empresa;
 *  - ninguna respuesta real lleva un campo sensible ni un dato de un cliente o
 *    un chofer;
 *  - la cantidad de consultas no crece con la cantidad de empresas (sin N+1);
 *  - un proceso con falla avisa a la bandeja de la plataforma, no a la empresa.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Distributor } from '../../../src/distributor/entities/distributor.entity';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../../src/order/entities/order.entity';
import {
  ProcessName,
  ProcessRunStatus,
  RunTrigger,
} from '../../../src/process-run/domain/process-catalog';
import { ProcessRun } from '../../../src/process-run/entities/process-run.entity';
import { ProcessRunWatchCron } from '../../../src/process-run/process-run-watch.cron';
import { TestEnv, createTestApp } from '../setup/test-env';
import {
  Caso,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
  sembrarEscenario,
} from './matriz';
import { CODIGO_SIN_SESION, CODIGO_SOLO_LECTURA } from './soporte';
import { EscenarioT2, sembrarBaseT2, sembrarPedido } from './t2-base';

type Ctx = EscenarioT2;

/** Nombres de campo que ninguna respuesta de plataforma puede tener. */
const SENSIBLE =
  /phone|tel[eé]fono|dni|documentnumber|cuil|cbu|alias|bank|token|secret|password|credential|accesskey|firebase|address|street|location|latitude|longitude/i;

type Json = null | string | number | boolean | Json[] | { [k: string]: Json };

/** Las rutas `a.b[].c` de todas las claves de un JSON. */
function claves(v: Json, prefijo = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => claves(x, `${prefijo}[]`));
  if (v && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) => [
      `${prefijo}.${k}`,
      ...claves(x, `${prefijo}.${k}`),
    ]);
  }
  return [];
}

/** Los correos permitidos: contacto de la empresa y admins (cuentas del panel). */
const CORREO_PERMITIDO = /(\.company\.contactEmail|\.admins\[\]\.email)$/;

const HOY = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const PRIMERO = `${HOY.slice(0, 7)}-01`;

describe('Matriz HTTP: panel de plataforma (E3, e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  let ds: DataSource;
  const ver = () => ctx;
  /** Empresas vacías extra (para probar que no hay N+1). */
  const extras: string[] = [];

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    const c = await sembrarBaseT2(env.app, await sembrarEscenario(env.app));
    c.reiniciarCupos = () => reiniciarCuposDelThrottler(env);
    ctx = c;
    ds = env.app.get(DataSource);
    // A: dos ventas (entregado y cobrado), un entregado impago y uno pendiente.
    const pagado = {
      estado: OrderStatus.DELIVERED,
      pago: PaymentStatus.PAID,
    } as const;
    await sembrarPedido(c, { ...pagado, cantidad: 2 });
    await sembrarPedido(c, {
      ...pagado,
      metodo: PaymentMethod.TRANSFER,
      cantidad: 3,
    });
    await sembrarPedido(c, {
      estado: OrderStatus.DELIVERED,
      pago: PaymentStatus.UNPAID,
    });
    await sembrarPedido(c);
    // B: una venta y un pendiente.
    await sembrarPedido(c, { ...pagado, cliente: 'B', chofer: 'B' });
    await sembrarPedido(c, { cliente: 'B' });
    // Una corrida fallida de A y una global atrasada (para procesos y avisos).
    await ds.getRepository(ProcessRun).save([
      {
        process: ProcessName.CYLINDER_RECOVERY,
        distributorId: c.distA.id,
        startedAt: new Date(Date.now() - 3600_000),
        finishedAt: new Date(Date.now() - 3500_000),
        status: ProcessRunStatus.FAILED,
        error: 'Falló la consulta de envases',
        trigger: RunTrigger.CRON,
        instance: 'test:1',
      } as Partial<ProcessRun>,
    ]);
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  const pedir = async (
    ruta: string,
    actor = 'super',
  ): Promise<Record<string, Json>> => {
    const res = await llamar(ctx, 'get', ruta, actor);
    expect({ ruta, estado: res.status }).toEqual({ ruta, estado: 200 });
    return res.body as Record<string, Json>;
  };

  // ---------------------------------------------------------------- matriz
  const overview = endpoint<Ctx>(
    'get',
    '/v2/platform/overview',
    '/v2/platform/overview',
  );
  const companies = endpoint<Ctx>(
    'get',
    '/v2/platform/companies',
    '/v2/platform/companies',
  );
  const ficha = endpoint<Ctx>(
    'get',
    '/v2/platform/companies/{id}',
    (c) => `/v2/platform/companies/${c.distA.id}`,
  );
  const tareas = endpoint<Ctx>(
    'get',
    '/v2/platform/companies/{id}/scheduled-tasks',
    (c) => `/v2/platform/companies/${c.distB.id}/scheduled-tasks`,
  );
  const guardarTareas = endpoint<Ctx>(
    'put',
    '/v2/platform/companies/{id}/scheduled-tasks',
    (c) => `/v2/platform/companies/${c.distB.id}/scheduled-tasks`,
  );
  const procesos = endpoint<Ctx>(
    'get',
    '/v2/platform/processes',
    '/v2/platform/processes',
  );
  const lector = endpoint<Ctx>(
    'get',
    '/v2/platform/document-reading-usage',
    '/v2/platform/document-reading-usage',
  );
  const actividad = endpoint<Ctx>(
    'get',
    '/v2/platform/activity',
    '/v2/platform/activity',
  );
  const corridas = endpoint<Ctx>('get', '/v2/process-runs', '/v2/process-runs');
  const resumenCorridas = endpoint<Ctx>(
    'get',
    '/v2/process-runs/summary',
    '/v2/process-runs/summary',
  );
  const tareasV1 = endpoint<Ctx>(
    'get',
    '/module-config/scheduled_tasks',
    '/module-config/scheduled_tasks',
  );
  const guardarTareasV1 = endpoint<Ctx>(
    'put',
    '/module-config/scheduled_tasks',
    '/module-config/scheduled_tasks',
  );

  /** 401, 403 de cada rol que no es de la plataforma y 200 del super (con y sin sesión). */
  const acceso = (
    e: ReturnType<typeof endpoint<Ctx>>,
    extra: Partial<Caso<Ctx>> = {},
  ): Array<Caso<Ctx>> => [
    e('sin token', undefined, 401, extra),
    e('admin de empresa', 'adminA', 403, extra),
    e('admin de otra empresa', 'adminB', 403, extra),
    e('chofer', 'chofer', 403, extra),
    e('cliente', 'clienteA', 403, extra),
    e('administrador general', 'super', 200, extra),
    e(
      'administrador general en una sesión de soporte (es de plataforma: puede)',
      'soporteA',
      200,
      extra,
    ),
  ];

  const casos: Array<Caso<Ctx>> = [
    ...acceso(overview),
    overview('fecha mal escrita', 'super', 400, {
      ruta: '/v2/platform/overview?from=01-11-2026',
    }),
    overview('«desde» posterior a «hasta»', 'super', 400, {
      ruta: '/v2/platform/overview?from=2026-11-10&to=2026-11-01',
    }),
    overview('más de 366 días', 'super', 400, {
      ruta: '/v2/platform/overview?from=2025-01-01&to=2026-11-01',
    }),
    overview('parámetro desconocido', 'super', 400, {
      ruta: '/v2/platform/overview?otro=1',
    }),

    ...acceso(companies),
    companies('marca de empresa propia inválida', 'super', 400, {
      ruta: '/v2/platform/companies?ownedByPlatform=quizas',
    }),
    companies('estado desconocido', 'super', 400, {
      ruta: '/v2/platform/companies?status=borrada',
    }),
    companies('límite fuera de rango', 'super', 400, {
      ruta: '/v2/platform/companies?limit=101',
    }),
    companies('desplazamiento negativo', 'super', 400, {
      ruta: '/v2/platform/companies?offset=-1',
    }),

    ...acceso(ficha),
    ficha('id mal formado', 'super', 400, {
      ruta: '/v2/platform/companies/no-es-uuid',
      code: 'INVALID_ID',
    }),
    ficha('empresa inexistente', 'super', 404, {
      ruta: (c) => `/v2/platform/companies/${c.inexistente}`,
    }),
    ficha('empresa dada de baja', 'super', 404, {
      antes: async (c) => {
        const d = (await ds.getRepository(Distributor).save({
          name: `Baja ${randomUUID().slice(0, 6)}`,
          slug: `baja-${randomUUID().slice(0, 6)}`,
        } as Partial<Distributor>)) as Distributor;
        await ds.getRepository(Distributor).softDelete(d.distributorId);
        c.p.baja = d.distributorId;
      },
      ruta: (c) => `/v2/platform/companies/${c.p.baja}`,
    }),

    ...acceso(tareas),
    tareas('empresa inexistente', 'super', 404, {
      ruta: (c) => `/v2/platform/companies/${c.inexistente}/scheduled-tasks`,
    }),

    guardarTareas('sin token', undefined, 401, {
      body: { dispatchRetrySeconds: 30 },
    }),
    guardarTareas('admin de empresa', 'adminB', 403, {
      body: { dispatchRetrySeconds: 30 },
    }),
    guardarTareas('administrador general', 'super', 200, {
      body: { dispatchRetrySeconds: 30, unpaidMercadoPagoExpirySeconds: 3600 },
      verificar: (b) => {
        expect(b).toMatchObject({
          dispatchRetrySeconds: 30,
          unpaidMercadoPagoExpirySeconds: 3600,
          reservationActivationSeconds: 300,
        });
      },
    }),
    guardarTareas(
      'administrador general en soporte: es de plataforma, no de la empresa en soporte',
      'soporteA',
      200,
      {
        body: {
          dispatchRetrySeconds: 30,
          unpaidMercadoPagoExpirySeconds: 3600,
        },
      },
    ),
    guardarTareas('la hora del aviso de flota es de la empresa', 'super', 400, {
      body: { fleetAlertHour: 9 },
    }),
    guardarTareas('intervalo que no es múltiplo del ciclo', 'super', 400, {
      body: { dispatchRetrySeconds: 20 },
    }),
    guardarTareas('reintento del despacho de más de 5 minutos', 'super', 400, {
      body: { dispatchRetrySeconds: 600 },
    }),
    guardarTareas('empresa inexistente', 'super', 404, {
      ruta: (c) => `/v2/platform/companies/${c.inexistente}/scheduled-tasks`,
      body: { dispatchRetrySeconds: 30 },
    }),

    ...acceso(procesos),
    ...acceso(lector),
    lector('mes mal escrito', 'super', 400, {
      ruta: '/v2/platform/document-reading-usage?month=2026-13',
    }),
    ...acceso(actividad),
    actividad('fecha que no es ISO 8601', 'super', 400, {
      ruta: '/v2/platform/activity?from=ayer',
    }),
    actividad('empresa que no es UUID', 'super', 400, {
      ruta: '/v2/platform/activity?distributorId=x',
    }),
    actividad('«desde» posterior a «hasta»', 'super', 400, {
      ruta: '/v2/platform/activity?from=2026-11-10T00:00:00Z&to=2026-11-01T00:00:00Z',
    }),

    // El monitoreo de corridas pasó a la plataforma: el admin de empresa ya no lo ve.
    ...acceso(corridas),
    corridas('filtrado por una empresa: sólo las de ella', 'super', 200, {
      ruta: (c) => `/v2/process-runs?distributorId=${c.distA.id}&status=failed`,
      verificar: (b, c) => {
        const items = (b as { items: Array<{ distributorId: string }> }).items;
        expect(items.length).toBeGreaterThan(0);
        expect(new Set(items.map((i) => i.distributorId))).toEqual(
          new Set([c.distA.id]),
        );
      },
    }),
    corridas('empresa que no es UUID', 'super', 400, {
      ruta: '/v2/process-runs?distributorId=x',
    }),
    ...acceso(resumenCorridas),
    resumenCorridas('de una empresa: con su falla', 'super', 200, {
      ruta: (c) => `/v2/process-runs/summary?distributorId=${c.distA.id}`,
      verificar: (b, c) => {
        const r = b as {
          items: Array<{ distributorId: string; health: string }>;
          alerts: number;
        };
        expect({
          empresas: new Set(r.items.map((i) => i.distributorId)),
          salud: r.items.map((i) => i.health),
        }).toEqual({
          empresas: new Set([c.distA.id]),
          salud: expect.arrayContaining(['failed']) as unknown,
        });
      },
    }),

    // v1 está congelada: conserva su contrato; v2 es la escritura de plataforma.
    tareasV1('admin de la empresa: lee', 'adminA', 200),
    tareasV1('administrador general sin sesión', 'super', 403, {
      code: CODIGO_SIN_SESION,
    }),
    tareasV1('administrador general en soporte: lee', 'soporteA', 200),
    guardarTareasV1(
      'admin: conserva las frecuencias históricas',
      'adminA',
      200,
      {
        body: { fleetAlertHour: 6, dispatchRetrySeconds: 30 },
        verificar: (b) => {
          expect(b).toMatchObject({
            fleetAlertHour: 6,
            dispatchRetrySeconds: 30,
          });
        },
      },
    ),
    guardarTareasV1(
      'administrador general en soporte: sólo lectura',
      'soporteA',
      403,
      {
        body: { fleetAlertHour: 7 },
        code: CODIGO_SOLO_LECTURA,
      },
    ),
  ];

  correrMatriz('matriz', ver, casos);

  // --------------------------------------------------------- comprobaciones
  describe('totales y aislamiento', () => {
    it('los totales del tablero cuadran con la suma por empresa, con el SQL de la base y con el reporte de ventas de cada empresa', async () => {
      const rango = `from=${PRIMERO}&to=${HOY}`;
      const tablero = await pedir(`/v2/platform/overview?${rango}`);
      const lista = await pedir(`/v2/platform/companies?${rango}&limit=100`);
      const filas = lista.items as Array<{
        id: string;
        metrics: Record<string, number>;
      }>;
      expect(lista.total).toBe(filas.length);
      const suma = (k: string) =>
        Math.round(filas.reduce((n, f) => n + f.metrics[k], 0) * 100) / 100;
      const totales = tablero.totals as Record<string, number>;
      for (const k of [
        'orders',
        'salesOrders',
        'revenue',
        'activeDrivers',
        'customers',
      ]) {
        expect({ k, total: totales[k] }).toEqual({ k, total: suma(k) });
      }
      // SQL directo: ventas (entregado y cobrado) por empresa en el mes argentino.
      const sql = await ds.query<
        Array<{ id: string; ventas: string; facturacion: string }>
      >(
        `SELECT o."distributor_id" AS id, COUNT(*) AS ventas,
                SUM(o."totalAmount")::text AS facturacion
           FROM "order" o
           JOIN "distributor" d ON d."distributor_id" = o."distributor_id" AND d."deletedAt" IS NULL
          WHERE o."status" = 'delivered' AND o."paymentStatus" = 'paid'
            AND o."deliveredAt" >= ($1::date::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')
            AND o."deliveredAt" < (($2::date + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')
          GROUP BY o."distributor_id"`,
        [PRIMERO, HOY],
      );
      const porSql = new Map(sql.map((f) => [f.id, f]));
      for (const f of filas) {
        const s = porSql.get(f.id);
        expect({
          id: f.id,
          ventas: f.metrics.salesOrders,
          facturacion: f.metrics.revenue,
        }).toEqual({
          id: f.id,
          ventas: Number(s?.ventas ?? 0),
          facturacion: Number(Number(s?.facturacion ?? 0).toFixed(2)),
        });
      }
      expect(totales.salesOrders).toBe(3);
      // El reporte de ventas de cada empresa (lo que ve su admin) da lo mismo.
      for (const [actor, d] of [
        ['adminA', ctx.distA.id],
        ['adminB', ctx.distB.id],
      ] as const) {
        const rep = await pedir(`/v2/reports/sales-summary?${rango}`, actor);
        const actual = rep.current as {
          totalSales: number;
          totalOrders: number;
        };
        const fila = filas.find((x) => x.id === d);
        expect({
          ventas: fila?.metrics.salesOrders,
          facturacion: fila?.metrics.revenue,
        }).toEqual({
          ventas: actual.totalOrders,
          facturacion: actual.totalSales,
        });
      }
    });

    it('ninguna respuesta real lleva un campo sensible ni datos de clientes o choferes', async () => {
      const rutas = [
        '/v2/platform/overview',
        '/v2/platform/companies?limit=100',
        `/v2/platform/companies/${ctx.distA.id}`,
        `/v2/platform/companies/${ctx.distB.id}`,
        `/v2/platform/companies/${ctx.distA.id}/scheduled-tasks`,
        '/v2/platform/processes',
        '/v2/platform/document-reading-usage',
        '/v2/platform/activity?limit=100',
        '/v2/process-runs?limit=100',
        '/v2/process-runs/summary',
      ];
      const prohibidos = [
        ctx.clienteA.email,
        ctx.clienteA.phone,
        ctx.clienteB.email,
        ctx.clienteB.phone,
        ctx.choferA.email,
        ctx.choferA.phone,
        ctx.choferB.email,
        ctx.choferB.phone,
      ];
      for (const ruta of rutas) {
        const cuerpo = await pedir(ruta);
        const todas = claves(cuerpo as Json);
        const sensibles = todas.filter((k) =>
          SENSIBLE.test(k.split('.').pop() ?? ''),
        );
        const correos = todas.filter(
          (k) => /mail/i.test(k) && !CORREO_PERMITIDO.test(k),
        );
        const texto = JSON.stringify(cuerpo);
        const filtrados = prohibidos.filter((p) => texto.includes(p));
        expect({ ruta, sensibles, correos, filtrados }).toEqual({
          ruta,
          sensibles: [],
          correos: [],
          filtrados: [],
        });
      }
    });

    it('la ficha trae los admins de la empresa (nombre y correo) y no los de otra', async () => {
      const f = await pedir(`/v2/platform/companies/${ctx.distA.id}`);
      const correos = (f.admins as Array<{ email: string }>).map(
        (a) => a.email,
      );
      expect(correos).toEqual(
        expect.arrayContaining([ctx.adminA.email, ctx.adminA2.email]),
      );
      expect(correos).not.toContain(ctx.adminB.email);
      expect(f.company).toMatchObject({
        id: ctx.distA.id,
        ownedByPlatform: false,
      });
      expect(f.processes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            process: ProcessName.CYLINDER_RECOVERY,
            health: 'failed',
            failuresLast24h: 1,
          }),
        ]),
      );
      // La sesión de soporte de la matriz sobre A aparece en su historial.
      expect(
        (f.supportSessions as Array<{ status: string }>).map((s) => s.status),
      ).toContain('active');
    });

    it('la lista marca la empresa con sesión de soporte activa y sus alertas de procesos', async () => {
      const lista = await pedir('/v2/platform/companies?limit=100');
      const a = (
        lista.items as Array<{
          id: string;
          supportSessionActive: boolean;
          processAlerts: number;
        }>
      ).find((i) => i.id === ctx.distA.id);
      expect(a?.supportSessionActive).toBe(true);
      expect(a?.processAlerts).toBeGreaterThanOrEqual(1);
    });

    it('sin N+1: la cantidad de consultas no crece con la cantidad de empresas', async () => {
      const contar = async (ruta: string): Promise<number> => {
        const espia = jest.spyOn(ds, 'query');
        try {
          await pedir(ruta);
          return espia.mock.calls.filter(([sql]) =>
            String(sql).includes('/* plataforma:'),
          ).length;
        } finally {
          espia.mockRestore();
        }
      };
      const rutas = [
        '/v2/platform/overview',
        '/v2/platform/companies?limit=100',
        '/v2/platform/document-reading-usage',
      ];
      // Cada espía cubre una sola petición: instalarlos en paralelo mezcla las
      // consultas de las otras rutas y vuelve frágil el conteo.
      const antes = [];
      for (const ruta of rutas) antes.push(await contar(ruta));
      for (let i = 0; i < 3; i++) {
        const d = (await ds.getRepository(Distributor).save({
          name: `Extra ${i} ${randomUUID().slice(0, 6)}`,
          slug: `extra-${i}-${randomUUID().slice(0, 6)}`,
        } as Partial<Distributor>)) as Distributor;
        extras.push(d.distributorId);
      }
      const despues = [];
      for (const ruta of rutas) despues.push(await contar(ruta));
      expect(despues).toEqual(antes);
      expect(antes.every((n) => n > 0)).toBe(true);
      // Además del conteo, el SQL de métricas debe seguir haciendo dos seeks
      // LATERAL (uno por tabla) compatibles con los índices nuevos, no un
      // agregado correlacionado que escanee toda la historia por empresa.
      const espia = jest.spyOn(ds, 'query');
      try {
        await pedir('/v2/platform/companies?limit=100');
        const metricas = espia.mock.calls
          .map(([sql]) => String(sql))
          .find((sql) => sql.includes('/* plataforma:metricas */'));
        expect(metricas).toContain('LEFT JOIN LATERAL');
        expect(metricas).toContain('SELECT MAX(actividad.at)');
        expect(metricas).toContain('ORDER BY o."createdAt" DESC');
        expect(metricas).toContain('ORDER BY l."created_at" DESC');
      } finally {
        espia.mockRestore();
      }
      const lista = await pedir('/v2/platform/companies?limit=100');
      expect((lista.items as unknown[]).length).toBeGreaterThanOrEqual(5);
    });

    it('la plataforma fija las frecuencias y la empresa conserva su hora de aviso (y al revés)', async () => {
      const r1 = await llamar(
        ctx,
        'put',
        '/module-config/scheduled_tasks',
        'adminB',
        { fleetAlertHour: 21 },
      );
      expect(r1.status).toBe(200);
      const r2 = await llamar(
        ctx,
        'put',
        `/v2/platform/companies/${ctx.distB.id}/scheduled-tasks`,
        'super',
        { reservationActivationSeconds: 900 },
      );
      expect(r2.body).toMatchObject({
        reservationActivationSeconds: 900,
        fleetAlertHour: 21,
      });
      const r3 = await llamar(
        ctx,
        'put',
        '/module-config/scheduled_tasks',
        'adminB',
        { fleetAlertHour: 5 },
      );
      expect(r3.body).toMatchObject({
        reservationActivationSeconds: 900,
        fleetAlertHour: 5,
      });
    });

    it('un proceso con falla avisa a la bandeja de la plataforma, no a la de la empresa', async () => {
      await env.app.get(ProcessRunWatchCron).vigilar();
      // El aviso se entrega por evento asíncrono.
      const empresa = await ds.getRepository(Distributor).findOneByOrFail({
        distributorId: ctx.distA.id,
      });
      const titulo = `Proceso automático: Recupero de envases de ${empresa.name}`;
      let avisosDelProceso: Array<{
        kind: string;
        title: string;
        link?: { entity: string; id: string };
      }> = [];
      for (let i = 0; i < 20 && avisosDelProceso.length === 0; i++) {
        const b = await pedir('/v2/admin-notifications?limit=100');
        avisosDelProceso = (
          b.items as Array<{
            kind: string;
            title: string;
            link?: { entity: string; id: string };
          }>
        ).filter(
          (n) =>
            n.kind === 'process_run_alert' &&
            n.link?.entity === 'process-run' &&
            n.link.id === String(ProcessName.CYLINDER_RECOVERY) &&
            n.title === titulo,
        );
        if (avisosDelProceso.length === 0) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(avisosDelProceso).toHaveLength(1);
      const deA = await pedir('/v2/admin-notifications?limit=100', 'adminA');
      expect(
        (deA.items as Array<{ kind: string }>).filter(
          (n) => n.kind === 'process_run_alert',
        ),
      ).toEqual([]);
      const enBase = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM "admin_notification"
          WHERE "kind" = 'process_run_alert' AND "distributor_id" IS NOT NULL`,
      );
      expect(Number(enBase[0].n)).toBe(0);
    });

    it('la actividad registra lo que escribió el administrador general', async () => {
      const todo = await pedir('/v2/platform/activity?limit=100');
      expect(
        (todo.items as Array<{ actorRole: string; resource: string }>).some(
          (i) => i.actorRole === 'super_admin' && i.resource === 'platform',
        ),
      ).toBe(true);
    });
  });
});
