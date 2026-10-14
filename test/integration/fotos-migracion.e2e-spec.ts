/**
 * Las migraciones de las fotos (`photo_key` / `logo_key`) corren y se
 * revierten sobre una base vacía en un Postgres efímero, con TODA la cadena
 * de migraciones del repo (no el `synchronize` que usan las demás suites).
 */
import { join } from 'path';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

const IMAGEN_POSTGIS =
  process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4';

const COLUMNAS: Array<[string, string]> = [
  ['user', 'photo_key'],
  ['car', 'photo_key'],
  ['gas_cylinder', 'photo_key'],
  ['distributor', 'logo_key'],
  ['incident', 'photo_key'],
  ['employee', 'photo_key'],
];

describe('migraciones de fotos de entidades (e2e)', () => {
  let contenedor: StartedPostgreSqlContainer;
  let ds: DataSource;

  beforeAll(async () => {
    contenedor = await new PostgreSqlContainer(IMAGEN_POSTGIS)
      .withDatabase('splg_migraciones')
      .withUsername('test')
      .withPassword('test')
      .start();
    ds = new DataSource({
      type: 'postgres',
      host: contenedor.getHost(),
      port: contenedor.getPort(),
      username: contenedor.getUsername(),
      password: contenedor.getPassword(),
      database: contenedor.getDatabase(),
      migrations: [join(__dirname, '../../src/migrations/*.ts')],
      synchronize: false,
    });
    await ds.initialize();
  }, 240000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    await contenedor?.stop();
  });

  async function consultar<T>(sql: string, params: unknown[] = []) {
    const filas: unknown = await ds.query(sql, params);
    return filas as T[];
  }

  async function columna(tabla: string, nombre: string) {
    const filas = await consultar<{ largo: number; nulo: string }>(
      `SELECT character_maximum_length AS largo, is_nullable AS nulo
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [tabla, nombre],
    );
    return filas[0] ?? null;
  }

  it('la cadena completa corre desde cero y deja las columnas varchar(512) nulas', async () => {
    await ds.runMigrations();
    for (const [tabla, nombre] of COLUMNAS) {
      expect(await columna(tabla, nombre)).toEqual({ largo: 512, nulo: 'YES' });
    }
  });

  it('revierte las migraciones de fotos (y las posteriores), conserva el resto y vuelve a correr', async () => {
    const [distribuidora] = await consultar<{ distributor_id: string }>(
      `INSERT INTO "distributor" ("name", "slug", "logo_url")
       VALUES ('Dist', 'dist-mig', 'https://viejo.example/logo.png')
       RETURNING "distributor_id"`,
    );
    await consultar(
      `UPDATE "distributor" SET "logo_key" = 'distributors/x/logo/a.png'`,
    );
    const [puesto] = await consultar<{ position_id: string }>(
      `INSERT INTO "job_position" ("distributor_id", "name", "category")
       VALUES ($1, 'Puesto', 'driver') RETURNING "position_id"`,
      [distribuidora.distributor_id],
    );
    await consultar(
      `INSERT INTO "employee" ("distributor_id", "position_id", "file_number", "first_name", "last_name",
         "document_type", "document_number", "hire_date", "employment_type", "photo_key")
       VALUES ($1, $2, 'L1', 'A', 'B', 'dni', '1', '2026-01-01', 'permanent', 'employees/x/y/b.png')`,
      [distribuidora.distributor_id, puesto.position_id],
    );

    // Revierte desde la última hasta la que crea las fotos (las posteriores,
    // como los índices de auditoría, también salen). El tope es el total de
    // migraciones: cada una nueva que se agregue después no rompe el test.
    const totalDeMigraciones = ds.migrations.length;
    for (
      let i = 0;
      i < totalDeMigraciones && (await columna('user', 'photo_key'));
      i++
    ) {
      await ds.undoLastMigration();
    }
    for (const [tabla, nombre] of COLUMNAS) {
      expect(await columna(tabla, nombre)).toBeNull();
    }
    // Las keys de los objetos van a limpieza: ninguno queda huérfano en S3.
    const huerfanos = await consultar<{ storage_key: string; kind: string }>(
      `SELECT "storage_key", "kind" FROM "storage_orphan" ORDER BY "storage_key"`,
    );
    expect(huerfanos).toEqual([
      { storage_key: 'distributors/x/logo/a.png', kind: 'remove' },
      { storage_key: 'employees/x/y/b.png', kind: 'remove' },
    ]);
    // El texto libre de antes sobrevive al down.
    const [fila] = await consultar<{ logo_url: string }>(
      `SELECT "logo_url" FROM "distributor" WHERE "distributor_id" = $1`,
      [distribuidora.distributor_id],
    );
    expect(fila.logo_url).toBe('https://viejo.example/logo.png');

    await ds.runMigrations();
    for (const [tabla, nombre] of COLUMNAS) {
      expect(await columna(tabla, nombre)).toEqual({ largo: 512, nulo: 'YES' });
    }
    const [vuelve] = await consultar<{
      logo_url: string;
      logo_key: string | null;
    }>(`SELECT "logo_url", "logo_key" FROM "distributor"`);
    expect(vuelve).toEqual({
      logo_url: 'https://viejo.example/logo.png',
      logo_key: null,
    });
  });
});
