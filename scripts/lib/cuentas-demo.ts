/**
 * Cuentas de la demo: las que tienen login real (se conservan, con nombre de
 * persona) y las de prueba que dejaron los tests y las revisiones (se dan de baja).
 */
import { EntityManager } from 'typeorm';

export interface CuentaConLogin {
  email: string;
  fullName: string;
}

/** Cuentas con login que la demo conserva, con su nombre real. */
export const CUENTAS_CON_LOGIN: readonly CuentaConLogin[] = [
  { email: 'superadmin@splg.com', fullName: 'Nahuel Wagner' },
  { email: 'admin@splg.com', fullName: 'Marcela Duarte' },
  { email: 'cliente@splg.com', fullName: 'Lucía Benítez' },
  { email: 'chofer@splg.com', fullName: 'Ramón Villalba' },
  { email: 'admin@gasandino.com', fullName: 'Gustavo Paredes' },
  { email: 'chofer@gasandino.com', fullName: 'Héctor Acosta' },
];

/**
 * Cómo se reconoce una cuenta de prueba por su correo. Lista explícita: lo que
 * no coincide con ninguno NO se toca.
 */
export const PATRONES_DE_CORREO_DE_PRUEBA: readonly RegExp[] = [
  /@splg-test\.com$/i,
  /^qa\./i,
  /^prueba\./i,
  /^ajeno/i,
  /^cobro\./i,
  /^qr-prueba-/i,
  /^e2e/i,
  /^postman/i,
];

/**
 * ÚNICO criterio para borrar una cuenta de FIREBASE (irreversible): el correo
 * termina en `@splg-test.com`. Sin excepciones ni listas: nunca por nombre ni por
 * un patrón sin dominio (`qa.*`, `cobro.*`, `ajeno*` valen para cualquier dominio,
 * incluidas personas reales). Cualquier otra cuenta "de prueba" sólo se da de baja
 * en la base.
 */
export const DOMINIO_DE_PRUEBA_PARA_FIREBASE = '@splg-test.com';

export function esBorrableEnFirebase(
  email: string | null | undefined,
): boolean {
  if (!email || esCuentaConservada(email)) return false;
  return email.toLowerCase().endsWith(DOMINIO_DE_PRUEBA_PARA_FIREBASE);
}

export interface CuentaDeFirebase {
  uid: string;
  email: string | null;
}

export interface PlanDeCuentas {
  /** uid de Firebase a borrar (sólo por correo de prueba conocido). */
  borrarEnFirebase: Array<{ uid: string; email: string; origen: string }>;
  /** Usuarios de la base que se dan de baja (sin tocar Firebase salvo que estén arriba). */
  bajaEnBase: UsuarioDeBase[];
}

/**
 * Qué se hace con cada cuenta. Pura: no toca Firebase ni la base. En Firebase sólo
 * se borra por correo (`esBorrableEnFirebase`); en la base se dan de baja además
 * las que parecen de prueba por patrón de correo o por nombre.
 */
export function planDeCuentas(
  enFirebase: readonly CuentaDeFirebase[],
  enBase: readonly UsuarioDeBase[],
): PlanDeCuentas {
  const borrar = new Map<
    string,
    { uid: string; email: string; origen: string }
  >();
  for (const u of enFirebase) {
    if (esBorrableEnFirebase(u.email)) {
      borrar.set(u.uid, {
        uid: u.uid,
        email: u.email!,
        origen: 'Firebase por correo',
      });
    }
  }
  for (const u of enBase) {
    if (
      u.firebase_uid &&
      esBorrableEnFirebase(u.email) &&
      !borrar.has(u.firebase_uid)
    ) {
      borrar.set(u.firebase_uid, {
        uid: u.firebase_uid,
        email: u.email!,
        origen: 'base por correo',
      });
    }
  }
  return {
    borrarEnFirebase: [...borrar.values()],
    bajaEnBase: enBase.filter((u) => esCuentaDePrueba(u.email, u.full_name)),
  };
}

/** Cómo se reconoce por el nombre (sólo para la base; Firebase se decide por correo). */
export const PATRON_DE_NOMBRE_DE_PRUEBA =
  /(chofer ajeno|chofer prueba|cliente prueba|admin demo|\bprueba\b|\be2e\b|postman)/i;

const CORREOS_CONSERVADOS = new Set(
  CUENTAS_CON_LOGIN.map((c) => c.email.toLowerCase()),
);

export function esCuentaConservada(email: string | null | undefined): boolean {
  return !!email && CORREOS_CONSERVADOS.has(email.toLowerCase());
}

export function esCorreoDePrueba(email: string | null | undefined): boolean {
  if (!email || esCuentaConservada(email)) return false;
  return PATRONES_DE_CORREO_DE_PRUEBA.some((p) => p.test(email));
}

export function esCuentaDePrueba(
  email: string | null | undefined,
  nombre: string | null | undefined,
): boolean {
  if (esCuentaConservada(email)) return false;
  return (
    esCorreoDePrueba(email) ||
    (!!nombre && PATRON_DE_NOMBRE_DE_PRUEBA.test(nombre))
  );
}

export interface UsuarioDeBase {
  user_id: string;
  email: string | null;
  full_name: string | null;
  firebase_uid: string | null;
}

/** Todas las cuentas de la base (el plan decide cuáles son de prueba). */
export async function usuariosDeLaBase(
  m: EntityManager,
): Promise<UsuarioDeBase[]> {
  return m.query(
    `SELECT "user_id", "email", "full_name", "firebase_uid" FROM "user" WHERE "deletedAt" IS NULL`,
  );
}

/** Las cuentas de la base que son de prueba (con o sin login en Firebase). */
export async function cuentasDePruebaEnBase(
  m: EntityManager,
): Promise<UsuarioDeBase[]> {
  const todas: UsuarioDeBase[] = await m.query(
    `SELECT "user_id", "email", "full_name", "firebase_uid" FROM "user"`,
  );
  return todas.filter((u) => esCuentaDePrueba(u.email, u.full_name));
}

/**
 * Baja de las cuentas de prueba en la base: se les saca el `firebase_uid` y se
 * archivan. La purga del seed las borra de verdad (o las deja archivadas si algo
 * ajeno al seed las referencia).
 */
export async function darDeBajaEnBase(
  m: EntityManager,
  usuarios: readonly UsuarioDeBase[],
): Promise<void> {
  if (usuarios.length === 0) return;
  await m.query(
    `UPDATE "user" SET "firebase_uid" = NULL, "deletedAt" = COALESCE("deletedAt", now()),
            "email" = 'baja-' || "user_id" || '@baja.invalid', "phone_number" = NULL
      WHERE "user_id" = ANY($1::uuid[])`,
    [usuarios.map((u) => u.user_id)],
  );
}

/** Pone el nombre real a las cuentas con login que existan en la base. */
export async function renombrarCuentasEnBase(
  m: EntityManager,
): Promise<number> {
  let n = 0;
  for (const c of CUENTAS_CON_LOGIN) {
    const r: unknown = await m.query(
      `UPDATE "user" SET "full_name" = $2 WHERE lower("email") = lower($1) AND "full_name" <> $2`,
      [c.email, c.fullName],
    );
    // UPDATE sin RETURNING devuelve [filas, cantidad].
    if (Array.isArray(r) && typeof r[1] === 'number') n += r[1];
  }
  return n;
}

/**
 * Lista blanca: las únicas cuentas con login que quedan en la demo son las de
 * `CUENTAS_CON_LOGIN`. Cualquier otra con `firebase_uid` se da de baja en la base
 * (la purga del seed la borra después). Devuelve las que sacó.
 */
export async function darDeBajaFueraDeLaLista(
  m: EntityManager,
): Promise<UsuarioDeBase[]> {
  const sobrantes: UsuarioDeBase[] = await m.query(
    `SELECT "user_id", "email", "full_name", "firebase_uid" FROM "user"
      WHERE "firebase_uid" IS NOT NULL AND NOT (lower("email") = ANY($1::text[]))`,
    [CUENTAS_CON_LOGIN.map((c) => c.email.toLowerCase())],
  );
  await darDeBajaEnBase(m, sobrantes);
  return sobrantes;
}
