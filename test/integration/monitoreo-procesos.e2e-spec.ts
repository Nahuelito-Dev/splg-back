/**
 * F31 contra la API con Postgres y Redis reales: el registrador, la vigilancia,
 * los endpoints de monitoreo y el aislamiento entre distribuidoras.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  cuitDePrueba,
  telefonoDePrueba,
  truncateAllTables,
} from './setup/test-env';
import { Admin } from '../../src/admin/entities/admin.entity';
import { AdminNotification } from '../../src/admin-notifications/entities/admin-notification.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import {
  ProcessName,
  ProcessRunStatus,
  RunTrigger,
} from '../../src/process-run/domain/process-catalog';
import { ProcessRun } from '../../src/process-run/entities/process-run.entity';
import { marcarSaltada } from '../../src/process-run/process-run.context';
import { ProcessRunRecorder } from '../../src/process-run/process-run.recorder';
import { ProcessRunWatchCron } from '../../src/process-run/process-run-watch.cron';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';

type Headers = Record<string, string>;

describe('Monitoreo de procesos automáticos (F31, e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let seq = 0;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const http = () => request(env.app.getHttpServer());

  async function usuario(
    tipo: 'customer' | 'admin' | 'super_admin' | 'delivery',
  ) {
    seq += 1;
    const roles = ds.getRepository(Role);
    const rol =
      (await roles.findOne({ where: { type: tipo } })) ??
      (await roles.save({ type: tipo } as Partial<Role>));
    const email = `${tipo}.${seq}.${randomUUID().slice(0, 6)}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: `${tipo} ${seq}`,
      phoneNumber: telefonoDePrueba(),
      roleId: rol.roleId,
    } as Partial<User>);
    return { user, email };
  }

  const h = (email: string, fuente: string, extra: Headers = {}): Headers => ({
    Authorization: `Bearer ${email}`,
    'X-Client-Source': fuente,
    ...extra,
  });

  async function distribuidora(): Promise<Distributor> {
    seq += 1;
    return ds.getRepository(Distributor).save({
      name: `Dist ${seq}`,
      slug: `dist-${seq}-${randomUUID().slice(0, 4)}`,
      legalName: 'Test SRL',
      taxId: cuitDePrueba(),
      email: `d${seq}${Date.now()}@test.local`,
      phone: '+540000000000',
    } as Partial<Distributor>);
  }

  async function adminDe(d: Distributor) {
    const a = await usuario('admin');
    await ds.getRepository(Admin).save({
      userId: a.user.userId,
      distributorId: d.distributorId,
    } as Partial<Admin>);
    return { headers: h(a.email, 'panel-app'), email: a.email };
  }

  async function escenario() {
    const dA = await distribuidora();
    const dB = await distribuidora();
    const adminA = await adminDe(dA);
    const adminB = await adminDe(dB);
    const sup = await usuario('super_admin');
    const chofer = await usuario('delivery');
    await ds.getRepository(Delivery).save({
      userId: chofer.user.userId,
      distributorId: dA.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
    const cliente = await usuario('customer');
    await ds.getRepository(Customer).save({
      userId: cliente.user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    return {
      dA,
      dB,
      adminA,
      adminB,
      sup: h(sup.email, 'panel-app'),
      chofer: h(chofer.email, 'driver-app'),
      cliente: h(cliente.email, 'customer-app'),
    };
  }

  const runs = () => ds.getRepository(ProcessRun);

  async function corrida(
    p: Partial<ProcessRun> & { process: ProcessName },
    haceMin = 1,
  ): Promise<ProcessRun> {
    const startedAt = new Date(Date.now() - haceMin * 60_000);
    const status = p.status ?? ProcessRunStatus.OK;
    return runs().save({
      distributorId: null,
      startedAt,
      finishedAt:
        status === ProcessRunStatus.RUNNING
          ? null
          : new Date(startedAt.getTime() + 1500),
      status,
      counters: {},
      error: null,
      instance: 'test:1',
      ...p,
    } as ProcessRun);
  }

  describe('la tabla', () => {
    it('rechaza un fin anterior al inicio, un running con fin y un ok sin fin', async () => {
      const ahora = new Date();
      const insertar = (fin: Date | null, status: string) =>
        ds.query(
          `INSERT INTO process_run (process, started_at, finished_at, status, instance) VALUES ('fleet_alerts', $1, $2, $3, 'x')`,
          [ahora, fin, status],
        );
      await expect(
        insertar(new Date(ahora.getTime() - 1), 'ok'),
      ).rejects.toThrow(/CHK_process_run_fin/);
      await expect(insertar(ahora, 'running')).rejects.toThrow(
        /CHK_process_run_estado_fin/,
      );
      await expect(insertar(null, 'ok')).rejects.toThrow(
        /CHK_process_run_estado_fin/,
      );
    });

    it('rechaza contadores que no son un objeto y un proceso fuera del enum', async () => {
      await expect(
        ds.query(
          `INSERT INTO process_run (process, status, finished_at, counters, instance) VALUES ('fleet_alerts', 'ok', now(), '[1]', 'x')`,
        ),
      ).rejects.toThrow(/CHK_process_run_contadores/);
      await expect(
        ds.query(
          `INSERT INTO process_run (process, instance) VALUES ('inventado', 'x')`,
        ),
      ).rejects.toThrow(/process_run_process_enum/);
    });
  });

  describe('el registrador', () => {
    it('guarda una corrida ok con contadores y una fallida con el error, y vuelve a lanzar', async () => {
      const registrador = env.app.get(ProcessRunRecorder);
      await registrador.ejecutar(ProcessName.IMPORT_CLEANUP, null, () =>
        Promise.resolve({ deleted: 3 }),
      );
      await expect(
        registrador.ejecutar(ProcessName.STOCK_LOW_ALERT, null, () =>
          Promise.reject(new Error('boom token=abc')),
        ),
      ).rejects.toThrow('boom');
      const ok = await runs().findOneByOrFail({
        process: ProcessName.IMPORT_CLEANUP,
      });
      expect(ok).toMatchObject({ status: 'ok', counters: { deleted: 3 } });
      expect(ok.finishedAt).not.toBeNull();
      const mal = await runs().findOneByOrFail({
        process: ProcessName.STOCK_LOW_ALERT,
      });
      expect(mal.status).toBe('failed');
      expect(mal.error).toContain('boom');
      expect(mal.error).not.toContain('abc');
    });
  });

  describe('GET /v2/process-runs/summary', () => {
    it('muestra la última corrida de cada proceso con su salud', async () => {
      const e = await escenario();
      await corrida(
        {
          process: ProcessName.FLEET_ALERTS,
          status: ProcessRunStatus.FAILED,
          error: 'x',
        },
        10,
      );
      await corrida(
        { process: ProcessName.FLEET_ALERTS, status: ProcessRunStatus.OK },
        120,
      );
      await corrida({ process: ProcessName.STOCK_LOW_ALERT }, 5);
      await corrida(
        {
          process: ProcessName.INSURANCE_ALERTS,
          status: ProcessRunStatus.RUNNING,
        },
        90,
      );
      await corrida({ process: ProcessName.COVERAGE_ZONE_EXPIRY }, 60 * 24);

      const res = await http()
        .get('/v2/process-runs/summary')
        .set(e.adminA.headers)
        .expect(200);
      const por = Object.fromEntries(
        (
          res.body as { items: Array<{ process: string; health: string }> }
        ).items.map((i) => [i.process, i.health]),
      );
      expect(por.fleet_alerts).toBe('failed');
      expect(por.stock_low_alert).toBe('ok');
      expect(por.insurance_alerts).toBe('stuck');
      expect(por.coverage_zone_expiry).toBe('late');
      expect(por.import_cleanup).toBe('never');
      expect((res.body as { alerts: number }).alerts).toBe(3);
    });

    it('un admin no ve las corridas de otra distribuidora; el super las ve y las filtra con X-Distributor', async () => {
      const e = await escenario();
      await corrida({
        process: ProcessName.CYLINDER_RECOVERY,
        distributorId: e.dA.distributorId,
        status: ProcessRunStatus.FAILED,
      });
      await corrida({
        process: ProcessName.CYLINDER_RECOVERY,
        distributorId: e.dB.distributorId,
      });

      const a = await http()
        .get('/v2/process-runs/summary')
        .set(e.adminA.headers)
        .expect(200);
      const b = await http()
        .get('/v2/process-runs/summary')
        .set(e.adminB.headers)
        .expect(200);
      type Item = {
        process: string;
        health: string;
        distributorId: string | null;
      };
      const de = (r: { body: unknown }) =>
        (r.body as { items: Item[] }).items.filter(
          (i) => i.process === 'cylinder_recovery',
        );
      expect(de(a).map((i) => [i.distributorId, i.health])).toEqual([
        [e.dA.distributorId, 'failed'],
      ]);
      expect(de(b).map((i) => [i.distributorId, i.health])).toEqual([
        [e.dB.distributorId, 'ok'],
      ]);

      const todas = await http()
        .get('/v2/process-runs/summary')
        .set(e.sup)
        .expect(200);
      expect(de(todas)).toHaveLength(2);
      const filtrada = await http()
        .get('/v2/process-runs/summary')
        .set({ ...e.sup, 'X-Distributor': e.dB.distributorId })
        .expect(200);
      expect(de(filtrada).map((i) => i.distributorId)).toEqual([
        e.dB.distributorId,
      ]);
    });
  });

  describe('detalle de las corridas globales', () => {
    it('el admin de una empresa ve sólo la salud de un proceso global; el super ve contadores y error', async () => {
      const e = await escenario();
      await corrida({
        process: ProcessName.MP_PENDING_RECONCILIATION,
        status: ProcessRunStatus.FAILED,
        counters: { applied: 42 },
        error: 'falló en 7 distribuidoras',
      });
      await corrida({
        process: ProcessName.CYLINDER_RECOVERY,
        distributorId: e.dA.distributorId,
        counters: { cases: 3 },
      });
      type Run = {
        counters: Record<string, number>;
        error: string | null;
        distributorId: string | null;
      };
      const resumen = async (headers: Headers) =>
        Object.fromEntries(
          (
            (
              await http()
                .get('/v2/process-runs/summary')
                .set(headers)
                .expect(200)
            ).body as {
              items: Array<{ process: string; lastRun: Run | null }>;
            }
          ).items.map((i) => [i.process, i.lastRun]),
        );
      const admin = await resumen(e.adminA.headers);
      expect(admin.mp_pending_reconciliation).toMatchObject({
        counters: {},
        error: null,
      });
      expect(admin.cylinder_recovery).toMatchObject({ counters: { cases: 3 } });
      const super_ = await resumen(e.sup);
      expect(super_.mp_pending_reconciliation).toMatchObject({
        counters: { applied: 42 },
        error: 'falló en 7 distribuidoras',
      });

      const lista = async (headers: Headers) =>
        (
          (await http().get('/v2/process-runs').set(headers).expect(200))
            .body as { items: Array<Run & { process: string }> }
        ).items;
      const delAdmin = (await lista(e.adminA.headers)).find(
        (r) => r.process === 'mp_pending_reconciliation',
      );
      expect(delAdmin).toMatchObject({ counters: {}, error: null });
      const delSuper = (await lista(e.sup)).find(
        (r) => r.process === 'mp_pending_reconciliation',
      );
      expect(delSuper?.counters).toEqual({ applied: 42 });
    });
  });

  describe('GET /v2/process-runs', () => {
    it('pagina, filtra por proceso, estado y fechas, y no mezcla distribuidoras', async () => {
      const e = await escenario();
      await corrida({ process: ProcessName.FLEET_ALERTS }, 10);
      await corrida(
        {
          process: ProcessName.FLEET_ALERTS,
          status: ProcessRunStatus.FAILED,
          error: 'x',
        },
        20,
      );
      await corrida({ process: ProcessName.STOCK_LOW_ALERT }, 30);
      await corrida(
        {
          process: ProcessName.FLEET_ALERTS,
          distributorId: e.dB.distributorId,
        },
        5,
      );

      type Lista = {
        items: Array<{ process: string; status: string }>;
        total: number;
      };
      const todas = (
        await http().get('/v2/process-runs').set(e.adminA.headers).expect(200)
      ).body as Lista;
      expect(todas.total).toBe(3);

      const pag = (
        await http()
          .get('/v2/process-runs?limit=1&offset=1')
          .set(e.adminA.headers)
          .expect(200)
      ).body as Lista;
      expect(pag.items).toHaveLength(1);
      expect(pag.total).toBe(3);

      const falladas = (
        await http()
          .get('/v2/process-runs?process=fleet_alerts&status=failed')
          .set(e.adminA.headers)
          .expect(200)
      ).body as Lista;
      expect(falladas.items).toHaveLength(1);

      const desde = new Date(Date.now() - 15 * 60_000).toISOString();
      const recientes = (
        await http()
          .get(`/v2/process-runs?from=${encodeURIComponent(desde)}`)
          .set(e.adminA.headers)
          .expect(200)
      ).body as Lista;
      expect(recientes.total).toBe(1);

      const delSuper = (
        await http().get('/v2/process-runs').set(e.sup).expect(200)
      ).body as Lista;
      expect(delSuper.total).toBe(4);
    });

    it.each([
      'process=inventado',
      'status=roto',
      'from=ayer',
      'to=2026-13-45',
      'from=2026-11-03&to=2026-11-01',
      'limit=0',
      'limit=101',
      'offset=-1',
    ])('el filtro %s es 400', async (filtro) => {
      const e = await escenario();
      await http()
        .get(`/v2/process-runs?${filtro}`)
        .set(e.adminA.headers)
        .expect(400);
    });
  });

  describe('permisos', () => {
    it.each(['/v2/process-runs', '/v2/process-runs/summary'])(
      '%s: sin token 401; cliente y chofer 403; admin con el origen de otra app 401',
      async (ruta) => {
        const e = await escenario();
        await http().get(ruta).expect(401);
        await http()
          .get(ruta)
          .set('Authorization', 'Bearer no-existe')
          .set('X-Client-Source', 'panel-app')
          .expect(401);
        await http().get(ruta).set(e.cliente).expect(403);
        await http().get(ruta).set(e.chofer).expect(403);
        await http()
          .get(ruta)
          .set({ ...e.adminA.headers, 'X-Client-Source': 'customer-app' })
          .expect(401);
        await http()
          .get(ruta)
          .set({ ...e.adminA.headers, 'X-Client-Source': 'driver-app' })
          .expect(401);
      },
    );
  });

  describe('la vigilancia', () => {
    it('avisa una vez por día: a todas las empresas con texto genérico si el proceso es global, y a la dueña con su detalle si es propio', async () => {
      const e = await escenario();
      await corrida(
        {
          process: ProcessName.FLEET_ALERTS,
          status: ProcessRunStatus.FAILED,
          error: 'caído en 7 distribuidoras',
        },
        10,
      );
      await corrida(
        {
          process: ProcessName.CYLINDER_RECOVERY,
          distributorId: e.dA.distributorId,
          status: ProcessRunStatus.FAILED,
          error: 'propio',
        },
        10,
      );
      await corrida(
        {
          process: ProcessName.STOCK_LOW_ALERT,
          status: ProcessRunStatus.RUNNING,
        },
        25 * 60,
      );
      const cron = env.app.get(ProcessRunWatchCron);

      const primera = await cron.vigilar();
      const segunda = await cron.vigilar();
      expect(primera.closed).toBe(1);
      expect(segunda.closed).toBe(0);
      // El evento se atiende de forma asíncrona.
      await new Promise((r) => setTimeout(r, 1200));
      const avisos = await ds
        .getRepository(AdminNotification)
        .find({ where: { kind: 'process_run_alert' } });
      const fallas = avisos
        .filter((a) => a.dedupeKey.includes(':failed:'))
        .map((a) => [a.distributorId, a.dedupeKey.split(':')[1]])
        .sort();
      expect(fallas).toEqual(
        [
          [e.dA.distributorId, 'cylinder_recovery'],
          [e.dA.distributorId, 'fleet_alerts'],
          [e.dB.distributorId, 'fleet_alerts'],
          [e.dA.distributorId, 'stock_low_alert'],
          [e.dB.distributorId, 'stock_low_alert'],
        ].sort(),
      );
      const global = avisos.find((a) =>
        a.dedupeKey.startsWith('process-run:fleet_alerts:failed'),
      );
      expect(global?.body).toBe(
        'El proceso «Aviso de vencimientos de flota» terminó con error. El equipo técnico ya fue avisado.',
      );
      expect(
        JSON.stringify(
          avisos.filter((a) => a.dedupeKey.includes('fleet_alerts')),
        ),
      ).not.toContain('7 distribuidoras');
      const propio = avisos.find((a) =>
        a.dedupeKey.startsWith('process-run:cylinder_recovery'),
      );
      expect(propio?.body).toContain('propio');
      const abandonada = await runs().findOneByOrFail({
        process: ProcessName.STOCK_LOW_ALERT,
      });
      expect(abandonada.status).toBe('failed');
    });

    it('I1 falla y I2 se saltea después: el estado es failed y la empresa recibe el aviso', async () => {
      const e = await escenario();
      const registrador = env.app.get(ProcessRunRecorder);
      await expect(
        registrador.ejecutar(
          ProcessName.CYLINDER_RECOVERY,
          e.dA.distributorId,
          () => Promise.reject(new Error('instancia 1 rota')),
        ),
      ).rejects.toThrow();
      await registrador.ejecutar(
        ProcessName.CYLINDER_RECOVERY,
        e.dA.distributorId,
        () => {
          marcarSaltada();
          return Promise.resolve(undefined);
        },
      );
      const filas = await runs().find({ order: { startedAt: 'ASC' } });
      expect(filas.map((f) => f.status)).toEqual(['failed', 'skipped']);

      const res = await http()
        .get('/v2/process-runs/summary')
        .set(e.adminA.headers)
        .expect(200);
      const item = (
        res.body as { items: Array<{ process: string; health: string }> }
      ).items.find((i) => i.process === 'cylinder_recovery');
      expect(item?.health).toBe('failed');

      await env.app.get(ProcessRunWatchCron).vigilar();
      await new Promise((r) => setTimeout(r, 800));
      const avisos = await ds
        .getRepository(AdminNotification)
        .find({ where: { kind: 'process_run_alert' } });
      expect(avisos).toHaveLength(1);
      expect(avisos[0].distributorId).toBe(e.dA.distributorId);
    });

    it('una corrida manual sí cuenta para la salud', async () => {
      const e = await escenario();
      await corrida({ process: ProcessName.PAYMENT_INBOX_PROCESS }, 2);
      await corrida(
        {
          process: ProcessName.PAYMENT_INBOX_PROCESS,
          status: ProcessRunStatus.FAILED,
          error: 'x',
          trigger: RunTrigger.MANUAL,
        },
        1,
      );
      const res = await http()
        .get('/v2/process-runs/summary')
        .set(e.adminA.headers)
        .expect(200);
      const item = (
        res.body as { items: Array<{ process: string; health: string }> }
      ).items.find((i) => i.process === 'payment_inbox_process');
      expect(item?.health).toBe('failed');
    });

    it('la corrida adelantada por un webhook no cuenta para la salud del cron', async () => {
      const e = await escenario();
      await corrida({ process: ProcessName.PAYMENT_INBOX_PROCESS }, 1);
      await corrida(
        {
          process: ProcessName.PAYMENT_INBOX_PROCESS,
          status: ProcessRunStatus.FAILED,
          error: 'x',
          trigger: RunTrigger.WEBHOOK,
        },
        0.5,
      );
      const res = await http()
        .get('/v2/process-runs/summary')
        .set(e.adminA.headers)
        .expect(200);
      const item = (
        res.body as { items: Array<{ process: string; health: string }> }
      ).items.find((i) => i.process === 'payment_inbox_process');
      expect(item?.health).toBe('ok');
    });

    it('la purga borra lo viejo pero deja la última corrida de cada proceso', async () => {
      await escenario();
      await corrida({ process: ProcessName.FLEET_ALERTS }, 60 * 24 * 40);
      await corrida({ process: ProcessName.FLEET_ALERTS }, 60 * 24 * 35);
      await corrida({ process: ProcessName.STOCK_LOW_ALERT }, 60 * 24 * 50);
      await corrida({ process: ProcessName.FINE_DUE_ALERTS }, 60);
      const r = await env.app.get(ProcessRunWatchCron).purgar();
      expect(r.purged).toBe(1);
      // Sólo los procesos que sembró el test: los crons de la app siguen
      // corriendo durante el e2e y pueden anotar corridas propias.
      const sembrados = [
        'fine_due_alerts',
        'fleet_alerts',
        'process_run_purge',
        'stock_low_alert',
      ];
      const quedan = (await runs().find())
        .map((x) => x.process as string)
        .filter((p) => sembrados.includes(p))
        .sort();
      // De fleet_alerts queda sólo la última (la de hace 35 días).
      expect(quedan).toEqual([...sembrados].sort());
    });
  });
});
