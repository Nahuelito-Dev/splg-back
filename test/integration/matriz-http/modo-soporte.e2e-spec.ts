/**
 * Matriz HTTP del modo soporte (E1, diseño §5): el super admin fuera de
 * soporte no ve operación; con una sesión aprobada (o de emergencia) ve UNA
 * empresa en sólo lectura; la empresa aprueba, rechaza, revoca y fija su
 * política. Cada caso prepara lo suyo (`antes`) con su propio super admin, así
 * no depende del orden.
 */
import { randomUUID } from 'crypto';
import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Admin } from '../../../src/admin/entities/admin.entity';
import { RoleType } from '../../../src/common/constants/role-type.enum';
import { Auth } from '../../../src/common/decorators/auth.decorator';
import { CurrentDistributor } from '../../../src/common/decorators/current-distributor.decorator';
import { Role } from '../../../src/role/entities/role.entity';
import { User } from '../../../src/users/entities/user.entity';
import { SupportSessionExpiryCron } from '../../../src/support/application/support-session-expiry.cron';
import { TestEnv, createTestApp, telefonoDePrueba } from '../setup/test-env';
import {
  Cabeceras,
  Caso,
  cabecerasDe_,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
} from './matriz';
import { EscenarioT2, sembrarBaseT2, sembrarPedido } from './t2-base';
import { sembrarEscenario } from './matriz';
import { conSesionDeSoporte } from './soporte';

/** Endpoints sólo de prueba: un GET que escribe de costado (la segunda capa). */
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'prueba-soporte', version: '2' })
class PruebaSoporteController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Get('escribe-suelto')
  async escribeSuelto(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<{ ok: boolean }> {
    await this.ds.query(
      `UPDATE "distributor" SET "name" = "name" || '!' WHERE "distributor_id" = $1`,
      [distributorId],
    );
    return { ok: true };
  }

  @Get('escribe-en-transaccion')
  async escribeEnTransaccion(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<{ ok: boolean }> {
    await this.ds.transaction((m) =>
      m.query(
        `UPDATE "distributor" SET "name" = "name" || '!' WHERE "distributor_id" = $1`,
        [distributorId],
      ),
    );
    return { ok: true };
  }
}

const MOTIVO = 'El tablero de despacho no muestra los pedidos de hoy';

// Ayudas a nivel de módulo: las verificaciones de los casos no definen
// funciones adentro (jest/no-standalone-expect pierde el rastro con ellas).
const esperar = (ms: number) =>
  new Promise<void>((listo) => setTimeout(listo, ms));
/** Los segundos que S3 le da a una URL firmada (`X-Amz-Expires`); null si no es URL. */
const amzExpires = (url: unknown): number | null =>
  typeof url === 'string'
    ? Number(new URL(url).searchParams.get('X-Amz-Expires'))
    : null;
type Filas = Array<Record<string, unknown>>;
const filasDe = (b: unknown, clave: string): Filas =>
  ((b as Record<string, unknown>)[clave] ?? []) as Filas;
/** Los valores distintos de un campo en las filas, ordenados. */
const valoresDe = (filas: Filas, campo: string): unknown[] =>
  [...new Set(filas.map((f) => f[campo] ?? null))].sort();
const tiposDeRol = (b: unknown): unknown[] =>
  [
    ...new Set(
      filasDe(b, 'users').map(
        (u) => (u.role as { type?: string } | undefined)?.type ?? null,
      ),
    ),
  ].sort();
const enlaceDe = (a: Record<string, unknown>): string | null =>
  (a.link as { id?: string } | null)?.id ?? null;
const avisosDe = (b: unknown, kind: string, linkId: string): Filas =>
  filasDe(b, 'items').filter((a) => a.kind === kind && enlaceDe(a) === linkId);
/** Los enlaces de la bandeja que apuntan a alguna de esas sesiones. */
const enlacesA = (b: unknown, sesiones: Filas): string[] => {
  const ids = new Set(sesiones.map((f) => f.id));
  return filasDe(b, 'items')
    .map(enlaceDe)
    .filter((id): id is string => id !== null && ids.has(id));
};
/** Si todas las pendientes vienen antes que las demás. */
const pendientesPrimero = (b: unknown): boolean => {
  const estados = filasDe(b, 'items').map((i) => i.status);
  const primeraNoPendiente = estados.findIndex((e) => e !== 'pending');
  return (
    primeraNoPendiente === -1 ||
    estados.lastIndexOf('pending') < primeraNoPendiente
  );
};
const SUPPORT = 'X-Support-Session';

interface Ctx extends EscenarioT2 {
  env: TestEnv;
  pedidoA: string;
  pedidoB: string;
  /** Super admins: uno por caso que deja estado, con su sesión si la tiene. */
  supers: Record<string, { email: string; userId: string; sesion?: string }>;
  /** Admin de A con un rol que sólo ve los accesos (sin `soporte.gestionar`). */
  adminLector: string;
}

describe('Matriz HTTP: modo soporte del super admin (E1, e2e)', () => {
  let env: TestEnv;
  let ctx: Ctx;
  const ver = () => ctx;

  const pedir = async (
    metodo: 'get' | 'post' | 'put' | 'patch' | 'delete',
    ruta: string,
    cabeceras: Cabeceras,
    esperado: number,
    body?: object,
  ): Promise<Record<string, unknown>> => {
    ctx.actores.__tmp = cabeceras;
    const res = await llamar(ctx, metodo, ruta, '__tmp', body);
    expect({ ruta, estado: res.status, cuerpo: res.body as unknown }).toEqual(
      expect.objectContaining({ estado: esperado }),
    );
    return (res.body ?? {}) as Record<string, unknown>;
  };

  const ds = () => env.app.get(DataSource);

  /** Un super admin nuevo (cuenta propia, sin sesión). */
  const nuevoSuper = async (nombre: string): Promise<Cabeceras> => {
    const rol = await ds()
      .getRepository(Role)
      .findOneByOrFail({ type: RoleType.SUPER_ADMIN });
    const email = `super-${nombre}.${randomUUID().slice(0, 6)}@splg.local`;
    const u = (await ds()
      .getRepository(User)
      .save({
        email,
        fullName: `Soporte ${nombre}`,
        phoneNumber: telefonoDePrueba(),
        firebaseUid: `uid-${email}`,
        roleId: rol.roleId,
      } as Partial<User>)) as User;
    await ds()
      .getRepository(Admin)
      .save({ userId: u.userId, distributorId: null } as Partial<Admin>);
    ctx.supers[nombre] = { email, userId: u.userId };
    ctx.actores[nombre] = cabecerasDe_(email, 'panel-app');
    return ctx.actores[nombre];
  };

  /** Cabeceras del super `nombre` en su sesión (y, si se pide, con un X-Distributor). */
  const enSesion = (nombre: string, xDistributor?: string): Cabeceras => ({
    ...cabecerasDe_(ctx.supers[nombre].email, 'panel-app', xDistributor),
    [SUPPORT]: ctx.supers[nombre].sesion ?? 'sin-sesion',
  });

  /** Pide acceso (pendiente) y devuelve el id. */
  const pedirAcceso = async (
    nombre: string,
    distributorId: string,
    extra: object = {},
  ): Promise<string> => {
    const cab = ctx.actores[nombre] ?? (await nuevoSuper(nombre));
    const body = await pedir('post', '/v2/support-sessions', cab, 201, {
      distributorId,
      reason: MOTIVO,
      minutes: 60,
      ...extra,
    });
    ctx.supers[nombre].sesion = body.id as string;
    return body.id as string;
  };

  /** Sesión activa: pide a A y el admin de A la aprueba. */
  const sesionActiva = async (nombre: string, aprobada: object = {}) => {
    const id = await pedirAcceso(nombre, ctx.distA.id, {
      scope: ['personal_data'],
    });
    await pedir(
      'post',
      `/v2/support-access/${id}/approve`,
      ctx.actores.adminA,
      200,
      aprobada,
    );
    return id;
  };

  const estadoDe = async (id: string) =>
    (
      await ds().query<Array<Record<string, unknown>>>(
        `SELECT * FROM support_session WHERE support_session_id = $1`,
        [id],
      )
    )[0];

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp({ controllers: [PruebaSoporteController] });
    const e = await sembrarEscenario(env.app);
    const t2 = await sembrarBaseT2(env.app, e);
    ctx = {
      ...t2,
      env,
      pedidoA: '',
      pedidoB: '',
      supers: {},
      adminLector: '',
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    ctx.pedidoA = await sembrarPedido(ctx, {});
    ctx.pedidoB = await sembrarPedido(ctx, { cliente: 'B' });

    // Admin de A con un rol que sólo ve los accesos de soporte.
    const rol = await pedir(
      'post',
      '/v2/staff-roles',
      ctx.actores.adminA,
      201,
      {
        name: `Lector de soporte ${randomUUID().slice(0, 6)}`,
        permissions: ['soporte.ver'],
      },
    );
    await pedir(
      'put',
      `/v2/admins/${ctx.adminA2.adminId}/staff-role`,
      ctx.actores.adminA,
      200,
      { staffRoleId: rol.staffRoleId },
    );
  }, 300000);

  afterAll(async () => {
    await env?.cleanup();
  });

  // ============================================ POST /v2/support-sessions
  const crear = endpoint<Ctx>(
    'post',
    '/v2/support-sessions',
    '/v2/support-sessions',
  );
  const cuerpo = (c: Ctx, extra: object = {}) => ({
    distributorId: c.distA.id,
    reason: MOTIVO,
    minutes: 60,
    ...extra,
  });
  const casosCrear: Array<Caso<Ctx>> = [
    crear('sin token', undefined, 401, { body: (c) => cuerpo(c) }),
    crear('admin de empresa', 'adminA', 403, { body: (c) => cuerpo(c) }),
    crear('cliente', 'clienteA', 403, { body: (c) => cuerpo(c) }),
    crear('motivo corto', 'super', 400, {
      body: (c) => cuerpo(c, { reason: 'corto' }),
      mensaje: 'Motivo',
    }),
    crear('minutos fuera de la lista (45)', 'super', 400, {
      body: (c) => cuerpo(c, { minutes: 45 }),
    }),
    crear('emergencia de 120 minutos', 'super', 400, {
      body: (c) => cuerpo(c, { minutes: 120, emergency: true }),
      mensaje: 'como máximo 60 minutos',
    }),
    crear('alcance desconocido', 'super', 400, {
      body: (c) => cuerpo(c, { scope: ['todo'] }),
    }),
    crear('empresa inexistente', 'super', 404, {
      body: (c) => cuerpo(c, { distributorId: c.inexistente }),
    }),
    crear('empresa dada de baja', 'super', 404, {
      antes: async (c) => {
        const r = await ds().query<Array<{ distributor_id: string }>>(
          `INSERT INTO distributor (name, slug, "deletedAt")
           VALUES ('Baja', $1, now()) RETURNING distributor_id`,
          [`baja-${randomUUID().slice(0, 6)}`],
        );
        c.p.empresaDeBaja = r[0].distributor_id;
      },
      body: (c) => cuerpo(c, { distributorId: c.p.empresaDeBaja }),
    }),
    crear('empresa suspendida', 'super', 409, {
      antes: async (c) => {
        const r = await ds().query<Array<{ distributor_id: string }>>(
          `INSERT INTO distributor (name, slug, status)
           VALUES ('Suspendida', $1, 'suspended') RETURNING distributor_id`,
          [`susp-${randomUUID().slice(0, 6)}`],
        );
        c.p.empresaSuspendida = r[0].distributor_id;
      },
      body: (c) => cuerpo(c, { distributorId: c.p.empresaSuspendida }),
      code: 'SUPPORT_COMPANY_SUSPENDED',
    }),
    crear('consentido: queda pendiente', 'super', 201, {
      antes: () => nuevoSuper('pide').then(() => undefined),
      cabeceras: (c) => c.actores.pide,
      body: (c) => cuerpo(c, { scope: ['files', 'personal_data'] }),
      verificar: (b) => {
        expect(b).toMatchObject({
          status: 'pending',
          kind: 'consented',
          scope: ['files', 'personal_data'],
          startedAt: null,
          expiresAt: null,
        });
      },
    }),
    crear('ya tiene un pedido pendiente para esa empresa', 'super', 409, {
      antes: (c) => pedirAcceso('doble', c.distA.id).then(() => undefined),
      cabeceras: (c) => c.actores.doble,
      body: (c) => cuerpo(c),
      code: 'SUPPORT_REQUEST_ALREADY_PENDING',
    }),
    crear('ya tiene una activa y pide otra', 'super', 409, {
      antes: () => sesionActiva('conActiva').then(() => undefined),
      cabeceras: (c) => c.actores.conActiva,
      body: (c) => cuerpo(c, { distributorId: c.distB.id }),
      code: 'SUPPORT_SESSION_ALREADY_ACTIVE',
    }),
    crear('emergencia con la política de la empresa en falso', 'super', 403, {
      antes: async (c) => {
        await pedir('put', '/v2/support-access/policy', c.actores.adminB, 200, {
          emergencyAllowed: false,
        });
      },
      body: (c) =>
        cuerpo(c, { distributorId: c.distB.id, emergency: true, minutes: 30 }),
      code: 'SUPPORT_EMERGENCY_DISABLED',
    }),
    crear(
      'emergencia permitida: activa y aviso en la bandeja del admin',
      'super',
      201,
      {
        antes: () => nuevoSuper('emergencia').then(() => undefined),
        cabeceras: (c) => c.actores.emergencia,
        body: (c) => cuerpo(c, { emergency: true, minutes: 30 }),
        verificar: async (b, c) => {
          const s = b as { id: string; status: string; kind: string };
          c.supers.emergencia.sesion = s.id;
          // El aviso lo guarda un listener asíncrono: se espera a que aparezca.
          let enA: Filas = [];
          for (let i = 0; i < 20 && enA.length === 0; i++) {
            if (i > 0) await esperar(150);
            enA = avisosDe(
              await pedir(
                'get',
                '/v2/admin-notifications',
                c.actores.adminA,
                200,
              ),
              'support_emergency_opened',
              s.id,
            );
          }
          // La empresa B no recibe el aviso de A.
          const enB = avisosDe(
            await pedir(
              'get',
              '/v2/admin-notifications',
              c.actores.adminB,
              200,
            ),
            'support_emergency_opened',
            s.id,
          );
          expect({
            status: s.status,
            kind: s.kind,
            avisosEnA: enA.length,
            avisosEnB: enB.length,
          }).toEqual({
            status: 'active',
            kind: 'emergency',
            avisosEnA: 1,
            avisosEnB: 0,
          });
        },
      },
    ),
    crear('autoaprobación de la empresa: activa al instante', 'super', 201, {
      antes: async (c) => {
        await nuevoSuper('auto');
        await pedir('put', '/v2/support-access/policy', c.actores.adminB, 200, {
          autoApprove: true,
        });
      },
      cabeceras: (c) => c.actores.auto,
      body: (c) => cuerpo(c, { distributorId: c.distB.id, minutes: 15 }),
      verificar: async (b, c) => {
        expect(b).toMatchObject({
          status: 'active',
          kind: 'consented',
          decidedBy: null,
          decisionNote:
            'Aprobada automáticamente por la política de la empresa',
        });
        await pedir('put', '/v2/support-access/policy', c.actores.adminB, 200, {
          autoApprove: false,
        });
      },
    }),
  ];
  correrMatriz('POST /v2/support-sessions', ver, casosCrear);

  // ============================== Lo de una empresa sin / con sesión
  const ordenes = endpoint<Ctx>('get', '/orders', '/orders');
  const casosLectura: Array<Caso<Ctx>> = [
    ordenes('super admin sin sesión', 'super', 403, {
      code: 'SUPPORT_SESSION_REQUIRED',
      mensajeExacto: 'Para ver datos de una empresa entrá en modo soporte',
    }),
    ordenes(
      'super admin sin sesión con X-Distributor (ya no se lee)',
      'super',
      403,
      {
        cabeceras: (c) => ({ 'X-Distributor': c.distA.slug }),
        code: 'SUPPORT_SESSION_REQUIRED',
      },
    ),
    ordenes('super admin con su sesión pendiente', 'super', 403, {
      antes: (c) => pedirAcceso('pendiente', c.distA.id).then(() => undefined),
      cabeceras: () => enSesion('pendiente'),
      code: 'SUPPORT_SESSION_ENDED',
    }),
    ordenes(
      'con sesión activa: sólo los de esa empresa aunque mande X-Distributor de otra',
      'super',
      200,
      {
        antes: () => sesionActiva('lector').then(() => undefined),
        cabeceras: (c) => enSesion('lector', c.distB.slug),
        verificar: (b, c) => {
          const pedidos = (b as { orders: Array<{ distributor_id: string }> })
            .orders;
          expect(pedidos.length).toBeGreaterThan(0);
          expect(pedidos.every((p) => p.distributor_id === c.distA.id)).toBe(
            true,
          );
        },
      },
    ),
    ordenes('X-Support-Session de otro super admin', 'super', 404, {
      antes: async (c) => {
        if (!c.supers.lector?.sesion) await sesionActiva('lector');
        await nuevoSuper('ajeno');
      },
      cabeceras: (c) => ({
        ...c.actores.ajeno,
        [SUPPORT]: c.supers.lector.sesion as string,
      }),
      code: 'SUPPORT_SESSION_NOT_FOUND',
    }),
    ordenes('X-Support-Session que no es un uuid', 'super', 404, {
      cabeceras: { [SUPPORT]: 'cualquier-cosa' },
      code: 'SUPPORT_SESSION_NOT_FOUND',
    }),
    ordenes('X-Support-Session inexistente', 'super', 404, {
      cabeceras: (c) => ({ [SUPPORT]: c.inexistente }),
      code: 'SUPPORT_SESSION_NOT_FOUND',
    }),
    ordenes(
      'sesión revocada por el admin: la request siguiente',
      'super',
      403,
      {
        antes: async (c) => {
          const id = await sesionActiva('revocado');
          // Con la sesión andando (y en la caché)...
          await pedir('get', '/orders', enSesion('revocado'), 200);
          // ...el admin la revoca: vale desde la request siguiente.
          await pedir(
            'post',
            `/v2/support-access/${id}/revoke`,
            c.actores.adminA,
            200,
          );
        },
        cabeceras: () => enSesion('revocado'),
        code: 'SUPPORT_SESSION_ENDED',
      },
    ),
    ordenes('sesión vencida (fecha forzada en la base)', 'super', 403, {
      antes: async () => {
        const id = await sesionActiva('vencido');
        await ds().query(
          `UPDATE support_session
              SET started_at = now() - interval '2 hours',
                  expires_at = now() - interval '1 hour'
            WHERE support_session_id = $1`,
          [id],
        );
      },
      cabeceras: () => enSesion('vencido'),
      code: 'SUPPORT_SESSION_ENDED',
    }),
    ordenes('empresa suspendida durante la sesión: la cierra', 'super', 403, {
      antes: async (c) => {
        const r = await ds().query<Array<{ distributor_id: string }>>(
          `INSERT INTO distributor (name, slug) VALUES ('Se suspende', $1)
           RETURNING distributor_id`,
          [`se-susp-${randomUUID().slice(0, 6)}`],
        );
        c.p.seSuspende = r[0].distributor_id;
        const id = await pedirAcceso('suspension', c.p.seSuspende, {
          emergency: true,
          minutes: 15,
        });
        c.p.sesionSuspension = id;
        // Primero la sesión anda y queda en la caché (Redis)...
        await pedir('get', '/orders', enSesion('suspension'), 200);
        // ...y recién después se suspende la empresa.
        await ds().query(
          `UPDATE distributor SET status = 'suspended' WHERE distributor_id = $1`,
          [c.p.seSuspende],
        );
      },
      cabeceras: () => enSesion('suspension'),
      code: 'SUPPORT_SESSION_ENDED',
      verificar: async (_b, c) => {
        expect(await estadoDe(c.p.sesionSuspension)).toMatchObject({
          status: 'revoked',
          end_reason: 'revoked_by_platform',
        });
      },
    }),
    ordenes(
      'admin de empresa sigue igual (con X-Support-Session ajeno)',
      'adminA',
      200,
      {
        cabeceras: (c) => ({
          [SUPPORT]: c.supers.lector?.sesion ?? c.inexistente,
        }),
        verificar: (b, c) => {
          const pedidos = (b as { orders: Array<{ distributor_id: string }> })
            .orders;
          expect(pedidos.every((p) => p.distributor_id === c.distA.id)).toBe(
            true,
          );
        },
      },
    ),
  ];
  correrMatriz('GET /orders en modo soporte', ver, casosLectura);

  const ficha = endpoint<Ctx>(
    'get',
    '/orders/{id}',
    (c) => `/orders/${c.pedidoB}`,
  );
  const fichaA = endpoint<Ctx>(
    'get',
    '/orders/{id}',
    (c) => `/orders/${c.pedidoA}`,
  );
  correrMatriz('GET /orders/{id} en modo soporte', ver, [
    ficha('con sesión en A, un pedido de B', 'super', 404, {
      antes: async () => {
        if (!ctx.supers.lector?.sesion) await sesionActiva('lector');
      },
      cabeceras: (c) => enSesion('lector', c.distB.slug),
    }),
    fichaA('con sesión en A, un pedido de A', 'super', 200, {
      antes: async () => {
        if (!ctx.supers.lector?.sesion) await sesionActiva('lector');
      },
      cabeceras: () => enSesion('lector'),
    }),
  ]);

  // ======================================= Escrituras en modo soporte
  const escritura = (
    metodo: 'patch' | 'post' | 'delete',
    swagger: string,
    ruta: (c: Ctx) => string,
    body: object | undefined,
    foto: (c: Ctx) => Promise<unknown>,
  ): Caso<Ctx> => {
    let antes: unknown;
    return endpoint<Ctx>(metodo, swagger, ruta)(
      'con sesión: sólo lectura, sin cambio en la base',
      'super',
      403,
      {
        antes: async (c) => {
          if (!c.supers.lector?.sesion) await sesionActiva('lector');
          antes = await foto(c);
        },
        cabeceras: () => enSesion('lector'),
        body,
        code: 'SUPPORT_READ_ONLY',
        mensajeExacto: 'Estás en modo soporte: es sólo lectura',
        verificar: async (_b, c) => expect(await foto(c)).toEqual(antes),
      },
    );
  };
  const filaDelPedido = (c: Ctx) =>
    ds().query(
      `SELECT status, notes, "updatedAt" FROM "order" WHERE order_id = $1`,
      [c.pedidoA],
    );
  correrMatriz('Escrituras en modo soporte', ver, [
    escritura(
      'patch',
      '/orders/{id}',
      (c) => `/orders/${c.pedidoA}`,
      { notes: 'cambio desde soporte' },
      filaDelPedido,
    ),
    escritura(
      'post',
      '/cash-movements',
      () => '/cash-movements',
      { type: 'in', amount: 100, concept: 'Prueba de soporte' },
      () => ds().query(`SELECT count(*)::int AS n FROM cash_movement`),
    ),
    escritura(
      'delete',
      '/customers/{id}',
      (c) => `/customers/${c.clienteA.userId}`,
      undefined,
      (c) =>
        ds().query(
          `SELECT "deletedAt", blocked FROM "user" WHERE user_id = $1`,
          [c.clienteA.userId],
        ),
    ),
    endpoint<Ctx>('post', '/orders/quote', '/orders/quote')(
      'con sesión: cotizar (marcado sólo lectura) anda',
      'super',
      200,
      {
        antes: async () => {
          if (!ctx.supers.lector?.sesion) await sesionActiva('lector');
        },
        cabeceras: () => enSesion('lector'),
        body: (c) => ({
          paymentMethod: 'cash',
          customerId: c.clienteA.userId,
          addressId: c.dirCentro,
          items: [{ gasCylinderId: c.garrafaA, quantity: 2, unitPrice: 1 }],
        }),
        verificar: (b) => {
          expect(b).toMatchObject({ subtotal: 2000, zoneSurcharge: 200 });
        },
      },
    ),
    endpoint<Ctx>(
      'post',
      '/v2/purchase-orders/preview-total',
      '/v2/purchase-orders/preview-total',
    )('con sesión: total de compra (sólo lectura) anda', 'super', 200, {
      antes: async () => {
        if (!ctx.supers.lector?.sesion) await sesionActiva('lector');
      },
      cabeceras: () => enSesion('lector'),
      body: { items: [{ quantity: 2, unitCost: 10.5 }] },
    }),
    endpoint<Ctx>(
      'post',
      '/v2/cash-sessions/{id}/close-preview',
      (c) => `/v2/cash-sessions/${c.inexistente}/close-preview`,
    )(
      'con sesión: vista previa del cierre pasa el guard (404 de la caja)',
      'super',
      404,
      {
        antes: async () => {
          if (!ctx.supers.lector?.sesion) await sesionActiva('lector');
        },
        cabeceras: () => enSesion('lector'),
        body: { countedAmount: 0 },
      },
    ),
  ]);

  // ======================================== Segunda capa: la base
  const nombreDeA = (c: Ctx) =>
    ds().query(`SELECT name FROM distributor WHERE distributor_id = $1`, [
      c.distA.id,
    ]);
  correrMatriz('Sólo lectura en la base (un GET que escribe)', ver, [
    ...(['escribe-suelto', 'escribe-en-transaccion'] as const).map((r) =>
      endpoint<Ctx>(
        'get',
        `/v2/prueba-soporte/${r}`,
        `/v2/prueba-soporte/${r}`,
      )('con sesión: la base lo frena (403) y no cambia nada', 'super', 403, {
        antes: async (c) => {
          if (!c.supers.lector?.sesion) await sesionActiva('lector');
          c.p.nombreAntes = (
            (await nombreDeA(c)) as Array<{ name: string }>
          )[0].name;
        },
        cabeceras: () => enSesion('lector'),
        code: 'SUPPORT_READ_ONLY',
        verificar: async (_b, c) => {
          expect(
            ((await nombreDeA(c)) as Array<{ name: string }>)[0].name,
          ).toBe(c.p.nombreAntes);
        },
      }),
    ),
    endpoint<Ctx>(
      'get',
      '/v2/prueba-soporte/escribe-suelto',
      '/v2/prueba-soporte/escribe-suelto',
    )(
      'el admin justo después, por el mismo pool, sí escribe (no se filtra el modo)',
      'adminA',
      200,
      {
        antes: async (c) => {
          if (!c.supers.lector?.sesion) await sesionActiva('lector');
          // Intercaladas: soporte (rechazada) y admin, varias veces.
          for (let i = 0; i < 5; i++) {
            await pedir(
              'get',
              '/v2/prueba-soporte/escribe-suelto',
              enSesion('lector'),
              403,
            );
          }
          c.p.nombreAntes = (
            (await nombreDeA(c)) as Array<{ name: string }>
          )[0].name;
        },
        verificar: async (_b, c) => {
          expect(
            ((await nombreDeA(c)) as Array<{ name: string }>)[0].name,
          ).toBe(`${c.p.nombreAntes}!`);
        },
      },
    ),
  ]);

  // =========================== Versión de plataforma de los «ambos»
  const sinFilasDeEmpresa = (clave: string, campo: string) => (b: unknown) =>
    expect(valoresDe(filasDe(b, clave), campo)).toEqual(
      filasDe(b, clave).length ? [null] : [],
    );
  correrMatriz('Lo de las dos versiones, sin sesión: plataforma', ver, [
    endpoint<Ctx>('get', '/users', '/users?limit=100')(
      'super admin sin sesión: sólo cuentas del panel',
      'super',
      200,
      {
        cabeceras: (c) => ({ 'X-Distributor': c.distA.slug }),
        verificar: (b) =>
          // Hay super admins y admins de empresa en el escenario: sólo eso.
          expect(tiposDeRol(b)).toEqual(['admin', 'super_admin']),
      },
    ),
    endpoint<Ctx>('get', '/users', '/users?limit=100')(
      'super admin con sesión: los de esa empresa (con sus clientes)',
      'super',
      200,
      {
        antes: async () => {
          if (!ctx.supers.lector?.sesion) await sesionActiva('lector');
        },
        cabeceras: () => enSesion('lector'),
        verificar: (b, c) => {
          const ids = valoresDe(filasDe(b, 'users'), 'user_id');
          expect({
            clienteA: ids.includes(c.clienteA.userId),
            clienteB: ids.includes(c.clienteB.userId),
          }).toEqual({ clienteA: true, clienteB: false });
        },
      },
    ),
    endpoint<Ctx>('get', '/audit', '/audit?limit=100')(
      'super admin sin sesión: sólo asientos sin empresa',
      'super',
      200,
      {
        antes: async (c) => {
          // Una escritura de la empresa A, que deja un asiento con su distribuidora.
          await pedir(
            'put',
            '/v2/support-access/policy',
            c.actores.adminA,
            200,
            {
              emergencyAllowed: true,
            },
          );
        },
        verificar: sinFilasDeEmpresa('items', 'distributorId'),
      },
    ),
    endpoint<Ctx>('get', '/v2/audit/entries', '/v2/audit/entries?limit=100')(
      'super admin sin sesión: sólo auditoría sin empresa',
      'super',
      200,
      { verificar: sinFilasDeEmpresa('data', 'distributorId') },
    ),
    endpoint<Ctx>('get', '/v2/admin-notifications', '/v2/admin-notifications')(
      'super admin sin sesión: la bandeja de plataforma (sin avisos de empresas)',
      'super',
      200,
      {
        verificar: (b) => {
          expect((b as { items: unknown[] }).items).toEqual([]);
        },
      },
    ),
    endpoint<Ctx>('get', '/v2/admin-notifications', '/v2/admin-notifications')(
      'admin de empresa: su bandeja como siempre (ningún aviso de otra empresa)',
      'adminA',
      200,
      {
        verificar: async (b, c) =>
          expect(
            enlacesA(
              b,
              await ds().query(
                `SELECT support_session_id AS id FROM support_session WHERE distributor_id = $1`,
                [c.distB.id],
              ),
            ),
          ).toEqual([]),
      },
    ),
    endpoint<Ctx>(
      'get',
      '/v2/process-runs/summary',
      '/v2/process-runs/summary',
    )('super admin sin sesión: el monitoreo de plataforma', 'super', 200),
    endpoint<Ctx>('get', '/distributor', '/distributor')(
      'super admin sin sesión: las empresas (plataforma)',
      'super',
      200,
    ),
    endpoint<Ctx>('get', '/user-address', '/user-address')(
      'super admin sin sesión: el listado global de direcciones ya no',
      'super',
      403,
      { code: 'SUPPORT_SESSION_REQUIRED' },
    ),
  ]);

  // ======================= La cuenta propia y las direcciones (hallazgos del panel)
  const porCorreo = (quien: (c: Ctx) => string) =>
    endpoint<Ctx>(
      'get',
      '/users/email/{email}',
      (c) => `/users/email/${quien(c)}`,
    );
  correrMatriz('GET /users/email/{email} y GET /user-address', ver, [
    porCorreo((c) => c.superAdmin.email)(
      'super admin sin sesión: su propia cuenta (login del panel)',
      'super',
      200,
      {
        verificar: (b, c) =>
          expect(b).toMatchObject({ user_id: c.superAdmin.userId }),
      },
    ),
    porCorreo((c) => c.adminA.email)(
      'super admin sin sesión: una cuenta del panel',
      'super',
      200,
    ),
    porCorreo((c) => c.clienteA.email)(
      'super admin sin sesión: un cliente por correo exacto, sin sus direcciones (D7)',
      'super',
      200,
      {
        verificar: (b, c) =>
          expect(b).toMatchObject({
            user_id: c.clienteA.userId,
            addresses: [],
          }),
      },
    ),
    porCorreo((c) => c.clienteA.email)(
      'super admin en modo soporte sobre A: un cliente de A',
      'soporteA',
      200,
    ),
    porCorreo((c) => c.clienteB.email)(
      'super admin en modo soporte sobre A: un cliente de B no',
      'soporteA',
      404,
    ),
    porCorreo((c) => c.adminA.email)('admin: su propia cuenta', 'adminA', 200),
    endpoint<Ctx>('get', '/user-address', '/user-address?limit=100')(
      'super admin sin sesión de soporte',
      'super',
      403,
      { code: 'SUPPORT_SESSION_REQUIRED' },
    ),
    endpoint<Ctx>('get', '/user-address', '/user-address?limit=100')(
      'super admin en modo soporte sobre A: sólo las direcciones de A',
      'soporteA',
      200,
      {
        verificar: (b, c) => {
          const ids = valoresDe(filasDe(b, 'addresses'), 'address_id');
          expect({
            deA: ids.includes(c.dirCentro),
            deB: ids.includes(c.dirB),
          }).toEqual({ deA: true, deB: false });
        },
      },
    ),
  ]);

  // ====================================== Lado de la empresa: decidir
  const aprobar = endpoint<Ctx>(
    'post',
    '/v2/support-access/{id}/approve',
    (c) => `/v2/support-access/${c.p.aDecidir}/approve`,
  );
  const prepararPendiente = async (c: Ctx) => {
    c.p.aDecidir = await pedirAcceso(
      `decidir-${randomUUID().slice(0, 4)}`,
      c.distA.id,
      {
        scope: ['personal_data', 'files'],
      },
    );
  };
  correrMatriz('POST /v2/support-access/{id}/approve', ver, [
    aprobar('sin token', undefined, 401, { antes: prepararPendiente }),
    aprobar('super admin (no se aprueba a sí mismo)', 'super', 403, {
      antes: prepararPendiente,
    }),
    aprobar('admin de otra empresa', 'adminB', 404, {
      antes: prepararPendiente,
    }),
    aprobar('admin sin soporte.gestionar', 'adminA2', 403, {
      antes: prepararPendiente,
      code: 'PERMISSION_DENIED',
    }),
    aprobar('id mal formado', 'adminA', 400, {
      ruta: '/v2/support-access/xx/approve',
    }),
    aprobar('más minutos que lo pedido', 'adminA', 400, {
      antes: prepararPendiente,
      body: { minutes: 120 },
      code: 'SUPPORT_APPROVAL_EXCEEDS_REQUEST',
    }),
    aprobar('más alcance que lo pedido', 'adminA', 400, {
      antes: prepararPendiente,
      body: { scope: ['exports'] },
      code: 'SUPPORT_APPROVAL_EXCEEDS_REQUEST',
    }),
    aprobar('acortando y achicando', 'adminA', 200, {
      antes: prepararPendiente,
      body: { minutes: 15, scope: ['files'], note: 'Sólo un rato' },
      verificar: (b, c) => {
        const s = b as {
          status: string;
          scope: string[];
          startedAt: string;
          expiresAt: string;
          decidedBy: { userId: string };
        };
        expect(s).toMatchObject({
          status: 'active',
          scope: ['files'],
          decidedBy: { userId: c.adminA.userId },
        });
        expect(Date.parse(s.expiresAt) - Date.parse(s.startedAt)).toBe(
          15 * 60_000,
        );
      },
    }),
    aprobar('una ya aprobada', 'adminA', 409, {
      antes: async (c) => {
        await prepararPendiente(c);
        await pedir(
          'post',
          `/v2/support-access/${c.p.aDecidir}/approve`,
          c.actores.adminA,
          200,
        );
      },
      code: 'SUPPORT_SESSION_NOT_PENDING',
    }),
    aprobar('una caducada (plazo forzado en la base)', 'adminA', 409, {
      antes: async (c) => {
        await prepararPendiente(c);
        await ds().query(
          `UPDATE support_session SET request_expires_at = now() - interval '1 minute'
            WHERE support_session_id = $1`,
          [c.p.aDecidir],
        );
      },
      code: 'SUPPORT_REQUEST_EXPIRED',
    }),
  ]);

  const rechazar = endpoint<Ctx>(
    'post',
    '/v2/support-access/{id}/reject',
    (c) => `/v2/support-access/${c.p.aDecidir}/reject`,
  );
  correrMatriz('POST /v2/support-access/{id}/reject', ver, [
    rechazar('admin de otra empresa', 'adminB', 404, {
      antes: prepararPendiente,
    }),
    rechazar('admin sin soporte.gestionar', 'adminA2', 403, {
      antes: prepararPendiente,
    }),
    rechazar('rechaza con nota', 'adminA', 200, {
      antes: prepararPendiente,
      body: { note: 'Hoy no' },
      verificar: (b) => {
        expect(b).toMatchObject({ status: 'rejected', decisionNote: 'Hoy no' });
      },
    }),
    rechazar('una ya rechazada', 'adminA', 409, {
      antes: async (c) => {
        await prepararPendiente(c);
        await pedir(
          'post',
          `/v2/support-access/${c.p.aDecidir}/reject`,
          c.actores.adminA,
          200,
        );
      },
      code: 'SUPPORT_SESSION_NOT_PENDING',
    }),
  ]);

  const revocar = endpoint<Ctx>(
    'post',
    '/v2/support-access/{id}/revoke',
    (c) => `/v2/support-access/${c.p.aRevocar}/revoke`,
  );
  const prepararActiva = async (c: Ctx) => {
    c.p.aRevocar = await sesionActiva(`rev-${randomUUID().slice(0, 4)}`);
  };
  correrMatriz('POST /v2/support-access/{id}/revoke', ver, [
    revocar('admin de otra empresa', 'adminB', 404, { antes: prepararActiva }),
    revocar('revoca una activa', 'adminA', 200, {
      antes: prepararActiva,
      verificar: (b, c) => {
        expect(b).toMatchObject({
          status: 'revoked',
          endReason: 'revoked_by_company',
          endedBy: { userId: c.adminA.userId },
        });
      },
    }),
    revocar('una pendiente', 'adminA', 409, {
      antes: async (c) => {
        await prepararPendiente(c);
        c.p.aRevocar = c.p.aDecidir;
      },
      code: 'SUPPORT_SESSION_ALREADY_ENDED',
    }),
  ]);

  // ================================ Lado de la empresa: consultar
  correrMatriz('GET /v2/support-access', ver, [
    endpoint<Ctx>('get', '/v2/support-access', '/v2/support-access')(
      'admin: sólo las de su empresa, pendientes primero',
      'adminA',
      200,
      {
        antes: prepararPendiente,
        verificar: (b, c) =>
          expect({
            empresas: valoresDe(filasDe(b, 'items'), 'distributorId'),
            pendientesPrimero: pendientesPrimero(b),
          }).toEqual({ empresas: [c.distA.id], pendientesPrimero: true }),
      },
    ),
    endpoint<Ctx>('get', '/v2/support-access', '/v2/support-access')(
      'admin con sólo soporte.ver también ve',
      'adminA2',
      200,
    ),
    endpoint<Ctx>('get', '/v2/support-access', '/v2/support-access')(
      'super admin: no es suyo',
      'super',
      403,
    ),
    endpoint<Ctx>(
      'get',
      '/v2/support-access',
      '/v2/support-access?status=raro',
    )('estado desconocido', 'adminA', 400),
    endpoint<Ctx>(
      'get',
      '/v2/support-access/{id}',
      (c) => `/v2/support-access/${c.p.aDecidir}`,
    )('una de otra empresa', 'adminB', 404, { antes: prepararPendiente }),
    endpoint<Ctx>(
      'get',
      '/v2/support-access/{id}/accesses',
      (c) => `/v2/support-access/${c.p.aDecidir}/accesses`,
    )('lo que miró (vacío hasta la E2)', 'adminA', 200, {
      antes: prepararPendiente,
      verificar: (b) => {
        expect(b).toEqual({ items: [], total: 0 });
      },
    }),
    endpoint<Ctx>(
      'put',
      '/v2/support-access/policy',
      '/v2/support-access/policy',
    )('admin sin soporte.gestionar no cambia la política', 'adminA2', 403, {
      body: { autoApprove: true },
    }),
    endpoint<Ctx>(
      'put',
      '/v2/support-access/policy',
      '/v2/support-access/policy',
    )('valor que no es booleano', 'adminA', 400, {
      body: { autoApprove: 'si' },
    }),
    endpoint<Ctx>(
      'get',
      '/v2/support-access/policy',
      '/v2/support-access/policy',
    )('por defecto: emergencia sí, autoaprobación no', 'adminA', 200, {
      verificar: (b) => {
        expect(b).toEqual({ emergencyAllowed: true, autoApprove: false });
      },
    }),
  ]);

  // ====================================== Lado de la plataforma: salir
  const salir = endpoint<Ctx>(
    'delete',
    '/v2/support-sessions/{id}',
    (c) => `/v2/support-sessions/${c.p.aSalir}`,
  );
  correrMatriz('DELETE /v2/support-sessions/{id} y GET current', ver, [
    endpoint<Ctx>(
      'get',
      '/v2/support-sessions/current',
      '/v2/support-sessions/current',
    )('sin sesión: null', 'super', 200, {
      verificar: (b) => expect(b).toEqual({ session: null }),
    }),
    endpoint<Ctx>(
      'get',
      '/v2/support-sessions/current',
      '/v2/support-sessions/current',
    )(
      'con una activa: la activa, aunque mande el encabezado de una terminada',
      'super',
      200,
      {
        antes: async (c) => {
          await sesionActiva('actual');
          c.p.actual = c.supers.actual.sesion as string;
        },
        cabeceras: (c) => ({
          ...c.actores.actual,
          [SUPPORT]: c.inexistente,
        }),
        verificar: (b, c) => {
          expect(b).toMatchObject({
            session: { id: c.p.actual, status: 'active' },
          });
        },
      },
    ),
    salir('sale de la propia activa', 'super', 204, {
      antes: async (c) => {
        c.p.aSalir = await sesionActiva(`sale-${randomUUID().slice(0, 4)}`);
        c.p.quienSale = Object.keys(c.supers).find(
          (k) => c.supers[k].sesion === c.p.aSalir,
        ) as string;
      },
      cabeceras: (c) => c.actores[c.p.quienSale],
      verificar: async (_b, c) => {
        expect(await estadoDe(c.p.aSalir)).toMatchObject({
          status: 'ended',
          end_reason: 'exit',
        });
        // Y desde ya no puede mirar.
        await pedir('get', '/orders', enSesion(c.p.quienSale), 403);
      },
    }),
    salir('retira el propio pedido pendiente', 'super', 204, {
      antes: async (c) => {
        const n = `retira-${randomUUID().slice(0, 4)}`;
        c.p.aSalir = await pedirAcceso(n, c.distA.id);
        c.p.quienSale = n;
      },
      cabeceras: (c) => c.actores[c.p.quienSale],
      verificar: async (_b, c) => {
        expect(await estadoDe(c.p.aSalir)).toMatchObject({
          status: 'cancelled',
        });
      },
    }),
    salir('otro super admin sin motivo', 'super', 400, {
      antes: async (c) => {
        c.p.aSalir = await sesionActiva(`otro-${randomUUID().slice(0, 4)}`);
      },
    }),
    salir(
      'otro super admin con motivo: revocada por la plataforma',
      'super',
      204,
      {
        antes: async (c) => {
          c.p.aSalir = await sesionActiva(`otro-${randomUUID().slice(0, 4)}`);
        },
        body: {
          reason: 'Se abrió por error, la corta otra persona del soporte',
        },
        verificar: async (_b, c) => {
          expect(await estadoDe(c.p.aSalir)).toMatchObject({
            status: 'revoked',
            end_reason: 'revoked_by_platform',
            ended_by: c.superAdmin.userId,
          });
        },
      },
    ),
    salir('ya terminada', 'super', 409, {
      antes: async (c) => {
        c.p.aSalir = await sesionActiva(`fin-${randomUUID().slice(0, 4)}`);
        await pedir(
          'post',
          `/v2/support-access/${c.p.aSalir}/revoke`,
          c.actores.adminA,
          200,
        );
      },
      body: { reason: 'Ya estaba revocada por la empresa, igual la corto' },
      code: 'SUPPORT_SESSION_ALREADY_ENDED',
    }),
    salir('inexistente', 'super', 404, {
      antes: (c) => {
        c.p.aSalir = c.inexistente;
        return Promise.resolve();
      },
    }),
    salir('admin de empresa', 'adminA', 403, {
      antes: (c) => {
        c.p.aSalir = c.inexistente;
        return Promise.resolve();
      },
    }),
  ]);

  // =========================================== Historial y ficha
  correrMatriz('GET /v2/support-sessions', ver, [
    endpoint<Ctx>(
      'get',
      '/v2/support-sessions',
      '/v2/support-sessions?status=revoked',
    )('filtra por estado', 'super', 200, {
      verificar: (b) => {
        const items = (b as { items: Array<{ status: string }> }).items;
        expect(items.every((i) => i.status === 'revoked')).toBe(true);
      },
    }),
    endpoint<Ctx>(
      'get',
      '/v2/support-sessions',
      '/v2/support-sessions?from=2026-12-01T00:00:00Z&to=2026-11-01T00:00:00Z',
    )('desde posterior a hasta', 'super', 400),
    endpoint<Ctx>(
      'get',
      '/v2/support-sessions',
      '/v2/support-sessions?limit=0',
    )('paginación fuera de rango', 'super', 400),
    endpoint<Ctx>('get', '/v2/support-sessions', '/v2/support-sessions')(
      'admin de empresa',
      'adminA',
      403,
    ),
    endpoint<Ctx>(
      'get',
      '/v2/support-sessions/{id}',
      (c) => `/v2/support-sessions/${c.inexistente}`,
    )('inexistente', 'super', 404),
    endpoint<Ctx>(
      'get',
      '/v2/support-sessions/{id}/accesses',
      (c) => `/v2/support-sessions/${c.inexistente}/accesses`,
    )('inexistente', 'super', 404),
  ]);

  // ===================== Archivos, exportes y URL firmadas (§4.6–4.7)
  describe('alcances files y exports', () => {
    const fotoDelCliente = async () => {
      await ds().query(`UPDATE "user" SET photo_key = $2 WHERE user_id = $1`, [
        ctx.clienteA.userId,
        `users/${ctx.clienteA.userId}/foto.png`,
      ]);
    };
    const fotoEnListado = (b: Record<string, unknown>): unknown =>
      filasDe(b, 'users').find((u) => u.user_id === ctx.clienteA.userId)
        ?.photoUrl;

    it('exportes: sin el alcance exports 403 SUPPORT_SCOPE_REQUIRED; con él, sale', async () => {
      const sin = await conSesionDeSoporte(env.app, ctx.distA.id, 'exp-sin', [
        'personal_data',
        'files',
      ]);
      const con = await conSesionDeSoporte(env.app, ctx.distA.id, 'exp-con', [
        'exports',
      ]);
      const r1 = await pedir('get', '/v2/exports/pedidos', sin.cabeceras, 403);
      await pedir('get', '/v2/exports/pedidos', con.cabeceras, 200);
      expect(r1).toMatchObject({ code: 'SUPPORT_SCOPE_REQUIRED' });
    });

    it('PDFs (remito y hoja de ruta): sin files 403; con files pasa el guard', async () => {
      const sin = await conSesionDeSoporte(env.app, ctx.distA.id, 'pdf-sin');
      const con = await conSesionDeSoporte(env.app, ctx.distA.id, 'pdf-con', [
        'files',
      ]);
      const remito = `/v2/orders/${ctx.pedidoA}/remito.pdf`;
      const hoja = `/v2/route-sheets/${ctx.inexistente}/pdf`;
      const r = [
        await pedir('get', remito, sin.cabeceras, 403),
        await pedir('get', hoja, sin.cabeceras, 403),
      ];
      await pedir('get', remito, con.cabeceras, 200);
      await pedir('get', hoja, con.cabeceras, 404);
      expect(r).toMatchObject([
        { code: 'SUPPORT_SCOPE_REQUIRED' },
        { code: 'SUPPORT_SCOPE_REQUIRED' },
      ]);
    });

    it('URL firmadas: sin files la descarga es 403 y la foto embebida null; con files se firma y no dura más que la sesión', async () => {
      await fotoDelCliente();
      const sin = await conSesionDeSoporte(env.app, ctx.distA.id, 'url-sin');
      const con = await conSesionDeSoporte(env.app, ctx.distA.id, 'url-con', [
        'files',
      ]);
      const ruta = `/users/${ctx.clienteA.userId}/photo?modo=url`;
      const descargaSin = await pedir('get', ruta, sin.cabeceras, 403);
      const listadoSin = await pedir(
        'get',
        '/users?limit=100',
        sin.cabeceras,
        200,
      );
      const fotosSin = await pedir(
        'post',
        '/v2/people/photos',
        sin.cabeceras,
        200,
        {
          userIds: [ctx.clienteA.userId],
        },
      );
      const descargaCon = await pedir('get', ruta, con.cabeceras, 200);
      const fueraDeSoporte = await pedir('get', ruta, ctx.actores.adminA, 200);
      const listadoCon = await pedir(
        'get',
        '/users?limit=100',
        con.cabeceras,
        200,
      );
      const [{ expires_at: fin }] = await ds().query<
        Array<{ expires_at: Date }>
      >(
        `SELECT expires_at FROM support_session WHERE support_session_id = $1`,
        [con.sessionId],
      );
      const vence = Date.parse(String(descargaCon.expiresAt));
      expect({
        descargaSin: descargaSin.code,
        fotoEnListadoSin: fotoEnListado(listadoSin) ?? null,
        fotosSin: (fotosSin.users as Record<string, unknown>)[
          ctx.clienteA.userId
        ],
        firmada: typeof descargaCon.url === 'string',
        fotoEnListadoCon: typeof fotoEnListado(listadoCon) === 'string',
        noPasaLaSesion: vence <= new Date(fin).getTime(),
        noPasaElTope: vence <= Date.now() + 60_000 + 1000,
        amzExpires: amzExpires(descargaCon.url),
        amzExpiresDelListado: amzExpires(fotoEnListado(listadoCon)),
        amzExpiresFueraDeSoporte: amzExpires(fueraDeSoporte.url),
      }).toEqual({
        descargaSin: 'SUPPORT_SCOPE_REQUIRED',
        fotoEnListadoSin: null,
        fotosSin: null,
        firmada: true,
        fotoEnListadoCon: true,
        noPasaLaSesion: true,
        noPasaElTope: true,
        amzExpires: 60,
        amzExpiresDelListado: 60,
        amzExpiresFueraDeSoporte: 300,
      });
    });

    it('con la sesión a punto de vencer, la URL vence con ella', async () => {
      await fotoDelCliente();
      const s = await conSesionDeSoporte(env.app, ctx.distA.id, 'url-fin', [
        'files',
      ]);
      await ds().query(
        `UPDATE support_session SET expires_at = now() + interval '45 seconds'
          WHERE support_session_id = $1`,
        [s.sessionId],
      );
      const r = await pedir(
        'get',
        `/users/${ctx.clienteA.userId}/photo?modo=url`,
        s.cabeceras,
        200,
      );
      const segundos = (Date.parse(String(r.expiresAt)) - Date.now()) / 1000;
      expect(segundos).toBeLessThanOrEqual(46);
      expect(amzExpires(r.url)).toBeLessThanOrEqual(45);
    });
  });

  // ============== Los POST de sólo lectura no escriben (también fuera de soporte)
  it('los POST marcados @SoloLectura no escriben nada (auditoría y registro sin filas nuevas)', async () => {
    await pedir('get', '/orders', ctx.actores.adminA, 200);
    await esperar(300);
    const contar = async () =>
      (
        await ds().query<Array<{ n: string }>>(
          `SELECT (SELECT count(*) FROM audit) + (SELECT count(*) FROM audit_log)
                + (SELECT count(*) FROM audit_detail) AS n`,
        )
      )[0].n;
    const antes = await contar();
    await pedir('post', '/v2/people/photos', ctx.actores.adminA, 200, {
      userIds: [ctx.clienteA.userId, ctx.adminA.userId],
    });
    await pedir('post', '/orders/quote', ctx.actores.adminA, 200, {
      paymentMethod: 'cash',
      customerId: ctx.clienteA.userId,
      addressId: ctx.dirCentro,
      items: [{ gasCylinderId: ctx.garrafaA, quantity: 2, unitPrice: 1 }],
    });
    await pedir(
      'post',
      '/v2/purchase-orders/preview-total',
      ctx.actores.adminA,
      200,
      {
        items: [{ quantity: 2, unitCost: 10.5 }],
      },
    );
    await pedir(
      'post',
      `/v2/cash-sessions/${ctx.inexistente}/close-preview`,
      ctx.actores.adminA,
      404,
      { countedAmount: 0 },
    );
    await pedir(
      'post',
      `/v2/driver-settlements/${ctx.inexistente}/preview`,
      ctx.actores.adminA,
      404,
      { declaredCash: 0 },
    );
    await esperar(300);
    expect(await contar()).toBe(antes);
  });

  // ============================================ Vencimiento (cron)
  it('el cron pasa a vencidas las activas pasadas y a caducados los pedidos viejos', async () => {
    const activa = await sesionActiva(`cron-a-${randomUUID().slice(0, 4)}`);
    const pendiente = await pedirAcceso(
      `cron-p-${randomUUID().slice(0, 4)}`,
      ctx.distA.id,
    );
    await ds().query(
      `UPDATE support_session SET started_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'
        WHERE support_session_id = $1`,
      [activa],
    );
    await ds().query(
      `UPDATE support_session SET request_expires_at = now() - interval '1 minute'
        WHERE support_session_id = $1`,
      [pendiente],
    );
    const r = await env.app.get(SupportSessionExpiryCron).barrer();
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(r.expiredRequests).toBeGreaterThanOrEqual(1);
    expect(await estadoDe(activa)).toMatchObject({
      status: 'expired',
      end_reason: 'expired',
    });
    expect(await estadoDe(pendiente)).toMatchObject({
      status: 'expired_request',
    });
  });

  it('el ciclo de la sesión queda en la auditoría por el trigger', async () => {
    const id = await sesionActiva(`aud-${randomUUID().slice(0, 4)}`);
    const filas = await ds().query<
      Array<{ entity: string; field: string; new_value: string }>
    >(
      `SELECT a.entity, d.field, d.new_value
         FROM audit a JOIN audit_detail d ON d.audit_id = a.audit_id
        WHERE a.entity = 'SupportSession' AND a.record_id = $1`,
      [id],
    );
    expect(filas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'status', new_value: 'pending' }),
        expect.objectContaining({ field: 'status', new_value: 'active' }),
      ]),
    );
  });

  it('el registro de lecturas es de sólo agregar', async () => {
    const id = await sesionActiva(`acc-${randomUUID().slice(0, 4)}`);
    await ds().query(
      `INSERT INTO support_access (support_session_id, distributor_id, user_id, http_method, path, status_code)
       VALUES ($1, $2, $3, 'GET', '/orders', 200)`,
      [id, ctx.distA.id, ctx.superAdmin.userId],
    );
    await expect(
      ds().query(`UPDATE support_access SET status_code = 500`),
    ).rejects.toThrow(/sólo escritura/);
    await expect(ds().query(`DELETE FROM support_access`)).rejects.toThrow(
      /sólo escritura/,
    );
  });

  it('la regresión de los demás roles: admin, cliente y chofer como siempre', async () => {
    const deA = await pedir('get', '/orders', ctx.actores.adminA, 200);
    await pedir('get', `/orders/${ctx.pedidoB}`, ctx.actores.adminA, 404);
    await pedir(
      'get',
      `/orders/customer/${ctx.clienteA.userId}`,
      ctx.actores.clienteA,
      200,
    );
    await pedir('get', '/v2/admin-notifications', ctx.actores.adminA, 200);
    // El chofer no entra al panel.
    await pedir('get', '/orders', ctx.actores.chofer, 403);
    // Y un admin no puede usar el modo soporte.
    await pedir('post', '/v2/support-sessions', ctx.actores.adminA, 403, {
      distributorId: ctx.distA.id,
      reason: MOTIVO,
    });
    expect(
      (deA.orders as Array<{ distributor_id: string }>).every(
        (o) => o.distributor_id === ctx.distA.id,
      ),
    ).toBe(true);
  });
});
