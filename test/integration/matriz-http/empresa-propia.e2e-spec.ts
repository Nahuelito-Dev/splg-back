/**
 * Matriz HTTP de la empresa propia de la plataforma (decisión del 14/11): una
 * distribuidora marcada `ownedByPlatform` la opera el super admin directo, con
 * lectura y escritura, mandando su slug o id en `X-Distributor`, sin sesión de
 * soporte. Cualquier otra empresa sigue cerrada (403
 * `SUPPORT_SESSION_REQUIRED`); la marca la pone y la saca sólo el super admin.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RoleType } from '../../../src/common/constants/role-type.enum';
import { Auth } from '../../../src/common/decorators/auth.decorator';
import { CurrentDistributor } from '../../../src/common/decorators/current-distributor.decorator';
import { TestEnv, createTestApp } from '../setup/test-env';
import {
  Caso,
  Escenario,
  cabecerasDe_,
  correrMatriz,
  endpoint,
  reiniciarCuposDelThrottler,
  sembrarEscenario,
  sembrarPersona,
} from './matriz';
import { CODIGO_SIN_SESION, CODIGO_SOLO_LECTURA } from './soporte';

/** Sólo de prueba: un GET que escribe de costado (la capa de la base). */
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'prueba-propia', version: '2' })
class PruebaPropiaController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Get('escribe-en-transaccion')
  async escribe(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<{ ok: boolean }> {
    await this.ds.transaction((m) =>
      m.query(
        `UPDATE "distributor" SET "phone" = '+543764990199' WHERE "distributor_id" = $1`,
        [distributorId],
      ),
    );
    return { ok: true };
  }
}

interface Ctx extends Escenario {
  propia: { id: string; slug: string };
  /** Franja de la propia y de A (para ver el aislamiento). */
  franjaPropia: string;
  franjaA: string;
  franjaB: string;
  p: Record<string, string>;
}

type Filas = Array<Record<string, unknown>>;
const esperar = (ms: number) =>
  new Promise<void>((listo) => setTimeout(listo, ms));
const itemDe = (b: unknown, id: string): Record<string, unknown> | undefined =>
  (b as { items: Filas }).items.find((i) => i.id === id);
const nombres = (b: unknown): unknown[] =>
  (b as Filas).map((f) => f.name).sort();

describe('Matriz HTTP: empresa propia de la plataforma (e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;
  const ds = () => env.app.get(DataSource);

  const nuevaDistribuidora = async (
    etiqueta: string,
    extra: string = '',
    valores: unknown[] = [],
  ): Promise<{ id: string; slug: string }> => {
    const slug = `${etiqueta}-${randomUUID().slice(0, 6)}`;
    const [fila] = await ds().query<Array<{ distributor_id: string }>>(
      `INSERT INTO distributor (name, slug${extra ? `, ${extra}` : ''})
       VALUES ($1, $2${valores.map((_, i) => `, $${i + 3}`).join('')})
       RETURNING distributor_id`,
      [`Empresa ${slug}`, slug, ...valores],
    );
    return { id: fila.distributor_id, slug };
  };
  const franja = async (distributorId: string, nombre: string) => {
    const [fila] = await ds().query<Array<{ time_slot_id: string }>>(
      `INSERT INTO time_slot (distributor_id, name, "startTime", "endTime", capacity, "isActive")
       VALUES ($1, $2, '08:00', '10:00', 10, true) RETURNING time_slot_id`,
      [distributorId, nombre],
    );
    return fila.time_slot_id;
  };
  const marcar = (id: string, valor: boolean) =>
    ds().query(
      `UPDATE distributor SET owned_by_platform = $2 WHERE distributor_id = $1`,
      [id, valor],
    );

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp({ controllers: [PruebaPropiaController] });
    const e = await sembrarEscenario(env.app);
    const propia = await nuevaDistribuidora(
      'propia',
      'owned_by_platform, created_by_platform',
      [true, true],
    );
    ctx = {
      ...e,
      propia,
      franjaPropia: await franja(propia.id, 'Mañana propia'),
      franjaA: await franja(e.distA.id, 'Mañana de A'),
      franjaB: await franja(e.distB.id, 'Mañana de B'),
      p: {},
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    const adminPropia = await sembrarPersona(
      env.app,
      'admin',
      'admin-propia',
      propia.id,
    );
    await ds().query(
      `UPDATE "user" SET created_by_platform = true WHERE user_id = $1`,
      [adminPropia.userId],
    );
    ctx.actores.adminPropia = adminPropia.cabeceras;
    const sa = ctx.superAdmin.email;
    ctx.actores.superEnPropia = cabecerasDe_(sa, 'panel-app', propia.slug);
    ctx.actores.superEnPropiaPorId = cabecerasDe_(sa, 'panel-app', propia.id);
    ctx.actores.superEnB = cabecerasDe_(sa, 'panel-app', ctx.distB.slug);
    ctx.actores.superEnInexistente = cabecerasDe_(
      sa,
      'panel-app',
      'no-existe-esta',
    );
    ctx.actores.adminBEnPropia = cabecerasDe_(
      ctx.adminB.email,
      'panel-app',
      propia.slug,
    );
    // Super admin en modo soporte sobre A que además manda la propia.
    ctx.actores.soporteAConPropia = {
      ...ctx.actores.soporteA,
      'X-Distributor': propia.slug,
    };
    const [clienteA] = await ds().query<Array<{ customer_id: string }>>(
      `SELECT customer_id FROM customer WHERE user_id = $1`,
      [ctx.clienteA.userId],
    );
    ctx.p.clienteAId = clienteA.customer_id;
  }, 300000);

  afterAll(async () => {
    await env?.cleanup();
  });

  // ================================ PUT /v2/platform/companies/{id}/owned-by-platform
  const marcarPut = endpoint<Ctx>(
    'put',
    '/v2/platform/companies/{id}/owned-by-platform',
    (c) => `/v2/platform/companies/${c.p.objetivo}/owned-by-platform`,
  );
  const objetivoNuevo = async (c: Ctx) => {
    c.p.objetivo = (await nuevaDistribuidora('objetivo')).id;
  };
  const objetivoDePlataforma = async (c: Ctx) => {
    c.p.objetivo = (
      await nuevaDistribuidora('objetivo-plataforma', 'created_by_platform', [
        true,
      ])
    ).id;
  };
  const casosMarcar: Array<Caso<Ctx>> = [
    marcarPut('sin token', undefined, 401, {
      antes: objetivoNuevo,
      body: { ownedByPlatform: true },
    }),
    marcarPut('admin de empresa', 'adminA', 403, {
      antes: objetivoNuevo,
      body: { ownedByPlatform: true },
    }),
    marcarPut(
      'admin de la propia (no se marca ni desmarca)',
      'adminPropia',
      403,
      {
        ruta: (c) => `/v2/platform/companies/${c.propia.id}/owned-by-platform`,
        body: { ownedByPlatform: false },
      },
    ),
    marcarPut('cliente', 'clienteA', 403, {
      antes: objetivoNuevo,
      body: { ownedByPlatform: true },
    }),
    marcarPut('id mal formado', 'super', 400, {
      ruta: '/v2/platform/companies/no-es-uuid/owned-by-platform',
      body: { ownedByPlatform: true },
    }),
    marcarPut('falta la marca', 'super', 400, {
      antes: objetivoNuevo,
      body: {},
      mensaje: 'Empresa propia de la plataforma',
    }),
    marcarPut('la marca no es booleana', 'super', 400, {
      antes: objetivoNuevo,
      body: { ownedByPlatform: 'si' },
      mensaje: 'Empresa propia de la plataforma',
    }),
    marcarPut('empresa inexistente', 'super', 404, {
      ruta: (c) => `/v2/platform/companies/${c.inexistente}/owned-by-platform`,
      body: { ownedByPlatform: true },
      code: 'COMPANY_NOT_FOUND',
    }),
    marcarPut('empresa dada de baja', 'super', 404, {
      antes: async (c) => {
        c.p.objetivo = (
          await nuevaDistribuidora('baja', '"deletedAt"', [new Date()])
        ).id;
      },
      body: { ownedByPlatform: true },
      code: 'COMPANY_NOT_FOUND',
    }),
    marcarPut('empresa con admins reales: no se puede marcar', 'super', 409, {
      antes: (c) => {
        c.p.objetivo = c.distA.id;
        return Promise.resolve();
      },
      body: { ownedByPlatform: true },
      code: 'COMPANY_NOT_PLATFORM_OWNED',
    }),
    marcarPut(
      'marcar: queda propia y auditada con el super admin',
      'super',
      200,
      {
        antes: objetivoDePlataforma,
        body: { ownedByPlatform: true },
        verificar: async (b, c) => {
          const filas = await ds().query<Filas>(
            `SELECT a.user_id,
                  (SELECT string_agg(field || '=' || coalesce(old_value, '') || '>' || coalesce(new_value, ''), ',')
                     FROM audit_detail d WHERE d.audit_id = a.audit_id) AS campos
             FROM audit a
            WHERE a.entity = 'Distributor' AND a.record_id = $1
              AND EXISTS (SELECT 1 FROM audit_detail d
                           WHERE d.audit_id = a.audit_id AND d.field = 'ownedByPlatform'
                             AND d.old_value IS NOT NULL)`,
            [c.p.objetivo],
          );
          expect({ cuerpo: b, auditoria: filas }).toMatchObject({
            cuerpo: {
              id: c.p.objetivo,
              ownedByPlatform: true,
              status: 'active',
            },
            auditoria: [{ user_id: c.superAdmin.userId }],
          });
          expect(filas[0].campos).toBe('ownedByPlatform=false>true');
          expect(b).not.toHaveProperty('bankCbu');
        },
      },
    ),
    marcarPut('marcar de nuevo: idempotente, sin otro asiento', 'super', 200, {
      antes: async (c) => {
        await objetivoDePlataforma(c);
        await marcar(c.p.objetivo, true);
      },
      body: { ownedByPlatform: true },
      verificar: async (b, c) => {
        const [{ n }] = await ds().query<Array<{ n: string }>>(
          `SELECT count(*) AS n FROM audit a
            WHERE a.entity = 'Distributor' AND a.record_id = $1
              AND a.user_id IS NOT NULL`,
          [c.p.objetivo],
        );
        expect({ cuerpo: b, asientosDelSuper: Number(n) }).toMatchObject({
          cuerpo: { ownedByPlatform: true },
          asientosDelSuper: 0,
        });
      },
    }),
    marcarPut('desmarcar', 'super', 200, {
      antes: async (c) => {
        await objetivoDePlataforma(c);
        await marcar(c.p.objetivo, true);
      },
      body: { ownedByPlatform: false },
      verificar: (b) => {
        expect(b).toMatchObject({ ownedByPlatform: false });
      },
    }),
  ];
  correrMatriz(
    'PUT /v2/platform/companies/{id}/owned-by-platform',
    ver,
    casosMarcar,
  );

  // ============== GET /v2/platform/companies (contrato unificado de E3)
  const listar = endpoint<Ctx>(
    'get',
    '/v2/platform/companies',
    '/v2/platform/companies?limit=100',
  );
  const casosListar: Array<Caso<Ctx>> = [
    listar('sin token', undefined, 401),
    listar('admin de empresa', 'adminA', 403),
    listar('admin de la propia', 'adminPropia', 403),
    listar('filtro de la marca inválido', 'super', 400, {
      ruta: '/v2/platform/companies?ownedByPlatform=quizas',
      mensaje: 'Empresa propia de la plataforma',
    }),
    listar('paginación fuera de rango', 'super', 400, {
      ruta: '/v2/platform/companies?limit=0',
    }),
    listar(
      'super admin: todas, con la marca, métricas y sin datos bancarios',
      'super',
      200,
      {
        verificar: (b, c) => {
          const r = b as { items: Filas; total: number };
          expect({
            propia: itemDe(b, c.propia.id)?.ownedByPlatform,
            a: itemDe(b, c.distA.id)?.ownedByPlatform,
            primera: r.items[0]?.ownedByPlatform,
            claves: Object.keys(itemDe(b, c.propia.id) ?? {}).sort(),
          }).toEqual({
            propia: true,
            a: false,
            primera: true,
            claves: [
              'createdAt',
              'id',
              'lastActivityAt',
              'metrics',
              'name',
              'ownedByPlatform',
              'plan',
              'processAlerts',
              'slug',
              'status',
              'supportRequestsPending',
              'supportSessionActive',
            ],
          });
        },
      },
    ),
    listar('super admin: sólo las propias', 'super', 200, {
      ruta: '/v2/platform/companies?ownedByPlatform=true',
      verificar: (b, c) => {
        const r = b as { items: Filas; total: number };
        expect({
          todasPropias: r.items.every((i) => i.ownedByPlatform === true),
          estaLaPropia: r.items.some((i) => i.id === c.propia.id),
        }).toEqual({ todasPropias: true, estaLaPropia: true });
      },
    }),
    listar('super admin: sólo las de clientes', 'super', 200, {
      ruta: '/v2/platform/companies?ownedByPlatform=false',
      verificar: (b, c) => {
        const r = b as { items: Filas; total: number };
        expect({
          ningunaPropia: r.items.every((i) => i.ownedByPlatform === false),
          estaA: r.items.some((i) => i.id === c.distA.id),
        }).toEqual({ ningunaPropia: true, estaA: true });
      },
    }),
  ];
  correrMatriz('GET /v2/platform/companies', ver, casosListar);

  // ==================== Operación directa del super admin (GET/POST /time-slot)
  const leer = endpoint<Ctx>('get', '/time-slot', '/time-slot');
  const escribir = endpoint<Ctx>('post', '/time-slot', '/time-slot');
  const franjaNueva = () => ({
    name: `Tarde ${randomUUID().slice(0, 6)}`,
    startTime: '14:00',
    endTime: '16:00',
  });
  const propiaMarcada = (c: Ctx) => marcar(c.propia.id, true);
  const casosOperar: Array<Caso<Ctx>> = [
    leer(
      'super admin en la propia (slug): lee sólo lo de ella',
      'superEnPropia',
      200,
      {
        antes: propiaMarcada,
        verificar: (b) => {
          expect(nombres(b)).toEqual(expect.arrayContaining(['Mañana propia']));
          expect(nombres(b)).not.toContain('Mañana de A');
          expect(nombres(b)).not.toContain('Mañana de B');
        },
      },
    ),
    leer('super admin en la propia (uuid)', 'superEnPropiaPorId', 200, {
      antes: propiaMarcada,
      verificar: (b) => {
        expect(nombres(b)).toContain('Mañana propia');
      },
    }),
    escribir(
      'super admin en la propia: escribe, auditado con él y la empresa',
      'superEnPropia',
      201,
      {
        antes: propiaMarcada,
        body: franjaNueva,
        verificar: async (b, c) => {
          const id = (b as { time_slot_id: string }).time_slot_id;
          const datos = await ds().query<Filas>(
            `SELECT user_id, distributor_id FROM audit
              WHERE entity = 'TimeSlot' AND record_id = $1`,
            [id],
          );
          // `audit_log` lo escribe el interceptor sin demorar la respuesta.
          let http: Filas = [];
          for (let i = 0; i < 20 && http.length === 0; i++) {
            if (i > 0) await esperar(100);
            http = await ds().query<Filas>(
              `SELECT actor_user_id, actor_role, distributor_id FROM audit_log
                WHERE http_method = 'POST' AND path LIKE '%time-slot%'
                  AND actor_user_id = $1 AND distributor_id IS NOT NULL`,
              [c.superAdmin.userId],
            );
          }
          expect({ datos, http }).toMatchObject({
            datos: [
              { user_id: c.superAdmin.userId, distributor_id: c.propia.id },
            ],
            http: [
              {
                actor_user_id: c.superAdmin.userId,
                actor_role: 'super_admin',
                distributor_id: c.propia.id,
              },
            ],
          });
        },
      },
    ),
    endpoint<Ctx>('patch', '/time-slot/{id}', (c) => `/time-slot/${c.franjaA}`)(
      'super admin en la propia: una franja de A no existe para él',
      'superEnPropia',
      404,
      { antes: propiaMarcada, body: { capacity: 3 } },
    ),
    endpoint<Ctx>(
      'get',
      '/v2/prueba-propia/escribe-en-transaccion',
      '/v2/prueba-propia/escribe-en-transaccion',
    )(
      'super admin en la propia: la base no queda en sólo lectura',
      'superEnPropia',
      200,
      { antes: propiaMarcada },
    ),
    leer(
      'super admin con el X-Distributor de B (no propia): no lee',
      'superEnB',
      403,
      {
        code: CODIGO_SIN_SESION,
      },
    ),
    escribir(
      'super admin con el X-Distributor de B (no propia): no escribe',
      'superEnB',
      403,
      { body: franjaNueva, code: CODIGO_SIN_SESION },
    ),
    leer(
      'super admin con un X-Distributor inexistente',
      'superEnInexistente',
      403,
      {
        code: CODIGO_SIN_SESION,
      },
    ),
    leer('super admin con la propia suspendida', 'super', 403, {
      antes: async (c) => {
        const s = await nuevaDistribuidora(
          'propia-suspendida',
          'owned_by_platform, status',
          [true, 'suspended'],
        );
        c.actores.superEnSuspendida = cabecerasDe_(
          c.superAdmin.email,
          'panel-app',
          s.slug,
        );
      },
      cabeceras: (c) => c.actores.superEnSuspendida,
      code: CODIGO_SIN_SESION,
    }),
    escribir('super admin con la propia ya desmarcada', 'super', 403, {
      antes: async (c) => {
        const d = await nuevaDistribuidora('desmarcada', 'owned_by_platform', [
          true,
        ]);
        await marcar(d.id, false);
        c.actores.superEnDesmarcada = cabecerasDe_(
          c.superAdmin.email,
          'panel-app',
          d.slug,
        );
      },
      cabeceras: (c) => c.actores.superEnDesmarcada,
      body: franjaNueva,
      code: CODIGO_SIN_SESION,
    }),
    leer(
      'admin de B con el X-Distributor de la propia: ve lo suyo',
      'adminBEnPropia',
      200,
      {
        antes: propiaMarcada,
        verificar: (b) => {
          expect(nombres(b)).toContain('Mañana de B');
          expect(nombres(b)).not.toContain('Mañana propia');
        },
      },
    ),
    escribir(
      'super admin en soporte de A que manda la propia: manda la sesión (sólo lectura)',
      'soporteAConPropia',
      403,
      { antes: propiaMarcada, body: franjaNueva, code: CODIGO_SOLO_LECTURA },
    ),
  ];
  correrMatriz('Operación directa en la empresa propia', ver, casosOperar);

  // ========== Los atajos del super admin de plataforma no corren en la propia
  const casosAtajos: Array<Caso<Ctx>> = [
    endpoint<Ctx>('patch', '/users/{id}', (c) => `/users/${c.clienteA.userId}`)(
      'super admin en la propia: no cambia la contraseña de un cliente compartido',
      'superEnPropia',
      403,
      { antes: propiaMarcada, body: { password: 'OtraClave123' } },
    ),
    endpoint<Ctx>(
      'patch',
      '/users/{id}/block',
      (c) => `/users/${c.clienteA.userId}/block`,
    )(
      'super admin en la propia: no bloquea a un cliente compartido',
      'superEnPropia',
      403,
      { antes: propiaMarcada, body: { block: true } },
    ),
    endpoint<Ctx>(
      'delete',
      '/customers/{id}',
      (c) => `/customers/${c.p.clienteAId}`,
    )(
      'super admin en la propia: no da de baja global a un cliente de otra empresa',
      'superEnPropia',
      403,
      { antes: propiaMarcada },
    ),
    endpoint<Ctx>('post', '/user-address', '/user-address')(
      'super admin en la propia: no crea una dirección global para un cliente de otra empresa',
      'superEnPropia',
      404,
      {
        antes: propiaMarcada,
        body: (c) => ({
          user_id: c.clienteA.userId,
          street: 'Calle ajena 1',
          city: 'Posadas',
          latitude: '-27.3671',
          longitude: '-55.8961',
        }),
      },
    ),
    endpoint<Ctx>('get', '/admin', (c) => `/admin?distributorId=${c.distA.id}`)(
      'super admin en la propia: no pide los admins de A',
      'superEnPropia',
      403,
      {
        antes: propiaMarcada,
      },
    ),
    endpoint<Ctx>('post', '/users', '/users')(
      'super admin en la propia: no da de alta un admin en A',
      'superEnPropia',
      403,
      {
        antes: propiaMarcada,
        body: (c) => ({
          email: `otro.${randomUUID().slice(0, 6)}@splg.local`,
          password: 'Test1234',
          full_name: 'Admin Ajeno',
          phone_number: '+5493764990177',
          rol: 'admin',
          distributorId: c.distA.id,
        }),
      },
    ),
    endpoint<Ctx>('post', '/users', '/users')(
      'super admin en la propia: no crea un super admin desde la empresa',
      'superEnPropia',
      403,
      {
        antes: propiaMarcada,
        body: () => ({
          email: `super.${randomUUID().slice(0, 6)}@splg.local`,
          password: 'Test1234',
          full_name: 'Otro Super',
          phone_number: '+5493764990178',
          rol: 'super_admin',
        }),
      },
    ),
    endpoint<Ctx>(
      'get',
      '/time-slot',
      (c) => `/time-slot?distributor=${c.distA.id}`,
    )(
      'super admin en la propia: ?distributor= de A no cambia de empresa',
      'superEnPropia',
      200,
      {
        antes: propiaMarcada,
        verificar: (b) => {
          expect(nombres(b)).not.toContain('Mañana de A');
          expect(nombres(b)).toContain('Mañana propia');
        },
      },
    ),
    endpoint<Ctx>(
      'get',
      '/distributor/{id}/logo',
      (c) => `/distributor/${c.distA.id}/logo`,
    )(
      'super admin en la propia: el logo de A no existe para él',
      'superEnPropia',
      404,
      { antes: propiaMarcada, mensajeExacto: 'Distribuidora no encontrada' },
    ),
    endpoint<Ctx>('post', '/notifications/token', '/notifications/token')(
      'super admin en la propia: no registra el token de un cliente ajeno',
      'superEnPropia',
      201,
      {
        antes: propiaMarcada,
        body: (c) => ({
          userId: c.clienteA.userId,
          token: 'token-secuestrado',
          platform: 'android',
        }),
        verificar: async (_b, c) => {
          const [fila] = await ds().query<Filas>(
            `SELECT notification_token FROM customer WHERE user_id = $1`,
            [c.clienteA.userId],
          );
          expect(fila.notification_token).not.toBe('token-secuestrado');
        },
      },
    ),
  ];
  correrMatriz('Atajos de plataforma en la empresa propia', ver, casosAtajos);

  it('order-confirmation en soporte responde 404 si el cliente es de otra empresa', async () => {
    await propiaMarcada(ctx);
    await request(env.app.getHttpServer())
      .post('/notifications/order-confirmation')
      .set(ctx.actores.soporteA)
      .send({ customerId: ctx.clienteB.userId, orderId: randomUUID() })
      .expect(404);
  });
});
