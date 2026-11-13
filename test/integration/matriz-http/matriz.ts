/**
 * Matriz HTTP: cada endpoint probado contra todos sus códigos de respuesta.
 *
 * Cada tanda arma una tabla de casos (método, ruta, actor, cuerpo, código
 * esperado) y llama a `correrMatriz`, que genera un `it` por caso, pega el
 * request contra la app de `createTestApp` y verifica:
 *  - el código HTTP;
 *  - el `code` estable (en inglés) si el caso lo pide;
 *  - en todo 4xx/5xx, que `message` y `error` estén en castellano y no lleven
 *    nombres internos (campos camelCase/snake_case ni textos de Nest).
 *
 * Si `MATRIZ_SALIDA` apunta a un archivo, cada caso agrega una línea TSV
 * (endpoint, caso, esperado, obtenido, mensaje) para armar la entrega.
 */
import { appendFileSync } from 'fs';
import { STATUS_CODES } from 'http';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Admin } from '../../../src/admin/entities/admin.entity';
import { RoleType } from '../../../src/common/constants/role-type.enum';
import { Customer } from '../../../src/customer/entities/customer.entity';
import { Delivery } from '../../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../../src/distributor/entities/distributor.entity';
import { Role } from '../../../src/role/entities/role.entity';
import { User } from '../../../src/users/entities/user.entity';
import { Redis } from 'ioredis';
import { TestApp, TestEnv, telefonoDePrueba } from '../setup/test-env';

export type Cabeceras = Record<string, string>;
export type Metodo = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Algo fijo o calculado cuando ya existe el escenario (ids, correos). */
export type Perezoso<T, C> = T | ((ctx: C) => T);

export interface Adjunto {
  campo: string;
  contenido: Buffer;
  nombre: string;
  tipo: string;
  /** Campos de texto que viajan en el mismo multipart (`documentType`). */
  campos?: Record<string, string>;
}

/** Lo mínimo que tiene que dar el escenario de una suite. */
export interface ContextoMatriz {
  app: TestApp;
  /** Cabeceras por nombre de actor; un actor ausente es "sin cabeceras". */
  actores: Record<string, Cabeceras>;
  /**
   * Vacía los cupos del throttler (Redis efímero) antes de cada caso, para que
   * los cupos por IP (registro, check-exists) no mezclen un caso con otro. El
   * 429 se prueba aparte, con `agotarCupo`.
   */
  reiniciarCupos?: () => Promise<void>;
}

/**
 * Borra sólo los contadores del throttler (`{...}:hits` y `{...}:blocked`) del
 * Redis efímero: no toca idempotencia, despacho ni los límites de correo.
 */
export async function reiniciarCuposDelThrottler(env: TestEnv): Promise<void> {
  const redis = new Redis({
    host: env.redisContainer.getHost(),
    port: env.redisContainer.getMappedPort(6379),
  });
  try {
    for (const patron of ['{*}:hits', '{*}:blocked']) {
      const claves = await redis.keys(patron);
      if (claves.length > 0) await redis.del(...claves);
    }
  } finally {
    redis.disconnect();
  }
}

export interface Caso<C extends ContextoMatriz> {
  /** `GET /users/{id}`: tal cual figura en Swagger. */
  endpoint: string;
  caso: string;
  metodo: Metodo;
  /** Ruta real (con `/v1` o `/v2` si hace falta). */
  ruta: Perezoso<string, C>;
  /** Nombre de un actor de `ctx.actores`; omitido = anónimo. */
  actor?: string;
  /** Cabeceras que pisan las del actor (o `null` para quitarlas). */
  cabeceras?: Perezoso<Record<string, string | null>, C>;
  body?: Perezoso<object, C>;
  adjunto?: Perezoso<Adjunto, C>;
  esperado: number;
  /** `code` estable que tiene que traer el error. */
  code?: string;
  /** Texto (o patrón) que tiene que estar en `message`. */
  mensaje?: string | RegExp;
  /** `message` idéntico a este texto (para fijar una corrección de redacción). */
  mensajeExacto?: string;
  /** Prepara lo que el caso necesita (así no depende de otros casos). */
  antes?: (ctx: C) => Promise<void>;
  /** Chequeo extra sobre el cuerpo de la respuesta. */
  verificar?: (cuerpo: unknown, ctx: C) => void | Promise<void>;
}

const resolver = <T, C>(valor: Perezoso<T, C> | undefined, ctx: C) =>
  typeof valor === 'function' ? (valor as (c: C) => T)(ctx) : valor;

/** Un nombre del código en un texto: `cashBoxId`, `paid_at`, `campo=false`. */
const IDENTIFICADOR =
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|=\s*(?:true|false)\b/;
/** Palabras que sólo aparecen en los textos en inglés de Nest, Express, multer y el throttler. */
const INGLES =
  /\b(must|should|shall|is|are|was|were|not|cannot|can't|invalid|unauthorized|forbidden|found|bad|request|property|expected|unexpected|internal|server|too|many|large|file|files|field|fields|value|long|missing|valid|exceeded|limit|failed|already|exists?|required|empty|the|and|for|with|from|has|have|been|boundary|malformed|payload|unavailable)\b/i;
/** `ThrottlerException`, `BadRequestException`: nombres de clase. */
const NOMBRE_DE_CLASE = /\b\w+(Exception|Error)\b/;
const NOMBRES_HTTP_EN_INGLES = new Set(
  Object.entries(STATUS_CODES)
    .filter(([c]) => Number(c) >= 400)
    .map(([, n]) => (n as string).toLowerCase()),
);

/** Los `message` de un cuerpo, como lista. */
function mensajesDe(cuerpo: Record<string, unknown>): string[] {
  const m = cuerpo.message;
  if (Array.isArray(m)) return m.map(String);
  return typeof m === 'string' ? [m] : [];
}

/** Un texto que lee la persona: castellano, sin inglés ni nombres del código. */
function verificarTexto(texto: string, estado: number): void {
  const hallazgos = {
    estado,
    texto,
    interno: IDENTIFICADOR.exec(texto)?.[0],
    clase: NOMBRE_DE_CLASE.exec(texto)?.[0],
    ingles: INGLES.exec(texto)?.[0],
    http: NOMBRES_HTTP_EN_INGLES.has(texto.trim().toLowerCase()) || undefined,
  };
  expect(hallazgos).toEqual({
    estado,
    texto,
    interno: undefined,
    clase: undefined,
    ingles: undefined,
    http: undefined,
  });
}

/** Falla si el error no está en castellano o lleva nombres internos. */
export function verificarCastellano(cuerpo: unknown, estado: number): void {
  const c = (cuerpo ?? {}) as Record<string, unknown>;
  const mensajes = mensajesDe(c);
  expect({ estado, mensajes }).not.toEqual({ estado, mensajes: [] });
  for (const m of mensajes) verificarTexto(m, estado);
  // Todo error trae `error`, en castellano.
  expect(typeof c.error).toBe('string');
  verificarTexto(c.error as string, estado);
}

/** El texto que trae una respuesta 2xx (`message`, `response`) también se lee en castellano. */
export function verificarTextoDeExito(cuerpo: unknown, estado: number): void {
  if (typeof cuerpo !== 'object' || cuerpo === null) return;
  const c = cuerpo as Record<string, unknown>;
  for (const clave of ['message', 'response']) {
    const v = c[clave];
    if (typeof v === 'string') verificarTexto(v, estado);
  }
}

/** Pide algo como un actor del escenario (para preparar un caso). */
export async function llamar(
  ctx: ContextoMatriz,
  metodo: Metodo,
  ruta: string,
  actor: string,
  body?: object,
  adjunto?: Adjunto,
): Promise<request.Response> {
  return pedir(
    ctx.app,
    metodo,
    ruta,
    cabecerasDe(ctx.actores[actor], undefined),
    body,
    adjunto,
  );
}

function pedir(
  app: TestApp,
  metodo: Metodo,
  ruta: string,
  cabeceras: Record<string, string>,
  body: unknown,
  adjunto?: Adjunto,
): request.Test {
  const req = request(app.getHttpServer())[metodo](ruta).set(cabeceras);
  if (adjunto) {
    for (const [campo, valor] of Object.entries(adjunto.campos ?? {})) {
      void req.field(campo, valor);
    }
    return req.attach(adjunto.campo, adjunto.contenido, {
      filename: adjunto.nombre,
      contentType: adjunto.tipo,
    });
  }
  // supertest no manda cuerpo si no se le pide: `send` sólo con body definido.
  return body === undefined ? req : req.send(body as object);
}

/** Cabeceras del actor más las que pisa el caso (`null` las quita). */
function cabecerasDe(
  actor: Cabeceras | undefined,
  extra: Record<string, string | null> | undefined,
): Record<string, string> {
  const salida: Record<string, string> = { ...(actor ?? {}) };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === null) delete salida[k];
    else salida[k] = v;
  }
  return salida;
}

/**
 * Cada caso «sin token» (401) tiene su gemelo «token inválido»: el token es de
 * alguien que no existe, y se espera el mismo código.
 */
function conTokenInvalido<C extends ContextoMatriz>(
  casos: ReadonlyArray<Caso<C>>,
): Array<Caso<C>> {
  return casos.flatMap((c) =>
    c.caso === 'sin token'
      ? [
          c,
          {
            ...c,
            caso: 'token inválido',
            cabeceras: (ctx: C) => ({
              ...(resolver(c.cabeceras, ctx) ?? {}),
              Authorization: 'Bearer invalido@splg.local',
            }),
          },
        ]
      : [c],
  );
}

/**
 * Genera la suite: un `it` por caso. `obtener` devuelve el contexto ya armado
 * (se llama dentro de cada test, después del `beforeAll` de la suite).
 */
export function correrMatriz<C extends ContextoMatriz>(
  titulo: string,
  obtener: () => C,
  casos: ReadonlyArray<Caso<C>>,
): void {
  describe(titulo, () => {
    for (const c of conTokenInvalido(casos)) {
      it(`${c.endpoint} · ${c.caso} → ${c.esperado}`, async () => {
        const ctx = obtener();
        await c.antes?.(ctx);
        await ctx.reiniciarCupos?.();
        const ruta = resolver(c.ruta, ctx) as string;
        const cabeceras = cabecerasDe(
          c.actor ? ctx.actores[c.actor] : undefined,
          resolver(c.cabeceras, ctx),
        );
        const res = await pedir(
          ctx.app,
          c.metodo,
          ruta,
          cabeceras,
          resolver(c.body, ctx),
          resolver(c.adjunto, ctx),
        );
        const cuerpo: unknown = res.body;
        registrar(c, res.status, cuerpo);
        expect({ caso: c.caso, estado: res.status, cuerpo }).toMatchObject({
          estado: c.esperado,
        });
        const obj = (cuerpo ?? {}) as Record<string, unknown>;
        if (res.status < 400) verificarTextoDeExito(cuerpo, res.status);
        if (res.status >= 400) {
          verificarCastellano(cuerpo, res.status);
          if (c.mensajeExacto !== undefined) {
            expect(mensajesDe(obj).join(' | ')).toBe(c.mensajeExacto);
          }
          if (c.code) expect(obj.code).toBe(c.code);
          if (c.mensaje) {
            const texto = mensajesDe(obj).join(' | ');
            if (typeof c.mensaje === 'string') {
              expect(texto).toContain(c.mensaje);
            } else {
              expect(texto).toMatch(c.mensaje);
            }
          }
        }
        await c.verificar?.(cuerpo, ctx);
      });
    }
  });
}

/**
 * Atajo para armar la tabla de un endpoint: fija método, ruta de Swagger
 * (`/users/{id}`, es la etiqueta) y la ruta real; cada fila sólo dice el caso,
 * el actor y el código esperado.
 *
 *   const uno = endpoint<Ctx>('get', '/users/{id}', (c) => `/users/${c.a.id}`);
 *   uno('sin token', undefined, 401);
 *   uno('id mal formado', 'adminA', 400, { ruta: '/users/xx' });
 */
export function endpoint<C extends ContextoMatriz>(
  metodo: Metodo,
  swagger: string,
  ruta: Perezoso<string, C>,
): (
  caso: string,
  actor: string | undefined,
  esperado: number,
  extra?: Partial<Caso<C>>,
) => Caso<C> {
  return (caso, actor, esperado, extra = {}) => ({
    endpoint: `${metodo.toUpperCase()} ${swagger}`,
    caso,
    metodo,
    ruta,
    actor,
    esperado,
    ...extra,
  });
}

function registrar(
  c: { endpoint: string; caso: string; esperado: number },
  estado: number,
  cuerpo: unknown,
) {
  const salida = process.env.MATRIZ_SALIDA;
  if (!salida) return;
  const obj = (cuerpo ?? {}) as Record<string, unknown>;
  const texto = mensajesDe(obj)
    .join(' | ')
    .replace(/[\t\n]/g, ' ');
  appendFileSync(
    salida,
    [c.endpoint, c.caso, c.esperado, estado, texto].join('\t') + '\n',
  );
}

// ---------------------------------------------------------------------------
// Escenario común: dos distribuidoras con su gente, un super admin y un cliente.
// ---------------------------------------------------------------------------

export interface Persona {
  userId: string;
  email: string;
  phone: string;
}

export interface Escenario extends ContextoMatriz {
  distA: { id: string; slug: string };
  distB: { id: string; slug: string };
  adminA: Persona & { adminId: string };
  adminA2: Persona & { adminId: string };
  adminB: Persona & { adminId: string };
  superAdmin: Persona & { adminId: string };
  choferA: Persona & { deliveryId: string };
  clienteA: Persona;
  clienteB: Persona;
  /** Un uuid bien formado que no existe. */
  inexistente: string;
}

const UUID_RE = /^[0-9a-f-]{36}$/;
export const esUuid = (v: unknown): boolean =>
  typeof v === 'string' && UUID_RE.test(v);

/** Cabeceras de un usuario de prueba: el token es el correo. */
export function cabecerasDe_(
  email: string,
  fuente: 'panel-app' | 'customer-app' | 'driver-app',
  distribuidora?: string,
): Cabeceras {
  return {
    Authorization: `Bearer ${email}`,
    'X-Client-Source': fuente,
    ...(distribuidora ? { 'X-Distributor': distribuidora } : {}),
  };
}

export async function sembrarEscenario(app: TestApp): Promise<Escenario> {
  const ds = app.get(DataSource);
  const sufijo = randomUUID().slice(0, 6);
  const roles = new Map<string, string>();
  for (const type of Object.values(RoleType)) {
    const r =
      (await ds.getRepository(Role).findOne({ where: { type } })) ??
      (await ds.getRepository(Role).save({ type } as Partial<Role>));
    roles.set(type, r.roleId);
  }
  const dist = async (n: string) => {
    const d = (await ds.getRepository(Distributor).save({
      name: `Dist ${n} ${sufijo}`,
      slug: `dist-${n}-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
    return { id: d.distributorId, slug: d.slug };
  };
  const distA = await dist('a');
  const distB = await dist('b');
  const usuario = async (rol: RoleType, etiqueta: string): Promise<Persona> => {
    const email = `${etiqueta}.${sufijo}@splg.local`;
    const phone = telefonoDePrueba();
    const u = (await ds.getRepository(User).save({
      email,
      fullName: `Test ${etiqueta}`,
      phoneNumber: phone,
      firebaseUid: `uid-${email}`,
      roleId: roles.get(rol),
    } as Partial<User>)) as User;
    return { userId: u.userId, email, phone };
  };
  const admin = async (
    rol: RoleType,
    etiqueta: string,
    distributorId: string | null,
  ) => {
    const p = await usuario(rol, etiqueta);
    const a = (await ds.getRepository(Admin).save({
      userId: p.userId,
      distributorId,
    } as Partial<Admin>)) as Admin;
    return { ...p, adminId: a.adminId };
  };
  const adminA = await admin(RoleType.ADMIN, 'admin-a', distA.id);
  const adminA2 = await admin(RoleType.ADMIN, 'admin-a2', distA.id);
  const adminB = await admin(RoleType.ADMIN, 'admin-b', distB.id);
  const superAdmin = await admin(RoleType.SUPER_ADMIN, 'super', null);
  const chofer = await usuario(RoleType.DELIVERY, 'chofer-a');
  const d = (await ds.getRepository(Delivery).save({
    userId: chofer.userId,
    distributorId: distA.id,
    validated: true,
    isEnabled: true,
  } as Partial<Delivery>)) as Delivery;
  const cliente = async (etiqueta: string, distributorId: string) => {
    const p = await usuario(RoleType.CUSTOMER, etiqueta);
    await ds.getRepository(Customer).save({
      userId: p.userId,
      notificationToken: 'fake-fcm',
    } as Partial<Customer>);
    await ds.query(
      `INSERT INTO customer_distributor (user_id, distributor_id, removed_at) VALUES ($1, $2, NULL)`,
      [p.userId, distributorId],
    );
    return p;
  };
  const clienteA = await cliente('cliente-a', distA.id);
  const clienteB = await cliente('cliente-b', distB.id);

  return {
    app,
    distA,
    distB,
    adminA,
    adminA2,
    adminB,
    superAdmin,
    choferA: { ...chofer, deliveryId: d.deliveryId },
    clienteA,
    clienteB,
    inexistente: randomUUID(),
    actores: {
      adminA: cabecerasDe_(adminA.email, 'panel-app'),
      adminA2: cabecerasDe_(adminA2.email, 'panel-app'),
      adminB: cabecerasDe_(adminB.email, 'panel-app'),
      // El super admin sin distribuidora (cross-tenant) y "viendo como" A.
      super: cabecerasDe_(superAdmin.email, 'panel-app'),
      superEnA: cabecerasDe_(superAdmin.email, 'panel-app', distA.slug),
      chofer: cabecerasDe_(chofer.email, 'driver-app'),
      clienteA: cabecerasDe_(clienteA.email, 'customer-app', distA.slug),
      clienteB: cabecerasDe_(clienteB.email, 'customer-app', distB.slug),
      // Un token que Firebase daría por bueno pero que no es de ningún usuario.
      tokenInvalido: {
        Authorization: 'Bearer invalido@splg.local',
        'X-Client-Source': 'panel-app',
      },
    },
  };
}

/**
 * Una persona más para los casos que la consumen (baja, bloqueo, cambio de
 * correo): cada caso destructivo usa la suya y no pisa al resto de la tabla.
 */
export async function sembrarPersona(
  app: TestApp,
  tipo: 'customer' | 'delivery' | 'admin',
  etiqueta: string,
  distributorId: string,
): Promise<Persona & { cabeceras: Cabeceras }> {
  const ds = app.get(DataSource);
  const rol = await ds
    .getRepository(Role)
    .findOneByOrFail({ type: tipo as string });
  const email = `${etiqueta}.${randomUUID().slice(0, 6)}@splg.local`;
  const phone = telefonoDePrueba();
  const u = (await ds.getRepository(User).save({
    email,
    fullName: `Test ${etiqueta}`,
    phoneNumber: phone,
    firebaseUid: `uid-${email}`,
    roleId: rol.roleId,
  } as Partial<User>)) as User;
  if (tipo === 'delivery') {
    await ds.getRepository(Delivery).save({
      userId: u.userId,
      distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
  } else if (tipo === 'admin') {
    await ds
      .getRepository(Admin)
      .save({ userId: u.userId, distributorId } as Partial<Admin>);
  } else {
    await ds.getRepository(Customer).save({
      userId: u.userId,
      notificationToken: 'fake-fcm',
    } as Partial<Customer>);
    await ds.query(
      `INSERT INTO customer_distributor (user_id, distributor_id, removed_at) VALUES ($1, $2, NULL)`,
      [u.userId, distributorId],
    );
  }
  const fuente =
    tipo === 'admin'
      ? 'panel-app'
      : tipo === 'delivery'
        ? 'driver-app'
        : 'customer-app';
  return {
    userId: u.userId,
    email,
    phone,
    cabeceras: cabecerasDe_(email, fuente),
  };
}
