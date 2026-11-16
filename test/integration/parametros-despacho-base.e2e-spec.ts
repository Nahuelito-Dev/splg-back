import { randomUUID } from 'crypto';
import { join } from 'path';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

/**
 * Las reglas que la base impone a los parámetros del despacho (CU-171, CU-013),
 * con el esquema que dejan las migraciones. Los valores se escriben directo,
 * sin pasar por el servicio.
 */
describe('Parámetros del despacho en la base (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;
  let distributorId: string;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_despacho')
      .withUsername('test')
      .withPassword('test')
      .start();
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
    await ds.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await ds.runMigrations();
    distributorId = randomUUID();
    await ds.query(
      `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'Dist', $2)`,
      [distributorId, `d-${distributorId.slice(0, 8)}`],
    );
  }, 240000);

  afterAll(async () => {
    await ds.destroy();
    await pg.stop();
  });

  const escribir = (params: object) =>
    ds
      .query(
        `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'dispatch', $2::jsonb)
         ON CONFLICT (distributor_id, module) DO UPDATE SET params = EXCLUDED.params`,
        [distributorId, JSON.stringify(params)],
      )
      .then(
        () => 'guardó',
        (err: Error) => err.message,
      );

  it.each([
    { finishingRadiusMeters: -1 },
    { finishingRadiusMeters: 5001 },
    { finishingRadiusMeters: 10.5 },
    { finishingRadiusMeters: '300' },
    { offerTtlSeconds: 9 },
    { offerTtlSeconds: 301 },
    { offerTtlSeconds: 30.5 },
    { radiusStepsKm: [] },
    { radiusStepsKm: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { radiusStepsKm: 'x' },
    { noDriverExpiryMinutes: 0 },
    { noDriverExpiryMinutes: 1441 },
    { noDriverExpiryMinutes: 30.5 },
    { noDriverExpiryMinutes: '120' },
  ])('rechaza %j (CHK_module_config_despacho)', async (params) => {
    expect(await escribir(params)).toContain('CHK_module_config_despacho');
  });

  it.each([
    {},
    { finishingRadiusMeters: 0 },
    { finishingRadiusMeters: 5000, offerTtlSeconds: 10 },
    { radiusStepsKm: [5, 10, 15, 20], offerTtlSeconds: 300 },
    { noDriverExpiryMinutes: 1 },
    { noDriverExpiryMinutes: 1440 },
  ])('acepta %j', async (params) => {
    expect(await escribir(params)).toBe('guardó');
  });

  it('no toca a los otros procesos: lo suyo sigue validándose aparte', async () => {
    const resultado = await ds
      .query(
        `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'scheduled_tasks', '{"finishingRadiusMeters": -1}'::jsonb)`,
        [distributorId],
      )
      .then(
        () => 'guardó',
        (err: Error) => err.message,
      );
    expect(resultado).not.toContain('CHK_module_config_despacho');
  });
});
