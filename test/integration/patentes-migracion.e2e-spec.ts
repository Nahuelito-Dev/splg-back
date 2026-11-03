/**
 * La migración NormalizarPatentes contra un Postgres con el esquema de ese
 * momento: corre la cadena de migraciones hasta la anterior, carga patentes
 * escritas de cualquier forma (lo que había antes de `CHK_car_patente`) y
 * recién ahí aplica la normalización.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

describe('Migración NormalizarPatentes (e2e)', () => {
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
      // Como `src/data-source.ts`: cada migración en su transacción.
      migrationsTransactionMode: 'each',
    });

  const dir = join(__dirname, '../../src/migrations');
  const todas = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(dir, f));
  const indice = todas.findIndex((f) => /NormalizarPatentes/.test(f));
  const anteriores = todas.slice(0, indice);
  const hastaLaNormalizacion = todas.slice(0, indice + 1);

  const distribuidora = randomUUID();
  const chofer = randomUUID();
  const ids = {
    sucia: randomUUID(),
    choqueA: randomUUID(),
    choqueB: randomUUID(),
    baja: randomUUID(),
  };
  let avisos: string[] = [];

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
      `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'A', 'a')`,
      [distribuidora],
    );
    await ds.query(
      `INSERT INTO "user" ("user_id", "email") VALUES ($1, 'chofer@x.com')`,
      [chofer],
    );
    for (const [id, patente, borrado] of [
      [ids.sucia, 'cd 456-ef', false],
      [ids.choqueA, 'gh 111 ij', false],
      [ids.choqueB, 'GH-111-IJ', false],
      [ids.baja, 'kl 222 mn', true],
    ] as const) {
      await ds.query(
        `INSERT INTO "car" ("car_id", "distributor_id", "user_id", "car_patent", "deletedAt")
         VALUES ($1, $2, $3, $4, $5)`,
        [id, distribuidora, chofer, patente, borrado ? new Date() : null],
      );
    }
    await ds.destroy();

    const advertencias = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      ds = nuevo(hastaLaNormalizacion);
      await ds.initialize();
      await ds.runMigrations();
    } finally {
      avisos = advertencias.mock.calls.map((c) => String(c[0]));
      advertencias.mockRestore();
    }
  }, 300000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  const patente = async (id: string) => {
    const [fila] = await ds.query<Array<{ car_patent: string }>>(
      `SELECT car_patent FROM car WHERE car_id = $1`,
      [id],
    );
    return fila?.car_patent;
  };

  it('normaliza las existentes, también las dadas de baja', async () => {
    expect(await patente(ids.sucia)).toBe('CD456EF');
    expect(await patente(ids.baja)).toBe('KL222MN');
  });

  it('deja sin tocar las que chocarían entre vigentes y lo avisa', async () => {
    expect(await patente(ids.choqueA)).toBe('gh 111 ij');
    expect(await patente(ids.choqueB)).toBe('GH-111-IJ');
    expect(avisos.some((a) => a.includes('GH111IJ'))).toBe(true);
  });
});
