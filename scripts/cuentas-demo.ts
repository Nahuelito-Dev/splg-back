/**
 * Deja las cuentas de la demo como corresponde:
 *   - las de login (admin, superadmin, cliente, chofer, staff de la 2da
 *     distribuidora) conservan su cuenta y pasan a tener nombre de persona, en la
 *     base y en Firebase (`displayName`);
 *   - las de prueba se dan de baja en la base; de Firebase sólo se borran las de
 *     correo `@splg-test.com` (nunca por nombre ni por patrones sin dominio).
 *
 *   npm run cuentas:demo               # DRY-RUN: sólo lista, no cambia nada
 *   CONFIRMAR_PROYECTO=<id> npm run cuentas:demo -- --apply    # aplica
 *
 * El borrado en Firebase es irreversible: corré siempre el dry-run primero, leé la
 * lista y recién ahí aplicá confirmando el proyecto con `CONFIRMAR_PROYECTO`.
 */
import 'dotenv/config';
import * as firebase from 'firebase-admin';
import { DataSource } from 'typeorm';
import {
  CUENTAS_CON_LOGIN,
  darDeBajaEnBase,
  planDeCuentas,
  renombrarCuentasEnBase,
  usuariosDeLaBase,
} from './lib/cuentas-demo';
import { resguardoDeProduccion } from './lib/resguardo-de-produccion';

const APLICAR = process.argv.includes('--apply');

async function main() {
  resguardoDeProduccion();
  const proyecto = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!proyecto || !clientEmail || !privateKey) {
    throw new Error(
      'Faltan FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY',
    );
  }
  const app = firebase.initializeApp({
    credential: firebase.credential.cert({
      projectId: proyecto,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    }),
  });
  const auth = app.auth();

  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    synchronize: false,
    extra: { application_name: 'splg-script:cuentas-demo' },
  });
  await ds.initialize();

  console.log(
    `\nProyecto Firebase: ${proyecto}  ·  base: ${process.env.DB_NAME}  ·  modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN (no cambia nada)'}`,
  );

  // 1. Plan: en Firebase sólo se borra por correo de prueba conocido; el resto de
  // las cuentas "de prueba" (por nombre o patrón) se dan de baja sólo en la base.
  const enFirebase = new Map<string, firebase.auth.UserRecord>();
  let pagina = await auth.listUsers(1000);
  for (;;) {
    for (const u of pagina.users)
      enFirebase.set((u.email ?? '').toLowerCase(), u);
    if (!pagina.pageToken) break;
    pagina = await auth.listUsers(1000, pagina.pageToken);
  }
  const plan = planDeCuentas(
    [...enFirebase.values()].map((u) => ({
      uid: u.uid,
      email: u.email ?? null,
    })),
    await usuariosDeLaBase(ds.manager),
  );

  console.log(
    `\nCuentas a BORRAR de Firebase (${plan.borrarEnFirebase.length}) — sólo correo @splg-test.com:`,
  );
  for (const c of plan.borrarEnFirebase) {
    console.log(`  - ${c.email.padEnd(44)} ${c.uid}  [${c.origen}]`);
  }
  console.log(
    `\nCuentas a dar de baja SÓLO EN LA BASE, sin tocar Firebase (${plan.bajaEnBase.length}):`,
  );
  for (const u of plan.bajaEnBase) {
    console.log(
      `  - ${(u.email ?? '(sin correo)').padEnd(44)} ${u.full_name ?? ''}`,
    );
  }
  console.log('\nCuentas con login que se CONSERVAN (nombre nuevo):');
  for (const c of CUENTAS_CON_LOGIN) {
    const f = enFirebase.get(c.email.toLowerCase());
    console.log(
      `  - ${c.email.padEnd(28)} → ${c.fullName}${f ? '' : '   (no existe en Firebase)'}`,
    );
  }

  if (!APLICAR) {
    console.log(
      '\nDRY-RUN: no se cambió nada. Para aplicar: CONFIRMAR_PROYECTO=<id> npm run cuentas:demo -- --apply',
    );
    return;
  }
  if (process.env.CONFIRMAR_PROYECTO !== proyecto) {
    throw new Error(
      `Para aplicar hay que confirmar el proyecto: CONFIRMAR_PROYECTO=${proyecto} npm run cuentas:demo -- --apply`,
    );
  }

  // 2. Primero la base, en una transacción: si falla, Firebase no se toca.
  await ds.transaction(async (m) => {
    await darDeBajaEnBase(m, plan.bajaEnBase);
    await renombrarCuentasEnBase(m);
  });

  // 3. Después Firebase: borrar las de prueba y renombrar las conservadas.
  let borradas = 0;
  const uids = plan.borrarEnFirebase.map((c) => c.uid);
  for (let i = 0; i < uids.length; i += 100) {
    const r = await auth.deleteUsers(uids.slice(i, i + 100));
    borradas += r.successCount;
    for (const e of r.errors) {
      console.error(
        `  ! no se pudo borrar ${uids[i + e.index]}: ${e.error.message}`,
      );
    }
  }
  for (const c of CUENTAS_CON_LOGIN) {
    const f = enFirebase.get(c.email.toLowerCase());
    if (f && f.displayName !== c.fullName) {
      await auth.updateUser(f.uid, { displayName: c.fullName });
    }
  }
  console.log(
    `\nListo: ${plan.bajaEnBase.length} dadas de baja en la base, ${borradas} borradas de Firebase.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      '\ncuentas:demo falló:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
