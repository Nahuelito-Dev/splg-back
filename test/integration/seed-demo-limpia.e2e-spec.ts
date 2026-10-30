/**
 * Demo limpia: `npm run seed:demo` contra un Postgres (con TODA la cadena de
 * migraciones) y un MinIO efímeros. Nunca toca `splg_db`, Firebase ni el bucket real.
 *
 * Se ensucia a propósito la base (filas "de prueba" en todas las tablas con
 * `distributor_id`, usuarios de prueba, un objeto de S3 fuera del prefijo de la demo),
 * se corre el seed dos veces seguidas como proceso aparte (igual que lo corre
 * nahue) y se verifica:
 *  - la purga borra todo lo de prueba, en todas las tablas;
 *  - ningún texto visible dice prueba/test/e2e/ajeno/hola/postman;
 *  - la conciliación de stock da consistente (el servicio real) y
 *    vendible − déficit = llenas − reservadas;
 *  - los usuarios con login se conservan, con nombre real;
 *  - dos corridas dejan el mismo resultado;
 *  - S3: sólo se borra bajo el prefijo de la demo.
 */
import { execFile } from 'child_process';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { Order } from '../../src/order/entities/order.entity';
import { OrderLookupService } from '../../src/order/lookup/order-lookup.service';
import { StockOnHandService } from '../../src/stock/application/stock-on-hand.service';
import { StockReconciliationService } from '../../src/stock/application/stock-reconciliation.service';
import {
  cuentasDePruebaEnBase,
  CUENTAS_CON_LOGIN,
  darDeBajaEnBase,
  esBorrableEnFirebase,
  esCuentaDePrueba,
  esCorreoDePrueba,
  planDeCuentas,
} from '../../scripts/lib/cuentas-demo';
import { keyEsDeLaDemo } from '../../scripts/lib/storage-demo';
import { BUCKET_DE_PRUEBA, startMinio, TestMinio } from './setup/minio';
import { sembrarChoferDeFixture } from './setup/pedido-valido';

const IMAGEN_POSTGIS =
  process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4';
const aExec = promisify(execFile);
const PRUEBA = /(prueba|test|e2e|ajeno|hola|postman)/i;

describe('cuentas de la demo (patrones)', () => {
  it.each([
    'qa.maria@gmail.com',
    'prueba.cliente@splg.com',
    'ajeno1@splg.com',
    'cobro.uno@splg.com',
    'qr-prueba-17@splg.com',
    'alguien@splg-test.com',
  ])('%s es una cuenta de prueba', (correo) => {
    expect(esCorreoDePrueba(correo)).toBe(true);
  });

  it('las cuentas con login se conservan siempre', () => {
    for (const c of CUENTAS_CON_LOGIN) {
      expect(esCuentaDePrueba(c.email, 'Chofer Prueba')).toBe(false);
      expect(esCorreoDePrueba(c.email)).toBe(false);
    }
  });

  it('una persona real no es de prueba, aunque el correo sea de otro dominio', () => {
    expect(esCuentaDePrueba('lucia@gmail.com', 'Lucía Benítez')).toBe(false);
    expect(esCuentaDePrueba('x@y.com', 'Chofer Ajeno')).toBe(true);
  });
});

describe('S3: qué keys puede borrar el seed', () => {
  const dist = randomUUID();
  const usuario = randomUUID();
  it.each([
    [`gascylinders/${dist}/a/b.png`, true],
    [`cars/${dist}/c.png`, true],
    [`attachments/${dist}/purchase_receipt/x/y.png`, true],
    [`fleet/${dist}/t/z.png`, true],
    [`users/${usuario}/f.png`, true],
    [`backups/${dist}/x.png`, false],
    [`users/${randomUUID()}/y.png`, false],
    [`otro/gascylinders/${dist}/a.png`, false],
    [`gascylinders/${randomUUID()}/a.png`, false],
  ])('%s → %s', (key, esperado) => {
    expect(keyEsDeLaDemo(key, [dist], [usuario])).toBe(esperado);
  });
});

describe('cuentas:demo: qué se borra de Firebase', () => {
  const fb = (email: string, uid = email) => ({ uid, email });
  const bd = (email: string, nombre: string, uid: string | null = null) => ({
    user_id: email,
    email,
    full_name: nombre,
    firebase_uid: uid,
  });

  it('sólo se borra por correo @splg-test.com, nunca por nombre ni por patrón sin dominio', () => {
    const plan = planDeCuentas(
      [
        fb('alguien@splg-test.com'),
        fb('real2@gmail.com'),
        fb('cobro.posadas@empresa.com'),
        fb('qa.lucia@gmail.com'),
        fb('ajeno.perez@hotmail.com'),
        fb('admin@splg.com'),
      ],
      [
        bd('real2@gmail.com', 'Marta Prueba', 'uid-real2'),
        bd('cobro.posadas@empresa.com', 'Cobro Posadas', 'uid-cobro'),
        bd('x@splg-test.com', 'Equis', 'uid-x'),
      ],
    );
    expect(plan.borrarEnFirebase.map((c) => c.email).sort()).toEqual([
      'alguien@splg-test.com',
      'x@splg-test.com',
    ]);
    // "Marta Prueba" se da de baja SÓLO en la base: no está entre las de Firebase.
    expect(plan.bajaEnBase.map((u) => u.email)).toContain('real2@gmail.com');
    expect(plan.borrarEnFirebase.map((c) => c.uid)).not.toContain('uid-real2');
    expect(plan.borrarEnFirebase.map((c) => c.uid)).not.toContain('uid-cobro');
  });

  it('las cuentas con login no se borran aunque coincidan con un patrón', () => {
    for (const c of CUENTAS_CON_LOGIN) {
      expect(esBorrableEnFirebase(c.email)).toBe(false);
    }
    expect(esBorrableEnFirebase('qa.maria@splg-test.com')).toBe(true);
    expect(esBorrableEnFirebase(null)).toBe(false);
  });
});

describe('seed:demo en contenedores (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let minio: TestMinio;
  let ds: DataSource;
  let distId: string;
  let loginAntes: Array<{ user_id: string; firebase_uid: string }>;
  const FUERA_DE_PREFIJO = 'otro-origen/canario/no-tocar.png';
  const OTRO_USUARIO = randomUUID();
  /** Keys que una fila de la demo apunta pero que NO están bajo un prefijo exacto. */
  const CANARIOS_DE_S3 = [
    FUERA_DE_PREFIJO,
    `backups/${randomUUID()}/x.png`,
    `users/${OTRO_USUARIO}/y.png`,
  ];

  async function consultar<T>(sql: string, params: unknown[] = []) {
    const filas: unknown = await ds.query(sql, params);
    return filas as T[];
  }

  async function correr(
    script: string,
    extra: Record<string, string> = {},
  ): Promise<string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'test',
      // Que `dotenv` no lea el `.env` real: todo viene de los contenedores.
      DOTENV_CONFIG_PATH: '/dev/null',
      DB_HOST: pg.getHost(),
      DB_PORT: String(pg.getPort()),
      DB_USERNAME: pg.getUsername(),
      DB_PASSWORD: pg.getPassword(),
      DB_NAME: pg.getDatabase(),
      DB_SSL: 'false',
      SEED_S3: '1',
      SEED_PURGE_S3: '1',
      TS_NODE_TRANSPILE_ONLY: 'true',
      // Las otras distribuidoras se borran sólo con confirmación explícita.
      CONFIRMAR_DISTRIBUIDORAS: 'gas-andino',
      ...minio.env,
      ...extra,
    };
    const { stdout } = await aExec(
      join(process.cwd(), 'node_modules/.bin/ts-node'),
      ['-r', 'tsconfig-paths/register', script],
      { env, cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024, timeout: 280000 },
    );
    return stdout;
  }

  /** Cantidad de filas de cada tabla (menos las de sistema). */
  async function conteos(): Promise<Record<string, number>> {
    const tablas = await consultar<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name NOT IN ('migrations', 'spatial_ref_sys', 'storage_orphan')`,
    );
    const r: Record<string, number> = {};
    for (const { t } of tablas) {
      const [{ n }] = await consultar<{ n: string }>(
        `SELECT count(*) AS n FROM "${t}"`,
      );
      r[t] = Number(n);
    }
    return r;
  }

  /** Mete una fila "de prueba" en una tabla, completando lo obligatorio. */
  async function insertarSucia(
    qr: ReturnType<DataSource['createQueryRunner']>,
    tabla: string,
    valores: Record<string, unknown>,
  ): Promise<boolean> {
    const columnas = (await qr.query(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = 'public'
          AND is_nullable = 'NO' AND column_default IS NULL`,
      [tabla],
    )) as Array<{ column_name: string; data_type: string; udt_name: string }>;
    const fila: Record<string, unknown> = { ...valores };
    const crudas: Record<string, string> = {};
    for (const c of columnas) {
      if (c.column_name in fila) continue;
      if (c.data_type === 'uuid') fila[c.column_name] = randomUUID();
      else if (c.data_type === 'USER-DEFINED' && c.udt_name === 'geometry')
        crudas[c.column_name] =
          `ST_SetSRID(ST_GeomFromText('POLYGON((0 0,0 1,1 1,0 0))'),4326)`;
      else if (c.data_type === 'USER-DEFINED') {
        const [e] = (await qr.query(
          `SELECT enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = $1 ORDER BY enumsortorder LIMIT 1`,
          [c.udt_name],
        )) as Array<{ v: string }>;
        fila[c.column_name] = e.v;
      } else if (/int|numeric|double|real/.test(c.data_type))
        fila[c.column_name] = 1;
      else if (c.data_type === 'boolean') fila[c.column_name] = false;
      else if (/timestamp|date/.test(c.data_type))
        fila[c.column_name] = new Date();
      else if (/json/.test(c.data_type)) fila[c.column_name] = '{}';
      else if (/^time/.test(c.data_type)) fila[c.column_name] = '08:00:00';
      else fila[c.column_name] = `prueba-${randomUUID().slice(0, 3)}`;
    }
    const nombres = Object.keys(fila);
    const todas = [...nombres, ...Object.keys(crudas)];
    const valoresSql = [
      ...nombres.map((_, i) => `$${i + 1}`),
      ...Object.values(crudas),
    ];
    await qr.query('SAVEPOINT sucia');
    try {
      await qr.query(
        `INSERT INTO "${tabla}" (${todas.map((n) => `"${n}"`).join(',')})
         VALUES (${valoresSql.join(',')})`,
        nombres.map((n) => fila[n]),
      );
      await qr.query('RELEASE SAVEPOINT sucia');
      return true;
    } catch {
      await qr.query('ROLLBACK TO SAVEPOINT sucia');
      return false;
    }
  }

  /** Objetos del bucket (menos el canario) que ninguna fila referencia. */
  async function huerfanos(): Promise<string[]> {
    const referenciadas = new Set<string>();
    for (const [tabla, col] of [
      ['gas_cylinder', 'photo_key'],
      ['car', 'photo_key'],
      ['claims', 'photo_key'],
      ['incident', 'photo_key'],
      ['distributor', 'logo_key'],
      ['attachment', 'storage_key'],
      ['user', 'photo_key'],
      ['employee', 'photo_key'],
    ]) {
      const filas = await consultar<{ k: string | null }>(
        `SELECT "${col}" AS k FROM "${tabla}" WHERE "${col}" IS NOT NULL`,
      );
      filas.forEach((f) => f.k && referenciadas.add(f.k));
    }
    return (await objetosDelBucket()).filter(
      (k) => !CANARIOS_DE_S3.includes(k) && !referenciadas.has(k),
    );
  }

  async function existeEnBucket(key: string): Promise<boolean> {
    try {
      await minio.client.send(
        new HeadObjectCommand({ Bucket: BUCKET_DE_PRUEBA, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async function objetosDelBucket(): Promise<string[]> {
    const r = await minio.client.send(
      new ListObjectsV2Command({ Bucket: BUCKET_DE_PRUEBA }),
    );
    return (r.Contents ?? []).map((o) => o.Key ?? '');
  }

  beforeAll(async () => {
    [pg, minio] = await Promise.all([
      new PostgreSqlContainer(IMAGEN_POSTGIS)
        .withDatabase('splg_demo_limpia')
        .withUsername('test')
        .withPassword('test')
        .start(),
      startMinio(),
    ]);
    ds = new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
      entities: [join(__dirname, '../../src/**/*.entity.ts')],
      migrations: [join(__dirname, '../../src/migrations/*.ts')],
      synchronize: false,
      migrationsTransactionMode: 'each',
    });
    await ds.initialize();
    await ds.runMigrations();

    // Lo que deja `npm run seed`: roles, distribuidoras y las cuentas con login.
    for (const type of ['customer', 'delivery', 'admin', 'super_admin']) {
      await ds.query(`INSERT INTO role (type) VALUES ($1)`, [type]);
    }
    const rol = async (type: string) =>
      (
        await consultar<{ role_id: string }>(
          `SELECT role_id FROM role WHERE type = $1`,
          [type],
        )
      )[0].role_id;
    const [{ distributor_id }] = await consultar<{ distributor_id: string }>(
      `INSERT INTO distributor (name, slug) VALUES ('Distribuidora Demo', 'demo') RETURNING distributor_id`,
    );
    distId = distributor_id;
    const [{ distributor_id: andino }] = await consultar<{
      distributor_id: string;
    }>(
      `INSERT INTO distributor (name, slug) VALUES ('Gas Andino', 'gas-andino') RETURNING distributor_id`,
    );
    const login = async (
      email: string,
      nombre: string,
      tipo: string,
      telefono: string,
    ): Promise<string> =>
      (
        await consultar<{ user_id: string }>(
          `INSERT INTO "user" (role_id, firebase_uid, full_name, email, phone_number, phone_verified, email_verified)
           VALUES ($1, $2, $3, $4, $5, true, true) RETURNING user_id`,
          [await rol(tipo), `uid-${email}`, nombre, email, telefono],
        )
      )[0].user_id;
    const superadmin = await login(
      'superadmin@splg.com',
      'Super Admin',
      'super_admin',
      '+5493815550001',
    );
    const admin = await login(
      'admin@splg.com',
      'Admin Demo',
      'admin',
      '+5493815550002',
    );
    const cliente = await login(
      'cliente@splg.com',
      'Cliente Prueba',
      'customer',
      '+5493815550003',
    );
    const chofer = await login(
      'chofer@splg.com',
      'Chofer Prueba',
      'delivery',
      '+5493815550004',
    );
    const adminAndino = await login(
      'admin@gasandino.com',
      'Admin Andino',
      'admin',
      '+5493815550012',
    );
    const choferAndino = await login(
      'chofer@gasandino.com',
      'Chofer Andino',
      'delivery',
      '+5493815550014',
    );
    await ds.query(
      `INSERT INTO admin (distributor_id, user_id) VALUES ($1, $2), ($3, $4), (NULL, $5)`,
      [distId, admin, andino, adminAndino, superadmin],
    );
    await ds.query(`INSERT INTO customer (user_id) VALUES ($1)`, [cliente]);
    await ds.query(
      `INSERT INTO delivery (distributor_id, user_id, validated, "isActive") VALUES ($1, $2, true, true), ($3, $4, true, true)`,
      [distId, chofer, andino, choferAndino],
    );

    // ── Ensucia la base ─────────────────────────────────────────────────────
    // Cuentas de prueba con login (las que dejaron los tests y las revisiones).
    const ajeno = await login(
      'ajeno1@splg-test.com',
      'Chofer Ajeno',
      'delivery',
      '+5493815559001',
    );
    await login(
      'qa.maria@splg-test.com',
      'Maria QA',
      'customer',
      '+5493815559002',
    );
    await ds.query(
      `INSERT INTO delivery (distributor_id, user_id, validated, "isActive") VALUES ($1, $2, true, true)`,
      [distId, ajeno],
    );
    // Cuentas de prueba con login que NINGÚN patrón atrapa: la lista blanca las saca.
    const clienteAjeno = await login(
      'cliente.ajeno@splg.com',
      'Cliente Ajeno',
      'customer',
      '+5493815559101',
    );
    const choferTest = await login(
      'chofer.test@splg.com',
      'Chofer Test',
      'delivery',
      '+5493815559102',
    );
    await ds.query(`INSERT INTO customer (user_id) VALUES ($1)`, [
      clienteAjeno,
    ]);
    await ds.query(
      `INSERT INTO delivery (distributor_id, user_id, validated, "isActive") VALUES ($1, $2, true, true)`,
      [distId, choferTest],
    );
    // Una fila de prueba en cada tabla con `distributor_id` (sin claves foráneas:
    // la purga las tiene que borrar igual). Usa una sola conexión.
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.query(`SET session_replication_role = replica`);
    const tablas = (await qr.query(
      `SELECT table_name AS t FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'distributor_id'
          AND table_name NOT IN ('distributor', 'admin', 'delivery', 'module_config')
        ORDER BY 1`,
    )) as Array<{ t: string }>;
    await qr.startTransaction();
    ensuciadas = [];
    for (const { t } of tablas) {
      const propios: Record<string, Record<string, unknown>> = {
        stock_location: { kind: 'warehouse', warehouse_id: randomUUID() },
        stock_movement: { to_location_id: randomUUID(), to_condition: 'full' },
        // Lo que cada regla de la base exige a una fila suelta.
        cylinder_inspection: { next_due_at: new Date() },
        document_sequence: { doc_type: 'prueba_vieja', last_number: 1 },
        driver_liquidation: { gross: 10, deductions: 0, net: 10 },
        insurance_policy: {
          valid_from: '2026-01-01',
          valid_to: '2026-12-31',
        },
        maintenance_task: { car_id: randomUUID() },
        supplier: { cuit: '20123456786' },
        time_slot: { startTime: '08:00:00', endTime: '12:00:00' },
        warehouse: { code: 'DEP-PRUEBA' },
      };
      if (
        await insertarSucia(qr, t, { distributor_id: distId, ...propios[t] })
      ) {
        ensuciadas.push(t);
      } else {
        sinEnsuciar.push(t);
      }
    }
    await qr.commitTransaction();
    await qr.query(`SET session_replication_role = DEFAULT`);
    await qr.release();

    // Un objeto de S3 de la demo anterior (se tiene que borrar) y otro que una
    // fila apunta pero que está FUERA del prefijo de la demo (no se toca).
    for (const key of [...CANARIOS_DE_S3, `claims/${distId}/viejo/foto.png`]) {
      await minio.client.send(
        new PutObjectCommand({
          Bucket: BUCKET_DE_PRUEBA,
          Key: key,
          Body: Buffer.from('png'),
        }),
      );
    }
    await ds.query(
      `UPDATE claims SET photo_key = $2 WHERE distributor_id = $1`,
      [distId, `claims/${distId}/viejo/foto.png`],
    );
    // Una key "contiene el id de la distribuidora" pero no es de sus carpetas, y una de
    // `users/` de alguien que no se quita: ninguna se borra.
    for (const [tabla, key] of [
      ['car', FUERA_DE_PREFIJO],
      ['incident', CANARIOS_DE_S3[1]],
      ['employee', CANARIOS_DE_S3[2]],
    ]) {
      await ds.query(
        `UPDATE "${tabla}" SET photo_key = $2 WHERE distributor_id = $1`,
        [distId, key],
      );
    }
    // Un usuario sin login, sin perfil y sin pedidos: huérfano, no se sabe de quién es.
    await ds.query(
      `INSERT INTO "user" (full_name, email, phone_number) VALUES ('Persona Suelta', 'suelta@correo.com.ar', '+5493764009999')`,
    );

    loginAntes = await consultar<{ user_id: string; firebase_uid: string }>(
      `SELECT user_id, firebase_uid FROM "user"
        WHERE firebase_uid IS NOT NULL AND email = ANY($1::text[])
        ORDER BY email`,
      [CUENTAS_CON_LOGIN.map((c) => c.email)],
    );
  }, 300000);

  let ensuciadas: string[] = [];
  const sinEnsuciar: string[] = [];
  let salida1 = '';
  let conteos1: Record<string, number> = {};

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    await Promise.all([pg?.stop(), minio?.stop()]);
  });

  it('la base de partida está sucia en todas las tablas con distributor_id', () => {
    // Cada tabla con `distributor_id` salvo las que tienen reglas que una fila
    // suelta no cumple (se informan en el test, no se ocultan).
    expect(sinEnsuciar).toEqual([]);
    expect(ensuciadas.length).toBeGreaterThanOrEqual(30);
    for (const t of [
      'employee',
      'supplier',
      'warehouse',
      'stock_movement',
      'purchase_order',
      'truck_load',
      'maintenance_plan',
      'audit',
      'audit_log',
      'attachment',
      'vehicle_usage_log',
      'stock_threshold',
      'job_position',
    ]) {
      expect(ensuciadas).toContain(t);
    }
  });

  it('las cuentas de prueba se reconocen y se dan de baja en la base; las de login no', async () => {
    const pruebas = await cuentasDePruebaEnBase(ds.manager);
    const correos = pruebas.map((u) => u.email).sort();
    expect(correos).toEqual(
      expect.arrayContaining([
        'ajeno1@splg-test.com',
        'qa.maria@splg-test.com',
      ]),
    );
    // "Chofer Prueba" / "Cliente Prueba" / "Admin Demo" son cuentas con login: se
    // conservan (cambian de nombre), no se dan de baja.
    expect(correos).not.toContain('chofer@splg.com');
    expect(correos).not.toContain('cliente@splg.com');
    expect(correos).not.toContain('admin@splg.com');
    await darDeBajaEnBase(ds.manager, pruebas);
    const bajas = await consultar<{ firebase_uid: string | null }>(
      `SELECT firebase_uid FROM "user" WHERE "deletedAt" IS NOT NULL`,
    );
    expect(bajas.length).toBe(pruebas.length);
    expect(bajas.every((b) => b.firebase_uid === null)).toBe(true);
  });

  it('borrar otras distribuidoras exige confirmación exacta y, sin ella, no cambia nada', async () => {
    const antes = await conteos();
    for (const confirmacion of ['', 'otra-cosa', 'gas-andino,demo']) {
      await expect(
        correr('scripts/seed-demo.ts', {
          CONFIRMAR_DISTRIBUIDORAS: confirmacion,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(
          /CONFIRMAR_DISTRIBUIDORAS=gas-andino[\s\S]*No se cambió nada/,
        ) as unknown,
      });
    }
    expect(await conteos()).toEqual(antes);
    const [{ n }] = await consultar<{ n: string }>(
      `SELECT count(*) AS n FROM distributor WHERE slug = 'gas-andino'`,
    );
    expect(Number(n)).toBe(1);
  }, 300000);

  it('primera corrida: purga lo de prueba y siembra la demo', async () => {
    salida1 = await correr('scripts/seed-demo.ts');
    conteos1 = await conteos();
    expect(salida1).toContain('Conciliación de stock: consistente');

    // Las filas de prueba ya no están.
    const nombres = await consultar<{ n: string }>(
      `SELECT business_name AS n FROM supplier UNION ALL SELECT name FROM warehouse
       UNION ALL SELECT type FROM gas_cylinder UNION ALL SELECT car_patent FROM car`,
    );
    expect(nombres.filter((f) => PRUEBA.test(f.n))).toEqual([]);

    // Cada módulo quedó con datos.
    for (const [tabla, minimo] of Object.entries({
      gas_cylinder: 5,
      customer: 30,
      user_address: 30,
      delivery: 5,
      car: 6,
      vehicle_assignment: 6,
      employee: 14,
      job_position: 6,
      order: 300,
      order_item: 300,
      order_status_history: 300,
      payment: 30,
      claims: 5,
      incident: 5,
      rating: 20,
      cylinder: 100,
      warehouse: 2,
      stock_threshold: 4,
      stock_movement: 300,
      stock_adjustment: 4,
      supplier: 4,
      purchase_order: 7,
      purchase_receipt: 4,
      truck_load: 4,
      truck_load_item: 4,
      maintenance_plan: 4,
      maintenance_task: 10,
      vehicle_usage_log: 30,
      attachment: 2,
      audit: 20,
      audit_log: 20,
    })) {
      expect({ tabla, filas: conteos1[tabla] >= minimo }).toEqual({
        tabla,
        filas: true,
      });
    }
  }, 300000);

  it('ningún texto visible dice prueba, test, e2e, ajeno, hola o postman', async () => {
    // Columnas de texto con contenido legible (no ids, claves, hashes ni rutas).
    const columnas = await consultar<{ t: string; c: string }>(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('character varying', 'text')
          AND table_name NOT IN ('migrations', 'spatial_ref_sys', 'storage_orphan', 'geography_columns', 'geometry_columns')
          AND column_name !~* '(key|_id$|^id$|uid|hash|token|code|^ip$|path|url|external_reference|gateway|serial|cbu|mime|original_name|selfie|entity|resource|http_method|client_source|actor_role)'`,
    );
    expect(columnas.length).toBeGreaterThan(50);
    const sucias: string[] = [];
    for (const { t, c } of columnas) {
      const [{ n }] = await consultar<{ n: string }>(
        `SELECT count(*) AS n FROM "${t}" WHERE "${c}" ~* '(prueba|test|e2e|ajeno|hola|postman)'`,
      );
      if (Number(n) > 0) sucias.push(`${t}.${c} (${n})`);
    }
    expect(sucias).toEqual([]);

    // Y las cuentas de prueba ya no están en la base.
    const cuentas = await consultar<{ email: string }>(
      `SELECT email FROM "user" WHERE email ~* '(splg-test|^qa\\.|^prueba\\.|^ajeno|^cobro\\.|^qr-prueba)'`,
    );
    expect(cuentas).toEqual([]);
  });

  it('la conciliación de stock da consistente (servicio real) y cierra la cuenta', async () => {
    const servicio = new StockReconciliationService(
      ds,
      new OrderLookupService(ds.getRepository(Order)),
      new StockOnHandService(),
    );
    const r = await servicio.conciliar(distId);
    expect(r.consistent).toBe(true);
    expect(r.deliveriesWithoutMovement).toEqual([]);
    expect(r.cylinders.length).toBe(5);
    for (const c of r.cylinders) {
      expect(c.difference).toBe(0);
      expect(c.overReserved).toBe(0);
      expect(c.deficitDifference).toBe(0);
      // vendible − déficit = llenas − reservadas
      expect(c.sellable - c.reservationDeficit).toBe(
        c.physicalFull - c.reserved,
      );
      expect(c.physicalFull).toBeGreaterThan(0);
    }
    // Todos los renglones entregados descontaron el físico por el libro.
    const [{ n }] = await consultar<{ n: string }>(
      `SELECT count(*) AS n FROM stock_movement WHERE reason = 'delivery'`,
    );
    expect(Number(n)).toBeGreaterThan(150);
  });

  it('las cuentas con login se conservan, con nombre real', async () => {
    const despues = await consultar<{
      user_id: string;
      firebase_uid: string;
      full_name: string;
      email: string;
    }>(
      `SELECT user_id, firebase_uid, full_name, email FROM "user"
        WHERE firebase_uid IS NOT NULL ORDER BY email`,
    );
    expect(despues.map((u) => [u.user_id, u.firebase_uid])).toEqual(
      loginAntes.map((u) => [u.user_id, u.firebase_uid]),
    );
    for (const c of CUENTAS_CON_LOGIN) {
      expect(despues.find((u) => u.email === c.email)?.full_name).toBe(
        c.fullName,
      );
    }
    // El chofer con login sigue siendo chofer de la distribuidora, con vehículo y legajo.
    const [ficha] = await consultar<{ patente: string; legajo: string }>(
      `SELECT c.car_patent AS patente, e.file_number AS legajo
         FROM "user" u JOIN delivery d ON d.user_id = u.user_id
         JOIN vehicle_assignment va ON va.delivery_id = d.delivery_id AND va.released_at IS NULL
         JOIN car c ON c.car_id = va.car_id
         JOIN employee e ON e.user_id = u.user_id
        WHERE u.email = 'chofer@splg.com'`,
    );
    expect(ficha.patente).toMatch(/^[A-Z]{2}\d{3}[A-Z]{2}$/);
    expect(ficha.legajo).toMatch(/^L-\d{4}$/);
  });

  it('hay pedidos de todos los estados y medios de pago, con cobros resueltos', async () => {
    const estados = await consultar<{ status: string }>(
      `SELECT DISTINCT status FROM "order"`,
    );
    expect(estados.map((e) => e.status).sort()).toEqual([
      'accepted',
      'cancelled',
      'delivered',
      'on_the_way',
      'pending',
      'reserved',
    ]);
    const medios = await consultar<{ m: string; s: string }>(
      `SELECT DISTINCT "paymentMethod" AS m, "paymentStatus" AS s FROM "order" WHERE status = 'delivered'`,
    );
    const set = new Set(medios.map((x) => `${x.m}/${x.s}`));
    for (const esperado of ['cash/paid', 'transfer/paid', 'mercadopago/paid']) {
      expect(set).toContain(esperado);
    }
    // Un cobro en efectivo que el chofer no hizo y el administrador resolvió.
    const [{ n }] = await consultar<{ n: string }>(
      `SELECT count(*) AS n FROM "order" WHERE payment_resolved_by IS NOT NULL`,
    );
    expect(Number(n)).toBeGreaterThan(0);
    // Cargas: rendidas, una con diferencia, una abierta del día.
    const cargas = await consultar<{ status: string }>(
      `SELECT status FROM truck_load`,
    );
    const porEstado = new Set(cargas.map((c) => c.status));
    expect(porEstado).toContain('closed');
    expect(porEstado).toContain('closed_with_difference');
    expect(porEstado).toContain('on_route');
    // Compras: recibida, con faltante, parcial, enviada, borrador y cancelada.
    const ordenes = await consultar<{ status: string }>(
      `SELECT DISTINCT status FROM purchase_order`,
    );
    expect(ordenes.map((o) => o.status).sort()).toEqual([
      'cancelled',
      'closed_short',
      'draft',
      'partially_received',
      'received',
      'sent',
    ]);
  });

  it('segunda corrida: mismo resultado y S3 sólo se purga bajo el prefijo de la demo', async () => {
    const llavesAntes = await consultar<{ k: string }>(
      `SELECT photo_key AS k FROM gas_cylinder WHERE photo_key IS NOT NULL`,
    );
    const salida2 = await correr('scripts/seed-demo.ts');
    expect(salida2).toContain('Conciliación de stock: consistente');
    const conteos2 = await conteos();
    expect(conteos2).toEqual(conteos1);

    // Las fotos de la corrida anterior ya no están; las nuevas sí.
    for (const { k } of llavesAntes)
      expect(await existeEnBucket(k)).toBe(false);
    const nuevas = await consultar<{ k: string }>(
      `SELECT photo_key AS k FROM gas_cylinder WHERE photo_key IS NOT NULL`,
    );
    expect(nuevas.length).toBeGreaterThan(0);
    for (const { k } of nuevas) expect(await existeEnBucket(k)).toBe(true);

    // El objeto de la demo anterior se borró; el que estaba fuera del prefijo, no.
    expect(await existeEnBucket(`claims/${distId}/viejo/foto.png`)).toBe(false);
    for (const k of CANARIOS_DE_S3) expect(await existeEnBucket(k)).toBe(true);

    expect(await huerfanos()).toEqual([]);
    // El remito de una recepción quedó como adjunto (privado, cifrado) en S3.
    const [{ n }] = await consultar<{ n: string }>(
      `SELECT count(*) AS n FROM attachment WHERE owner_type = 'purchase_receipt'`,
    );
    expect(Number(n)).toBeGreaterThan(0);
  }, 300000);

  it('fotos:demo completa personas y legajos, y una tercera corrida no deja objetos huérfanos', async () => {
    await correr('scripts/completar-fotos-demo.ts');
    const personas = await consultar<{ k: string | null }>(
      `SELECT photo_key AS k FROM "user"
        WHERE email IN ('admin@splg.com', 'cliente@splg.com', 'chofer@splg.com')`,
    );
    expect(personas.every((p) => p.k !== null)).toBe(true);
    for (const { k } of personas) expect(await existeEnBucket(k!)).toBe(true);
    const [{ n }] = await consultar<{ n: string }>(
      `SELECT count(*) AS n FROM employee WHERE photo_key IS NOT NULL`,
    );
    expect(Number(n)).toBeGreaterThan(5);
    expect(await huerfanos()).toEqual([]);

    // Sembrar de nuevo borra las fotos de las personas y legajos sembrados antes.
    const conFoto = await consultar<{ k: string }>(
      `SELECT photo_key AS k FROM employee WHERE photo_key IS NOT NULL`,
    );
    await correr('scripts/seed-demo.ts');
    for (const { k } of conFoto) expect(await existeEnBucket(k)).toBe(false);
    expect(await huerfanos()).toEqual([]);
    for (const k of CANARIOS_DE_S3) expect(await existeEnBucket(k)).toBe(true);
  }, 300000);

  it('los usuarios huérfanos se listan y no se tocan, salvo CONFIRMAR_HUERFANOS exacto', async () => {
    const existe = async () =>
      Number(
        (
          await consultar<{ n: string }>(
            `SELECT count(*) AS n FROM "user" WHERE email = 'suelta@correo.com.ar' AND "deletedAt" IS NULL`,
          )
        )[0].n,
      );
    expect(await existe()).toBe(1);
    // Sin confirmación (o con una cantidad equivocada): se lista y sobrevive.
    for (const confirmacion of ['', '99']) {
      const salida = await correr('scripts/seed-demo.ts', {
        CONFIRMAR_HUERFANOS: confirmacion,
      });
      expect(salida).toContain('suelta@correo.com.ar');
      expect(await existe()).toBe(1);
    }
    // Con la cantidad exacta: se quita.
    const [{ n }] = await consultar<{ n: string }>(
      `SELECT count(*) AS n FROM "user" u WHERE u.firebase_uid IS NULL AND u."deletedAt" IS NULL
         AND NOT EXISTS (SELECT 1 FROM customer c WHERE c.user_id = u.user_id)
         AND NOT EXISTS (SELECT 1 FROM delivery c WHERE c.user_id = u.user_id)
         AND NOT EXISTS (SELECT 1 FROM employee c WHERE c.user_id = u.user_id)
         AND NOT EXISTS (SELECT 1 FROM car c WHERE c.user_id = u.user_id)
         AND NOT EXISTS (SELECT 1 FROM "order" c WHERE c.customer_id = u.user_id)`,
    );
    await correr('scripts/seed-demo.ts', { CONFIRMAR_HUERFANOS: n });
    expect(await existe()).toBe(0);
  }, 300000);

  it('un usuario sin login con pedido en la demo y rol de admin global conserva ese rol', async () => {
    const [{ role_id: rolC }] = await consultar<{ role_id: string }>(
      `SELECT role_id FROM role WHERE type = 'customer'`,
    );
    const [{ user_id: u }] = await consultar<{ user_id: string }>(
      `INSERT INTO "user" (role_id, full_name, email, phone_number)
       VALUES ($1, 'Rosa Admin Global', 'rosa.global@correo.com.ar', '+5493764008888') RETURNING user_id`,
      [rolC],
    );
    await ds.query(`INSERT INTO customer (user_id) VALUES ($1)`, [u]);
    await ds.query(
      `INSERT INTO admin (distributor_id, user_id) VALUES (NULL, $1)`,
      [u],
    );
    const [{ address_id: dir }] = await consultar<{ address_id: string }>(
      `INSERT INTO user_address (user_id, street, city, "postalCode", location, "formattedAddress", "isDefault")
       VALUES ($1, 'Calle 9', 'Posadas', '3300', ST_SetSRID(ST_MakePoint(-55.9, -27.4), 4326), 'Calle 9, Posadas', true) RETURNING address_id`,
      [u],
    );
    const chofer1000 = await sembrarChoferDeFixture(ds, distId);
    await ds.query(
      `INSERT INTO "order" (distributor_id, customer_id, address_id, status, "paymentMethod", "totalAmount", subtotal_items,
                            delivery_id, "acceptedAt", "onTheWayAt", "deliveredAt")
       VALUES ($1, $2, $3, 'delivered', 'cash', 1000, 1000, $4, now(), now(), now())`,
      [distId, u, dir, chofer1000.deliveryId],
    );
    await correr('scripts/seed-demo.ts');
    const [r] = await consultar<{ usuario: string; admin: string }>(
      `SELECT (SELECT count(*) FROM "user" WHERE user_id = $1 AND "deletedAt" IS NULL) AS usuario,
              (SELECT count(*) FROM admin WHERE user_id = $1 AND distributor_id IS NULL) AS admin`,
      [u],
    );
    expect(Number(r.usuario)).toBe(1);
    expect(Number(r.admin)).toBe(1);
  }, 300000);

  it('la lista blanca: las únicas cuentas con login son las 6 conocidas, ninguna archivada, y el superadmin tiene su fila en admin', async () => {
    const logins = await consultar<{ email: string; archivado: boolean }>(
      `SELECT email, "deletedAt" IS NOT NULL AS archivado FROM "user"
        WHERE firebase_uid IS NOT NULL ORDER BY email`,
    );
    expect(logins.map((l) => l.email)).toEqual(
      CUENTAS_CON_LOGIN.map((c) => c.email).sort(),
    );
    expect(logins.filter((l) => l.archivado)).toEqual([]);
    // Las cuentas de prueba que ningún patrón atrapa no usan la demo ni existen activas.
    const sobrantes = await consultar<{ n: string }>(
      `SELECT count(*) AS n FROM "user" WHERE "deletedAt" IS NULL
        AND email IN ('cliente.ajeno@splg.com', 'chofer.test@splg.com')`,
    );
    expect(Number(sobrantes[0].n)).toBe(0);
    const [{ n: pedidosDeSobrantes }] = await consultar<{ n: string }>(
      `SELECT count(*) AS n FROM "order" o JOIN "user" u ON u.user_id = o.customer_id
        WHERE u.firebase_uid IS NOT NULL AND NOT (u.email = ANY($1::text[]))`,
      [CUENTAS_CON_LOGIN.map((c) => c.email)],
    );
    expect(Number(pedidosDeSobrantes)).toBe(0);
    const [sa] = await consultar<{ distributor_id: string | null }>(
      `SELECT a.distributor_id FROM admin a JOIN "user" u ON u.user_id = a.user_id
        WHERE u.email = 'superadmin@splg.com'`,
    );
    expect(sa).toBeDefined();
    expect(sa.distributor_id).toBeNull();
    // El administrador que firma es admin@splg.com, explícito.
    const [adm] = await consultar<{ user_id: string }>(
      `SELECT user_id FROM "user" WHERE email = 'admin@splg.com'`,
    );
    const firmantes = await consultar<{ u: string }>(
      `SELECT DISTINCT created_by_user_id AS u FROM stock_adjustment
       UNION SELECT DISTINCT created_by_user_id FROM purchase_order
       UNION SELECT DISTINCT user_id FROM audit WHERE user_id IS NOT NULL`,
    );
    expect(firmantes.map((f) => f.u)).toEqual([adm.user_id]);
  });

  it('la demo es coherente: fechas, reservas, cancelados, bloqueos, auditoría y correos', async () => {
    const cuenta = async (sql: string) =>
      Number((await consultar<{ n: string }>(sql))[0].n);
    // Envases: nunca se mueven antes de que exista su pedido.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM cylinder_movement m JOIN "order" o ON o.order_id = m.order_id
          WHERE m."createdAt" < o."createdAt"`,
      ),
    ).toBe(0);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM cylinder_movement m JOIN cylinder c USING (cylinder_id)
          WHERE m."createdAt" < c."createdAt"`,
      ),
    ).toBe(0);
    // Reservas: la seña está paga si y sólo si su pago está aprobado.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM "order" o JOIN payment p ON p.order_id = o.order_id
          WHERE o.status = 'reserved' AND o.deposit_paid <> (p.status = 'approved')`,
      ),
    ).toBe(0);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM "order" WHERE status = 'reserved'`,
      ),
    ).toBeGreaterThan(0);
    // Cancelados: el pedido no se actualizó antes de su cancelación.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM "order" o JOIN order_status_history h
           ON h.order_id = o.order_id AND h.to_status = 'cancelled'
          WHERE o."updatedAt" < h.changed_at`,
      ),
    ).toBe(0);
    // Precio: la auditoría del cambio es anterior a todos los pedidos y su valor nuevo es el vigente.
    const cambios = await consultar<{
      nuevo: string;
      gc: string;
      cuando: Date;
    }>(
      `SELECT d.new_value AS nuevo, a.record_id AS gc, a.created_at AS cuando
         FROM audit a JOIN audit_detail d USING (audit_id)
        WHERE a.entity = 'GasCylinder' AND d.field = 'price'`,
    );
    expect(cambios.length).toBeGreaterThan(0);
    const [{ primero }] = await consultar<{ primero: Date }>(
      `SELECT min("createdAt") AS primero FROM "order"`,
    );
    for (const c of cambios) {
      expect(c.cuando.getTime()).toBeLessThan(primero.getTime());
      const precios = await consultar<{ p: string }>(
        `SELECT DISTINCT "unitPrice" AS p FROM order_item WHERE gas_cylinder_id = $1`,
        [c.gc],
      );
      expect(precios.map((x) => Number(x.p))).toEqual([Number(c.nuevo)]);
    }
    // Bloqueados: ninguno con un pedido abierto (y hay al menos uno bloqueado).
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM "order" o JOIN "user" u ON u.user_id = o.customer_id
          WHERE u.blocked AND o.status IN ('reserved', 'pending', 'accepted', 'on_the_way')`,
      ),
    ).toBe(0);
    expect(
      await cuenta(`SELECT count(*) AS n FROM "user" WHERE blocked`),
    ).toBeGreaterThan(0);
    // Legajos: el alta en la auditoría es el día de ingreso.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM employee e JOIN audit a
           ON a.entity = 'Employee' AND a.record_id = e.employee_id::text
          WHERE (a.created_at AT TIME ZONE 'UTC')::date <> e.hire_date`,
      ),
    ).toBe(0);
    // Correos verosímiles: nada de @demo.splg.com en la lista de usuarios.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM "user" WHERE email ILIKE '%@demo.splg.com'`,
      ),
    ).toBe(0);
  });

  it('con triggers de sólo escritura intactos tras la purga', async () => {
    const triggers = await consultar<{ t: string; e: string }>(
      `SELECT tgname AS t, tgenabled AS e FROM pg_trigger WHERE tgname IN
         ('stock_movement_inmutable', 'audit_log_inmutable', 'audit_inmutable', 'audit_detail_inmutable')`,
    );
    expect(triggers).toHaveLength(4);
    expect(triggers.every((t) => t.e === 'O')).toBe(true);
  });

  it('con SEED_SINGLE_TENANT=false no toca nada fuera de la distribuidora demo', async () => {
    const cuenta = async (sql: string, p: unknown[] = []) =>
      Number((await consultar<{ n: string }>(sql, p))[0].n);
    const [{ distributor_id: otra }] = await consultar<{
      distributor_id: string;
    }>(
      `INSERT INTO distributor (name, slug) VALUES ('Distribuidora Aparte', 'aparte') RETURNING distributor_id`,
    );
    const [{ role_id: rolC }] = await consultar<{ role_id: string }>(
      `SELECT role_id FROM role WHERE type = 'customer'`,
    );
    const [{ role_id: rolD }] = await consultar<{ role_id: string }>(
      `SELECT role_id FROM role WHERE type = 'delivery'`,
    );
    const usuario = async (
      correo: string,
      nombre: string,
      rol: string,
      uid: string | null,
      tel: string,
    ) =>
      (
        await consultar<{ user_id: string }>(
          `INSERT INTO "user" (role_id, firebase_uid, full_name, email, phone_number)
           VALUES ($1, $2, $3, $4, $5) RETURNING user_id`,
          [rol, uid, nombre, correo, tel],
        )
      )[0].user_id;
    const laura = await usuario(
      'laura@correo.com.ar',
      'Laura Gómez',
      rolC,
      null,
      '+5493764000111',
    );
    const dario = await usuario(
      'dario@correo.com.ar',
      'Darío Sosa',
      rolD,
      null,
      '+5493764000112',
    );
    const suelto = await usuario(
      'suelto@correo.com.ar',
      'Persona Suelta',
      rolC,
      null,
      '+5493764000113',
    );
    const externo = await usuario(
      'externo@aparte.com',
      'Externo Aparte',
      rolD,
      'uid-externo',
      '+5493764000114',
    );
    await ds.query(`INSERT INTO customer (user_id) VALUES ($1), ($2)`, [
      laura,
      suelto,
    ]);
    const [{ address_id: dir }] = await consultar<{ address_id: string }>(
      `INSERT INTO user_address (user_id, street, city, "postalCode", location, "formattedAddress", "isDefault")
       VALUES ($1, 'Calle 1', 'Posadas', '3300', ST_SetSRID(ST_MakePoint(-55.9, -27.4), 4326), 'Calle 1, Posadas', true)
       RETURNING address_id`,
      [laura],
    );
    await ds.query(
      `INSERT INTO delivery (distributor_id, user_id, validated, "isActive") VALUES ($1, $2, true, true), ($1, $3, true, true)`,
      [otra, dario, externo],
    );
    await ds.query(
      `INSERT INTO gas_cylinder (distributor_id, type, weight, price, stock, description, "isActive")
       VALUES ($1, 'Garrafa 10kg Aparte', 10, 15000, 5, 'Garrafa de otra distribuidora', true)`,
      [otra],
    );
    const chofer15000 = await sembrarChoferDeFixture(ds, otra);
    await ds.query(
      `INSERT INTO "order" (distributor_id, customer_id, address_id, status, "paymentMethod", "totalAmount", subtotal_items,
                            delivery_id, "acceptedAt", "onTheWayAt", "deliveredAt")
       VALUES ($1, $2, $3, 'delivered', 'cash', 15000, 15000, $4, now(), now(), now())`,
      [otra, laura, dir, chofer15000.deliveryId],
    );
    await ds.query(
      `INSERT INTO audit (action_type_id, user_id, distributor_id, entity, record_id) VALUES (1, NULL, NULL, 'User', $1), (1, NULL, $2, 'Car', 'x')`,
      [laura, otra],
    );
    const [andino] = await consultar<{ user_id: string }>(
      `SELECT user_id FROM "user" WHERE email = 'chofer@gasandino.com'`,
    );
    const [{ address_id: dirAndino }] = await consultar<{
      address_id: string;
    }>(
      `INSERT INTO user_address (user_id, street, city, "postalCode", location, "formattedAddress", "isDefault")
       VALUES ($1, 'Calle Andina 5', 'Posadas', '3300', ST_SetSRID(ST_MakePoint(-55.9, -27.4), 4326), 'Calle Andina 5, Posadas', true)
       RETURNING address_id`,
      [andino.user_id],
    );
    // Clientes sin login y sin pedidos que sólo cuelgan de la otra distribuidora: uno por el
    // vínculo (dado de baja ahí) y otro por su cuenta corriente.
    const vinculado = await usuario(
      'vinculado@correo.com.ar',
      'Cliente Vinculado',
      rolC,
      null,
      '+5493764000115',
    );
    const conCuenta = await usuario(
      'concuenta@correo.com.ar',
      'Cliente Con Cuenta',
      rolC,
      null,
      '+5493764000116',
    );
    await ds.query(`INSERT INTO customer (user_id) VALUES ($1), ($2)`, [
      vinculado,
      conCuenta,
    ]);
    await ds.query(
      `INSERT INTO customer_distributor (user_id, distributor_id, removed_at) VALUES ($1, $2, now())`,
      [vinculado, otra],
    );
    const [{ v: condicion }] = await consultar<{ v: string }>(
      `SELECT enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'customer_account_tax_condition_enum' ORDER BY enumsortorder LIMIT 1`,
    );
    await ds.query(
      `INSERT INTO customer_account (distributor_id, customer_user_id, business_name, tax_condition)
       VALUES ($1, $2, 'Comercio Aparte', $3)`,
      [otra, conCuenta, condicion],
    );
    // El vínculo de una cuenta con login con la distribuidora demo (y su baja) se conserva.
    const [{ user_id: clienteLogin }] = await consultar<{ user_id: string }>(
      `SELECT user_id FROM "user" WHERE email = 'cliente@splg.com'`,
    );
    await ds.query(
      `INSERT INTO customer_distributor (user_id, distributor_id, removed_at) VALUES ($1, $2, '2026-01-02T10:00:00Z')`,
      [clienteLogin, distId],
    );
    const antes = {
      // dario, externo y el chofer del pedido (`sembrarChoferDeFixture`).
      choferesOtra: await cuenta(
        `SELECT count(*) AS n FROM delivery WHERE distributor_id = $1`,
        [otra],
      ),
      auditNula: await cuenta(
        `SELECT count(*) AS n FROM audit WHERE distributor_id IS NULL`,
      ),
      auditOtra: await cuenta(
        `SELECT count(*) AS n FROM audit WHERE distributor_id = $1`,
        [otra],
      ),
      usuariosSinLogin: await cuenta(
        `SELECT count(*) AS n FROM "user" WHERE firebase_uid IS NULL AND "deletedAt" IS NULL AND email IN ('laura@correo.com.ar','dario@correo.com.ar','suelto@correo.com.ar')`,
      ),
    };
    expect(antes.auditNula).toBeGreaterThan(0);

    const salida = await correr('scripts/seed-demo.ts', {
      SEED_SINGLE_TENANT: 'false',
      CONFIRMAR_DISTRIBUIDORAS: '',
    });
    expect(salida).toContain('Conciliación de stock: consistente');

    // La otra distribuidora y todo lo suyo siguen ahí.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM distributor WHERE slug = 'aparte'`,
      ),
    ).toBe(1);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM gas_cylinder WHERE distributor_id = $1`,
        [otra],
      ),
    ).toBe(1);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM "order" WHERE distributor_id = $1`,
        [otra],
      ),
    ).toBe(1);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM delivery WHERE distributor_id = $1`,
        [otra],
      ),
    ).toBe(antes.choferesOtra);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM user_address WHERE address_id = $1`,
        [dir],
      ),
    ).toBe(1);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM audit WHERE distributor_id = $1`,
        [otra],
      ),
    ).toBe(antes.auditOtra);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM audit WHERE distributor_id IS NULL`,
      ),
    ).toBe(antes.auditNula);
    // Una dirección sin pedidos de una cuenta de Gas Andino (lista blanca) sobrevive.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM user_address WHERE address_id = $1`,
        [dirAndino],
      ),
    ).toBe(1);
    // Sus personas, con y sin login, no se borraron ni se archivaron.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM "user" WHERE firebase_uid IS NULL AND "deletedAt" IS NULL AND email IN ('laura@correo.com.ar','dario@correo.com.ar','suelto@correo.com.ar')`,
      ),
    ).toBe(antes.usuariosSinLogin);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM "user" WHERE email = 'externo@aparte.com' AND firebase_uid = 'uid-externo' AND "deletedAt" IS NULL`,
      ),
    ).toBe(1);
    // Los clientes sin login de la otra distribuidora siguen ahí, sin archivar, con su vínculo y su cuenta.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM "user" WHERE "deletedAt" IS NULL AND email IN ('vinculado@correo.com.ar','concuenta@correo.com.ar')`,
      ),
    ).toBe(2);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM customer_distributor WHERE user_id = $1 AND distributor_id = $2 AND removed_at IS NOT NULL`,
        [vinculado, otra],
      ),
    ).toBe(1);
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM customer_account WHERE customer_user_id = $1 AND distributor_id = $2`,
        [conCuenta, otra],
      ),
    ).toBe(1);
    // El alta y la baja del cliente con login en la demo no se pierden.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM customer_distributor WHERE user_id = $1 AND distributor_id = $2 AND removed_at = '2026-01-02T10:00:00Z'`,
        [clienteLogin, distId],
      ),
    ).toBe(1);
    // Y la demo se regeneró igual.
    expect(
      await cuenta(
        `SELECT count(*) AS n FROM "order" WHERE distributor_id = $1`,
        [distId],
      ),
    ).toBeGreaterThan(300);
  }, 300000);
});
