/**
 * Matriz HTTP de los módulos por distribuidora (DISENO-PLATAFORMA-ORIXTECH
 * §13 P1) y sus casos de aceptación, contra Postgres y Redis efímeros:
 *
 *  - la plataforma ve y cambia los módulos de una empresa; la empresa ve los
 *    suyos; las apps leen `features` (con sesión y por slug);
 *  - con `document_reading` deshabilitado para A: su pantalla responde 403
 *    `MODULE_DISABLED`, el proceso no lee su cola (y sí la de B), `features` no
 *    lo lista y volver a habilitarlo retoma la cola;
 *  - con `mercadopago` deshabilitado para A: los medios de pago de A no traen
 *    Mercado Pago y los de B sí;
 *  - otra distribuidora: B no cambia; editar el catálogo de un plan no cambia
 *    la foto de ninguna suscripción; el cambio queda auditado con el super
 *    admin como actor y la distribuidora afectada.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Distributor } from '../../../src/distributor/entities/distributor.entity';
import { DocumentReadingCron } from '../../../src/document-reading/document-reading.cron';
import { DocumentReadingRunnerService } from '../../../src/document-reading/document-reading-runner.service';
import { AccesoDeLaEmpresa } from '../../../src/platform/access/acceso-de-la-empresa.service';
import { MODULOS } from '../../../src/platform/modules/catalogo-de-modulos';
import { TestEnv, createTestApp } from '../setup/test-env';
import {
  Caso,
  Escenario,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
  sembrarEscenario,
} from './matriz';
import { CODIGO_SIN_SESION } from './soporte';

type Ctx = Escenario & { p: Record<string, string> };

const MOTIVO = 'Prueba de la matriz de módulos';

// Ayudas a nivel de módulo: las verificaciones de los casos no definen
// funciones adentro (jest/no-standalone-expect pierde el rastro con ellas).
const clavesYPlan = (b: unknown): string[] =>
  (b as Array<{ key: string; inPlan: boolean }>).map(
    (m) => `${m.key}:${String(m.inPlan)}`,
  );

describe('Matriz HTTP: módulos por distribuidora (P1, e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  let ds: DataSource;
  const ver = () => ctx;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    const c = (await sembrarEscenario(env.app)) as Ctx;
    c.p = {};
    c.reiniciarCupos = () => reiniciarCuposDelThrottler(env);
    ctx = c;
    ds = env.app.get(DataSource);
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  /** La plataforma pone (o saca, con `null`) una excepción de módulo. */
  const poner = async (
    distributorId: string,
    key: string,
    enabled: boolean | null,
  ) => {
    const res = await llamar(
      ctx,
      'put',
      `/v2/platform/companies/${distributorId}/modules/${key}`,
      'super',
      { enabled, reason: MOTIVO },
    );
    expect({ key, estado: res.status }).toEqual({ key, estado: 200 });
  };

  /** La llave de la empresa (el `enabled` de su proceso). */
  const encender = async (actor: string, proceso: string) => {
    const res = await llamar(ctx, 'put', `/module-config/${proceso}`, actor, {
      enabled: 1,
    });
    expect({ proceso, estado: res.status }).toEqual({ proceso, estado: 200 });
  };

  // ---------------------------------------------------------------- matriz
  const listar = endpoint<Ctx>(
    'get',
    '/v2/platform/companies/{id}/modules',
    (c) => `/v2/platform/companies/${c.distA.id}/modules`,
  );
  const cambiar = endpoint<Ctx>(
    'put',
    '/v2/platform/companies/{id}/modules/{key}',
    (c) => `/v2/platform/companies/${c.distB.id}/modules/whatsapp`,
  );
  const propios = endpoint<Ctx>(
    'get',
    '/v2/company/modules',
    '/v2/company/modules',
  );
  const features = endpoint<Ctx>('get', '/v2/me/features', '/v2/me/features');
  const publicas = endpoint<Ctx>(
    'get',
    '/v2/public/distributors/{slug}/features',
    (c) => `/v2/public/distributors/${c.distA.slug}/features`,
  );

  // Un cambio que no cambia nada (whatsapp ya viene en el plan completo de B):
  // los casos 200 no dejan nada distinto para los demás.
  const cuerpo = { enabled: true, reason: MOTIVO };

  const casos: Array<Caso<Ctx>> = [
    listar('sin token', undefined, 401),
    listar('admin de la empresa', 'adminA', 403),
    listar('chofer', 'chofer', 403),
    listar('cliente', 'clienteA', 403),
    listar('administrador general', 'super', 200, {
      verificar: (b) => {
        expect(clavesYPlan(b)).toEqual(MODULOS.map((k) => `${k}:true`));
      },
    }),
    listar(
      'administrador general en una sesión de soporte (es de plataforma)',
      'soporteA',
      200,
    ),
    listar('id mal formado', 'super', 400, {
      ruta: '/v2/platform/companies/no-es-uuid/modules',
      code: 'INVALID_ID',
    }),
    listar('empresa inexistente', 'super', 404, {
      ruta: (c) => `/v2/platform/companies/${c.inexistente}/modules`,
      code: 'COMPANY_NOT_FOUND',
    }),
    listar('empresa dada de baja', 'super', 404, {
      antes: async (c) => {
        const d = (await ds.getRepository(Distributor).save({
          name: `Baja ${randomUUID().slice(0, 6)}`,
          slug: `baja-${randomUUID().slice(0, 6)}`,
        } as Partial<Distributor>)) as Distributor;
        await ds.getRepository(Distributor).softDelete(d.distributorId);
        c.p.baja = d.distributorId;
        c.p.bajaSlug = d.slug;
      },
      ruta: (c) => `/v2/platform/companies/${c.p.baja}/modules`,
    }),

    cambiar('sin token', undefined, 401, { body: cuerpo }),
    cambiar('admin de la empresa', 'adminB', 403, { body: cuerpo }),
    cambiar('chofer', 'chofer', 403, { body: cuerpo }),
    cambiar('cliente', 'clienteB', 403, { body: cuerpo }),
    cambiar('administrador general', 'super', 200, {
      body: cuerpo,
      verificar: (b) => {
        expect(b).toMatchObject({
          key: 'whatsapp',
          label: 'Venta por WhatsApp',
          inPlan: true,
          override: { enabled: true, reason: MOTIVO, expiresAt: null },
          enabled: true,
          impact: { pending: 0 },
        });
      },
    }),
    cambiar('volver a lo del plan (null)', 'super', 200, {
      body: { enabled: null, reason: MOTIVO },
      verificar: (b) => {
        expect(b).toMatchObject({ override: null, enabled: true });
      },
    }),
    cambiar('con vencimiento futuro', 'super', 200, {
      body: {
        enabled: true,
        reason: MOTIVO,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }),
    cambiar('módulo que no existe', 'super', 400, {
      ruta: (c) =>
        `/v2/platform/companies/${c.distB.id}/modules/teletransporte`,
      body: cuerpo,
      code: 'MODULE_UNKNOWN',
    }),
    cambiar('motivo corto', 'super', 400, {
      body: { enabled: true, reason: 'corto' },
    }),
    cambiar('sin enabled', 'super', 400, { body: { reason: MOTIVO } }),
    cambiar('enabled que no es booleano', 'super', 400, {
      body: { enabled: 'si', reason: MOTIVO },
    }),
    cambiar('vencimiento pasado', 'super', 400, {
      body: { ...cuerpo, expiresAt: '2020-01-01T00:00:00Z' },
    }),
    cambiar('vencimiento con enabled null', 'super', 400, {
      body: {
        enabled: null,
        reason: MOTIVO,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }),
    cambiar('vencimiento que no es fecha', 'super', 400, {
      body: { ...cuerpo, expiresAt: 'mañana' },
    }),
    cambiar('id mal formado', 'super', 400, {
      ruta: '/v2/platform/companies/x/modules/whatsapp',
      body: cuerpo,
    }),
    cambiar('empresa inexistente', 'super', 404, {
      ruta: (c) => `/v2/platform/companies/${c.inexistente}/modules/whatsapp`,
      body: cuerpo,
    }),

    propios('sin token', undefined, 401),
    propios('admin de la empresa', 'adminA', 200, {
      verificar: (b) => {
        const lista = b as Array<Record<string, unknown>>;
        expect(lista).toHaveLength(MODULOS.length);
        // La empresa no ve motivos, excepciones ni impacto.
        expect(Object.keys(lista[0]).sort()).toEqual([
          'effective',
          'enabled',
          'key',
          'label',
        ]);
      },
    }),
    propios('admin de otra empresa (ve la suya)', 'adminB', 200),
    propios('chofer', 'chofer', 403),
    propios('cliente', 'clienteA', 403),
    propios('administrador general sin sesión de soporte', 'super', 403, {
      code: CODIGO_SIN_SESION,
    }),
    propios('administrador general en soporte (lectura)', 'soporteA', 200),

    features('sin token', undefined, 401),
    features('admin', 'adminA', 200, {
      verificar: (b) => {
        expect(b).toMatchObject({ access: 'full' });
      },
    }),
    features('chofer', 'chofer', 200),
    features('cliente con X-Distributor', 'clienteA', 200),
    features('cliente sin X-Distributor', 'clienteA', 400, {
      cabeceras: { 'X-Distributor': null },
      code: 'MISSING_DISTRIBUTOR',
    }),
    features('administrador general sin sesión de soporte', 'super', 403, {
      code: CODIGO_SIN_SESION,
    }),

    publicas('sin sesión', undefined, 200, {
      verificar: (b) => {
        expect(b).toMatchObject({ acceptingOrders: true, message: null });
      },
    }),
    publicas('distribuidora inexistente', undefined, 404, {
      ruta: '/v2/public/distributors/no-existe-nunca/features',
    }),
  ];

  correrMatriz('matriz', ver, casos);

  // ------------------------------------------------------ aceptación de P1
  describe('aceptación', () => {
    afterEach(async () => {
      // Todo vuelve a lo del plan: ningún caso deja nada para el siguiente.
      for (const d of [ctx.distA.id, ctx.distB.id]) {
        for (const key of ['document_reading', 'mercadopago']) {
          await poner(d, key, null);
        }
      }
    });

    it('lector deshabilitado para A: 403 MODULE_DISABLED en A, B sigue; features no lo lista; volver a habilitarlo lo devuelve', async () => {
      await encender('adminA', 'document_reading');
      await encender('adminB', 'document_reading');
      const featuresDe = async (actor: string) =>
        (
          (await llamar(ctx, 'get', '/v2/me/features', actor)).body as {
            modules: string[];
          }
        ).modules;
      expect(await featuresDe('adminA')).toContain('document_reading');

      await poner(ctx.distA.id, 'document_reading', false);

      const a = await llamar(ctx, 'get', '/v2/document-readings', 'adminA');
      expect({
        estado: a.status,
        code: (a.body as { code?: string }).code,
      }).toEqual({ estado: 403, code: 'MODULE_DISABLED' });
      const b = await llamar(ctx, 'get', '/v2/document-readings', 'adminB');
      expect(b.status).toBe(200);
      const proceso = await llamar(
        ctx,
        'get',
        '/module-config/document_reading',
        'adminA',
      );
      expect(proceso.status).toBe(403);
      expect(await featuresDe('adminA')).not.toContain('document_reading');
      expect(await featuresDe('adminB')).toContain('document_reading');
      const publicasA = (
        await llamar(
          ctx,
          'get',
          `/v2/public/distributors/${ctx.distA.slug}/features`,
          'nadie',
        )
      ).body as { modules: string[] };
      expect(publicasA.modules).not.toContain('document_reading');

      await poner(ctx.distA.id, 'document_reading', null);
      expect(
        (await llamar(ctx, 'get', '/v2/document-readings', 'adminA')).status,
      ).toBe(200);
      expect(await featuresDe('adminA')).toContain('document_reading');
    });

    it('el proceso del lector no lee la cola de A deshabilitada y sí la de B en la misma corrida; al volver la retoma', async () => {
      await encender('adminA', 'document_reading');
      await encender('adminB', 'document_reading');
      const runner = env.app.get(DocumentReadingRunnerService);
      jest.spyOn(runner, 'disponible', 'get').mockReturnValue(true);
      const leer = jest.spyOn(runner, 'run').mockResolvedValue({
        distributors: 1,
        read: 0,
        duplicates: 0,
        failed: 0,
        skipped: 0,
        budgetReached: 0,
      });
      const cron = env.app.get(DocumentReadingCron);
      await poner(ctx.distA.id, 'document_reading', false);
      // Sin la marca de frecuencia de una corrida anterior.
      const ahora = new Date(Date.now() + 365 * 86_400_000);
      await cron.ejecutarSinCerrojo(ahora);
      const leidas = leer.mock.calls.map(([id]) => id);
      expect(leidas).toContain(ctx.distB.id);
      expect(leidas).not.toContain(ctx.distA.id);

      leer.mockClear();
      await poner(ctx.distA.id, 'document_reading', null);
      await cron.ejecutarSinCerrojo(
        new Date(ahora.getTime() + 365 * 86_400_000),
      );
      expect(leer.mock.calls.map(([id]) => id)).toContain(ctx.distA.id);
      leer.mockRestore();
    });

    it('Mercado Pago deshabilitado para A: sus medios de pago no lo traen; los de B sí', async () => {
      await poner(ctx.distA.id, 'mercadopago', false);
      const medios = async (slug: string) =>
        (
          (
            await llamar(
              ctx,
              'get',
              `/v2/public/distributors/${slug}/payment-methods`,
              'nadie',
            )
          ).body as Array<{ key: string }>
        ).map((m) => m.key);
      expect(await medios(ctx.distA.slug)).toEqual(['CASH', 'TRANSFER']);
      expect(await medios(ctx.distB.slug)).toEqual([
        'CASH',
        'TRANSFER',
        'MERCADOPAGO',
      ]);
    });

    it('cambiar un módulo de A no cambia GET /v2/company/modules de B', async () => {
      const antes = (await llamar(ctx, 'get', '/v2/company/modules', 'adminB'))
        .body as unknown;
      await poner(ctx.distA.id, 'mercadopago', false);
      await poner(ctx.distA.id, 'document_reading', false);
      const despues = (
        await llamar(ctx, 'get', '/v2/company/modules', 'adminB')
      ).body as unknown;
      expect(despues).toEqual(antes);
    });

    it('editar el catálogo de un plan no cambia la foto de ninguna suscripción ni el acceso', async () => {
      const fotos = async () =>
        ds.query<Array<{ distributor_id: string; plan_snapshot: unknown }>>(
          `SELECT distributor_id, plan_snapshot FROM distributor_subscription ORDER BY distributor_id`,
        );
      const antes = await fotos();
      await ds.query(
        `UPDATE platform_plan SET version = version + 1, limits = jsonb_set(limits, '{maxDrivers}', '1') WHERE plan_code = 'full'`,
      );
      await ds.query(
        `UPDATE platform_plan SET version = version + 1 WHERE plan_code = 'basic'`,
      );
      await env.app.get(AccesoDeLaEmpresa).invalidar(ctx.distA.id);
      expect(await fotos()).toEqual(antes);
      const acceso = await env.app.get(AccesoDeLaEmpresa).vigente(ctx.distA.id);
      expect(acceso.limites.maxDrivers).toBeNull();
    });

    it('toda distribuidora nueva nace con su suscripción completa y activa (trigger)', async () => {
      const d = (await ds.getRepository(Distributor).save({
        name: `Nueva ${randomUUID().slice(0, 6)}`,
        slug: `nueva-${randomUUID().slice(0, 6)}`,
      } as Partial<Distributor>)) as Distributor;
      const [s] = await ds.query<
        Array<{ plan_code: string; status: string; is_internal: boolean }>
      >(
        `SELECT plan_code, status::text AS status, is_internal FROM distributor_subscription WHERE distributor_id = $1`,
        [d.distributorId],
      );
      expect(s).toEqual({
        plan_code: 'full',
        status: 'active',
        is_internal: false,
      });
    });

    it('el cambio queda en la auditoría con el super admin y la empresa afectada', async () => {
      await poner(ctx.distA.id, 'mercadopago', false);
      const filas = await ds.query<
        Array<{ user_id: string; distributor_id: string }>
      >(
        `SELECT a.user_id, a.distributor_id FROM audit a
          WHERE a.entity = 'DistributorModule'
          ORDER BY a.created_at DESC LIMIT 1`,
      );
      expect(filas).toEqual([
        { user_id: ctx.superAdmin.userId, distributor_id: ctx.distA.id },
      ]);
    });
  });
});
