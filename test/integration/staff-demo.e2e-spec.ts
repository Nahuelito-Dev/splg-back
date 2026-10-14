/**
 * `assignStaffToDistributor`: tras la purga de una distribuidora, la cuenta de
 * su staff queda sin perfil y el seed tiene que volver a crearlo.
 */
import { join } from 'path';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { assignStaffToDistributor } from '../../scripts/lib/staff-demo';

const IMAGEN_POSTGIS =
  process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4';

jest.setTimeout(180_000);

describe('assignStaffToDistributor', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;
  let distId: string;

  const contar = async (tabla: 'admin' | 'delivery', email: string) => {
    const filas: { n: string }[] = await ds.query(
      `SELECT count(*) AS n FROM ${tabla} p JOIN "user" u ON u.user_id = p.user_id
        WHERE u.email = $1 AND p.distributor_id = $2`,
      [email, distId],
    );
    return Number(filas[0].n);
  };

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(IMAGEN_POSTGIS)
      .withDatabase('splg_staff_demo')
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
    });
    await ds.initialize();
    await ds.runMigrations();
    for (const type of ['admin', 'delivery']) {
      await ds.query(`INSERT INTO role (type) VALUES ($1)`, [type]);
    }
    [{ distributor_id: distId }] = await ds.query(
      `INSERT INTO distributor (name, slug) VALUES ('Gas Andino', 'gas-andino') RETURNING distributor_id`,
    );
    for (const [email, type, phone] of [
      ['admin@gasandino.com', 'admin', '+5493760000001'],
      ['chofer@gasandino.com', 'delivery', '+5493760000002'],
    ]) {
      await ds.query(
        `INSERT INTO "user" (email, full_name, phone_number, firebase_uid, role_id)
         SELECT $1, 'Staff', $3, $1, role_id FROM role WHERE type = $2`,
        [email, type, phone],
      );
    }
  });

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  it('crea el perfil que falta, admin y chofer', async () => {
    await assignStaffToDistributor(ds, 'admin@gasandino.com', 'admin', distId);
    await assignStaffToDistributor(
      ds,
      'chofer@gasandino.com',
      'delivery',
      distId,
    );
    expect(await contar('admin', 'admin@gasandino.com')).toBe(1);
    expect(await contar('delivery', 'chofer@gasandino.com')).toBe(1);
  });

  it('es idempotente: correrlo de nuevo no duplica el perfil', async () => {
    await assignStaffToDistributor(ds, 'admin@gasandino.com', 'admin', distId);
    await assignStaffToDistributor(
      ds,
      'chofer@gasandino.com',
      'delivery',
      distId,
    );
    expect(await contar('admin', 'admin@gasandino.com')).toBe(1);
    expect(await contar('delivery', 'chofer@gasandino.com')).toBe(1);
  });
});
