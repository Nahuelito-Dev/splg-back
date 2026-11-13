/**
 * Las migraciones de los roles del personal (F37 E1) contra un Postgres con el
 * esquema de antes: corre la cadena hasta la anterior, carga distribuidoras y
 * admins como los que ya hay (uno dado de baja, el super admin sin
 * distribuidora) y recién ahí aplica `RolesDelPersonal`,
 * `AuditoriaDeLosRolesDelPersonal` y `SembrarRolesDelPersonal`.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

describe('Migración RolesDelPersonal (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;

  const nuevo = (migraciones: string[]) =>
    new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
      migrations: migraciones,
      synchronize: false,
      migrationsTransactionMode: 'each',
    });

  const dir = join(__dirname, '../../src/migrations');
  const todas = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(dir, f));
  const indice = todas.findIndex((f) => /-RolesDelPersonal\.ts$/.test(f));
  const anteriores = todas.slice(0, indice);

  const ids = {
    distA: randomUUID(),
    distB: randomUUID(),
    distBaja: randomUUID(),
    rolAdmin: randomUUID(),
    rolSuper: randomUUID(),
  };
  const usuarios = {
    adminA: randomUUID(),
    adminA2: randomUUID(),
    adminB: randomUUID(),
    adminBaja: randomUUID(),
    superAdmin: randomUUID(),
  };

  const rolDe = async (userId: string) => {
    const [fila] = await ds.query<
      Array<{ name: string | null; is_system: boolean | null; dist: string }>
    >(
      `SELECT sr.name, sr.is_system, sr.distributor_id AS dist
         FROM admin a LEFT JOIN staff_role sr ON sr.staff_role_id = a.staff_role_id
        WHERE a.user_id = $1`,
      [userId],
    );
    return fila;
  };

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    ds = nuevo(anteriores);
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await ds.runMigrations();

    for (const [id, slug, baja] of [
      [ids.distA, 'a', false],
      [ids.distB, 'b', false],
      [ids.distBaja, 'baja', true],
    ] as const) {
      await ds.query(
        `INSERT INTO "distributor" ("distributor_id", "name", "slug", "deletedAt") VALUES ($1, $2, $2, $3)`,
        [id, slug, baja ? new Date() : null],
      );
    }
    await ds.query(
      `INSERT INTO "role" ("role_id", "type") VALUES ($1, 'admin'), ($2, 'super_admin')`,
      [ids.rolAdmin, ids.rolSuper],
    );
    const admins: Array<[string, string | null, string, boolean]> = [
      [usuarios.adminA, ids.distA, ids.rolAdmin, false],
      [usuarios.adminA2, ids.distA, ids.rolAdmin, false],
      [usuarios.adminB, ids.distB, ids.rolAdmin, false],
      [usuarios.adminBaja, ids.distBaja, ids.rolAdmin, true],
      [usuarios.superAdmin, null, ids.rolSuper, false],
    ];
    for (const [userId, dist, rol, baja] of admins) {
      await ds.query(
        `INSERT INTO "user" ("user_id", "email", "role_id", "deletedAt") VALUES ($1, $2, $3, $4)`,
        [userId, `${userId}@x.com`, rol, baja ? new Date() : null],
      );
      await ds.query(
        `INSERT INTO "admin" ("user_id", "distributor_id") VALUES ($1, $2)`,
        [userId, dist],
      );
    }
    await ds.destroy();

    ds = nuevo(todas);
    await ds.initialize();
    await ds.runMigrations();
  }, 300000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  it('cada distribuidora existente (también la dada de baja) tiene un único rol de sistema «Administrador» sin lista', async () => {
    const filas = await ds.query<
      Array<{ distributor_id: string; name: string; permissions: string[] }>
    >(
      `SELECT distributor_id, name, permissions FROM staff_role WHERE is_system ORDER BY distributor_id`,
    );
    expect(filas.map((f) => f.distributor_id).sort()).toEqual(
      [ids.distA, ids.distB, ids.distBaja].sort(),
    );
    for (const f of filas) {
      expect(f).toMatchObject({ name: 'Administrador', permissions: [] });
    }
  });

  it('los admins existentes quedan con «Administrador» de su distribuidora; el super admin, sin rol', async () => {
    expect(await rolDe(usuarios.adminA)).toEqual({
      name: 'Administrador',
      is_system: true,
      dist: ids.distA,
    });
    expect((await rolDe(usuarios.adminB))?.dist).toBe(ids.distB);
    expect((await rolDe(usuarios.adminBaja))?.dist).toBe(ids.distBaja);
    expect(await rolDe(usuarios.superAdmin)).toEqual({
      name: null,
      is_system: null,
      dist: null,
    });
  });

  it('la siembra queda en la auditoría (rol creado y admin modificado)', async () => {
    const filas = await ds.query<Array<{ entity: string; n: number }>>(
      `SELECT entity, count(*)::int AS n FROM audit
        WHERE table_name IN ('staff_role', 'admin') AND action_type_id IN (1, 2)
        GROUP BY entity ORDER BY entity`,
    );
    expect(filas).toEqual([
      { entity: 'Admin', n: expect.any(Number) as number },
      { entity: 'StaffRole', n: 3 },
    ]);
  });

  it('una distribuidora nueva nace con su rol de sistema y su primer admin lo recibe', async () => {
    const dist = randomUUID();
    const user = randomUUID();
    await ds.query(
      `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'nueva', 'nueva')`,
      [dist],
    );
    await ds.query(
      `INSERT INTO "user" ("user_id", "email", "role_id") VALUES ($1, 'nuevo@x.com', $2)`,
      [user, ids.rolAdmin],
    );
    await ds.query(
      `INSERT INTO "admin" ("user_id", "distributor_id") VALUES ($1, $2)`,
      [user, dist],
    );
    expect(await rolDe(user)).toMatchObject({
      name: 'Administrador',
      dist,
    });
  });

  it('la base rechaza: admin sin rol, rol de otra distribuidora, segundo rol de sistema, nombre repetido y lista en el de sistema', async () => {
    const [rolB] = await ds.query<Array<{ staff_role_id: string }>>(
      `SELECT staff_role_id FROM staff_role WHERE distributor_id = $1`,
      [ids.distB],
    );
    const intentos: Array<[string, unknown[]]> = [
      [
        `UPDATE admin SET staff_role_id = NULL WHERE user_id = $1`,
        [usuarios.adminA],
      ],
      [
        `UPDATE admin SET staff_role_id = $2 WHERE user_id = $1`,
        [usuarios.adminA, rolB.staff_role_id],
      ],
      [
        `INSERT INTO staff_role (distributor_id, name, is_system) VALUES ($1, 'Otro', true)`,
        [ids.distA],
      ],
      [
        `INSERT INTO staff_role (distributor_id, name) VALUES ($1, 'ADMINISTRADOR')`,
        [ids.distA],
      ],
      [
        `UPDATE staff_role SET permissions = '{pedidos.ver}' WHERE distributor_id = $1`,
        [ids.distA],
      ],
      [
        `INSERT INTO staff_role (distributor_id, name) VALUES ($1, ' x ')`,
        [ids.distA],
      ],
    ];
    const errores: string[] = [];
    for (const [sql, params] of intentos) {
      errores.push(
        await ds.query(sql, params).then(
          () => 'pasó',
          (e: { constraint?: string }) => e.constraint ?? 'sin nombre',
        ),
      );
    }
    expect(errores).toEqual([
      'CHK_admin_rol_de_personal',
      'FK_admin_staff_role_distribuidora',
      'UQ_staff_role_sistema_vigente',
      'UQ_staff_role_nombre_vigente',
      'CHK_staff_role_sistema_sin_lista',
      'CHK_staff_role_nombre',
    ]);
  });

  it('se deshace y se vuelve a aplicar', async () => {
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    await ds.undoLastMigration();
    const [tabla] = await ds.query<Array<{ existe: string | null }>>(
      `SELECT to_regclass('public.staff_role')::text AS existe`,
    );
    expect(tabla.existe).toBeNull();
    await ds.runMigrations();
    expect((await rolDe(usuarios.adminA))?.name).toBe('Administrador');
  });
});
