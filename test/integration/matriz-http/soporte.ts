/**
 * Modo soporte en las matrices: el super admin ya no opera una empresa con
 * `X-Distributor` («ver como»). Sin sesión de soporte, lo de una empresa le da
 * 403 `SUPPORT_SESSION_REQUIRED`; con una sesión activa ve esa empresa como un
 * admin de ella, en sólo lectura (una escritura es 403 `SUPPORT_READ_ONLY`).
 *
 * `conSesionDeSoporte` deja un super admin nuevo con una sesión ya activa sobre
 * la empresa (fila directa en la base del contenedor: sin avisos ni aprobación,
 * que los prueba `modo-soporte.e2e-spec.ts`). Cada llamada usa su propio super
 * admin, así varias sesiones conviven (una activa por super admin).
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Admin } from '../../../src/admin/entities/admin.entity';
import { RoleType } from '../../../src/common/constants/role-type.enum';
import { Role } from '../../../src/role/entities/role.entity';
import { User } from '../../../src/users/entities/user.entity';
import { TestApp, telefonoDePrueba } from '../setup/test-env';
import type { Cabeceras, Caso, ContextoMatriz } from './matriz';

export const CODIGO_SIN_SESION = 'SUPPORT_SESSION_REQUIRED';
export const CODIGO_SOLO_LECTURA = 'SUPPORT_READ_ONLY';

export interface SesionDeSoporteDePrueba {
  cabeceras: Cabeceras;
  userId: string;
  email: string;
  sessionId: string;
}

/** Un super admin nuevo con una sesión de soporte activa (120 min) sobre la empresa, con ese alcance. */
export async function conSesionDeSoporte(
  app: TestApp,
  distributorId: string,
  etiqueta = 'soporte',
  alcance: ReadonlyArray<'personal_data' | 'files' | 'exports'> = [],
): Promise<SesionDeSoporteDePrueba> {
  const ds = app.get(DataSource);
  const rol =
    (await ds
      .getRepository(Role)
      .findOne({ where: { type: RoleType.SUPER_ADMIN } })) ??
    (await ds
      .getRepository(Role)
      .save({ type: RoleType.SUPER_ADMIN } as Partial<Role>));
  const email = `${etiqueta}.${randomUUID().slice(0, 6)}@splg.local`;
  const u = (await ds.getRepository(User).save({
    email,
    fullName: `Soporte ${etiqueta}`,
    phoneNumber: telefonoDePrueba(),
    firebaseUid: `uid-${email}`,
    roleId: rol.roleId,
  } as Partial<User>)) as User;
  await ds
    .getRepository(Admin)
    .save({ userId: u.userId, distributorId: null } as Partial<Admin>);
  const [fila] = await ds.query<Array<{ id: string }>>(
    `INSERT INTO support_session
       (distributor_id, requested_by, kind, status, reason, scope, requested_minutes,
        request_expires_at, decided_at, started_at, expires_at)
     VALUES ($1, $2, 'consented', 'active', 'Sesión de soporte de las pruebas de la matriz',
             $3::text[], 120, now() + interval '24 hours', now(), now(), now() + interval '120 minutes')
     RETURNING support_session_id AS id`,
    [distributorId, u.userId, alcance],
  );
  return {
    userId: u.userId,
    email,
    sessionId: fila.id,
    cabeceras: {
      Authorization: `Bearer ${email}`,
      'X-Client-Source': 'panel-app',
      'X-Support-Session': fila.id,
    },
  };
}

/**
 * Lo que espera el super admin SIN sesión en algo de una empresa: 403 con su
 * `code`. Las verificaciones del caso de éxito no aplican.
 */
export function sinSesionDeSoporte<C extends ContextoMatriz>(
  c: Caso<C>,
): Caso<C> {
  return {
    ...c,
    caso: `${c.caso} (sin sesión de soporte)`,
    esperado: 403,
    code: CODIGO_SIN_SESION,
    mensaje: undefined,
    mensajeExacto: undefined,
    verificar: undefined,
  };
}

/**
 * El mismo caso hecho por el super admin EN modo soporte (`actor`, con su
 * sesión sobre la empresa): una lectura conserva lo esperado (lo de esa
 * empresa, o 404 si es de otra); una escritura es 403 `SUPPORT_READ_ONLY`.
 */
export function enSesionDeSoporte<C extends ContextoMatriz>(
  c: Caso<C>,
  actor: string,
): Caso<C> {
  const base = { ...c, actor, caso: `${c.caso} (en modo soporte)` };
  if (c.metodo === 'get') return base;
  return {
    ...base,
    esperado: 403,
    code: CODIGO_SOLO_LECTURA,
    mensaje: undefined,
    mensajeExacto: undefined,
    verificar: undefined,
  };
}

type Fabrica<C extends ContextoMatriz> = (
  caso: string,
  actor: string | undefined,
  esperado: number,
  extra?: Partial<Caso<C>>,
) => Caso<C>;

/**
 * Los tres casos del modo soporte que lleva cada matriz: el super admin con
 * sesión lee lo de su empresa (200) y no escribe (403 `SUPPORT_READ_ONLY`), y
 * sin sesión no lee (403 `SUPPORT_SESSION_REQUIRED`). `lectura` y `escritura`
 * son endpoints de empresa de la suite; `actor` es el del escenario con la
 * sesión (por defecto `soporteA`, sobre la distribuidora A).
 */
export function casosEnModoSoporte<C extends ContextoMatriz>(
  lectura: Fabrica<C>,
  escritura: Fabrica<C>,
  o: {
    actor?: string;
    lectura?: Partial<Caso<C>>;
    escritura?: Partial<Caso<C>>;
  } = {},
): Array<Caso<C>> {
  const actor = o.actor ?? 'soporteA';
  return [
    lectura('super admin en modo soporte: lee lo de su empresa', actor, 200, {
      ...o.lectura,
    }),
    escritura('super admin en modo soporte: no escribe', actor, 403, {
      ...o.escritura,
      code: CODIGO_SOLO_LECTURA,
      verificar: undefined,
    }),
    lectura('super admin sin sesión de soporte', 'super', 403, {
      ...o.lectura,
      code: CODIGO_SIN_SESION,
      verificar: undefined,
    }),
  ];
}
