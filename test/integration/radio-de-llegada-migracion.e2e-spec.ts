/**
 * La migración `RadioDeLlegada` contra un Postgres con el esquema de antes: el
 * CHECK del despacho valida `arrivalRadiusMeters` (0 a 5000, entero, número),
 * sigue validando lo de antes y la reversa vuelve al CHECK anterior.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

describe('Migración RadioDeLlegada (e2e)', () => {
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
  const indice = todas.findIndex((f) => /-RadioDeLlegada\.ts$/.test(f));
  const anteriores = todas.slice(0, indice);
  const estaYAnteriores = todas.slice(0, indice + 1);

  const dist = randomUUID();
  const guardarDespacho = (params: object) =>
    ds
      .query(
        `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'dispatch', $2::jsonb)
         ON CONFLICT (distributor_id, module) DO UPDATE SET params = EXCLUDED.params`,
        [dist, JSON.stringify(params)],
      )
      .then(
        () => 'guardó',
        (err: Error) => err.message,
      );

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
    await ds.query(
      `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'Dist', 'dist')`,
      [dist],
    );
    // Antes de migrar el CHECK no mira la clave: una configuración vieja con
    // otros parámetros tiene que seguir siendo válida después.
    const previa = await guardarDespacho({
      offerTtlSeconds: 60,
      noDriverExpiryMinutes: 30,
    });
    if (previa !== 'guardó') throw new Error(previa);
    await ds.destroy();

    ds = nuevo(estaYAnteriores);
    await ds.initialize();
    await ds.runMigrations();
  }, 300000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  it('corrió y la configuración que ya existía sigue en pie', async () => {
    const [fila] = await ds.query<Array<{ params: object }>>(
      `SELECT params FROM module_config WHERE distributor_id = $1`,
      [dist],
    );
    expect(fila.params).toEqual({
      offerTtlSeconds: 60,
      noDriverExpiryMinutes: 30,
    });
    expect(indice).toBeGreaterThan(0);
    const filas = await ds.query<Array<{ name: string }>>(
      `SELECT name FROM migrations WHERE name = 'RadioDeLlegada1795000000027'`,
    );
    expect(filas).toHaveLength(1);
  });

  it.each([0, 150, 5000])('acepta el radio de llegada %s', async (m) => {
    expect(await guardarDespacho({ arrivalRadiusMeters: m })).toBe('guardó');
  });

  it.each([-1, 5001, 10.5, '150'])(
    'rechaza el radio de llegada %s',
    async (m) => {
      expect(await guardarDespacho({ arrivalRadiusMeters: m })).toContain(
        'CHK_module_config_despacho',
      );
    },
  );

  it('lo de antes se sigue validando', async () => {
    expect(await guardarDespacho({ noDriverExpiryMinutes: 0 })).toContain(
      'CHK_module_config_despacho',
    );
    expect(await guardarDespacho({ offerTtlSeconds: 9 })).toContain(
      'CHK_module_config_despacho',
    );
  });

  it('la reversa vuelve al CHECK anterior y se puede volver a aplicar', async () => {
    await ds.undoLastMigration();
    expect(await guardarDespacho({ arrivalRadiusMeters: 9999 })).toBe('guardó');
    expect(await guardarDespacho({ offerTtlSeconds: 9 })).toContain(
      'CHK_module_config_despacho',
    );
    expect(await guardarDespacho({ arrivalRadiusMeters: 200 })).toBe('guardó');
    await ds.runMigrations();
    expect(await guardarDespacho({ arrivalRadiusMeters: 9999 })).toContain(
      'CHK_module_config_despacho',
    );
  });
});
