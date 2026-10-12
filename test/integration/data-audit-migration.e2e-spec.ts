/**
 * La migración de la auditoría de datos contra un Postgres de cero: el
 * esquema que arma coincide con las entidades, siembra el catálogo, las tablas
 * son de sólo escritura (trigger) y se puede deshacer.
 */
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

describe('Migración AuditoriaDeDatos (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_test')
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
    await ds.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await ds.runMigrations();
  }, 240000);

  afterAll(async () => {
    await ds.destroy();
    await pg.stop();
  });

  const nombres = async () =>
    (
      await ds.query<Array<{ name: string }>>(
        'SELECT name FROM audit_action_type ORDER BY action_type_id',
      )
    ).map((r) => r.name);

  it('el esquema de las migraciones coincide con las entidades (sin diff)', async () => {
    const sql = await ds.driver.createSchemaBuilder().log();
    expect(sql.upQueries.map((q) => q.query)).toEqual([]);
  });

  it('siembra el catálogo con ids fijos', async () => {
    expect(await nombres()).toEqual([
      'Alta',
      'Modificación',
      'Baja lógica',
      'Reactivación',
      'Baja física',
    ]);
  });

  describe('inmutabilidad', () => {
    let auditId: string;
    let detailId: string;
    let userId: string;

    beforeAll(async () => {
      userId = randomUUID();
      auditId = randomUUID();
      await ds.query(
        `INSERT INTO "user" ("user_id", "email") VALUES ($1, $2)`,
        [userId, `${userId}@test.local`],
      );
      await ds.query(
        `INSERT INTO audit (audit_id, action_type_id, user_id, entity, record_id) VALUES ($1, 1, $2, 'X', '1')`,
        [auditId, userId],
      );
      const [d] = await ds.query<Array<{ audit_detail_id: string }>>(
        `INSERT INTO audit_detail (audit_id, field, new_value) VALUES ($1, 'f', 'v') RETURNING audit_detail_id`,
        [auditId],
      );
      detailId = d.audit_detail_id;
    });

    it.each([
      ['UPDATE de audit', `UPDATE audit SET entity = 'Y'`],
      ['DELETE de audit', `DELETE FROM audit`],
      ['UPDATE de audit_detail', `UPDATE audit_detail SET new_value = 'z'`],
      ['DELETE de audit_detail', `DELETE FROM audit_detail`],
      ['UPDATE manual que vacía user_id', `UPDATE audit SET user_id = NULL`],
      [
        'UPDATE manual que vacía distributor_id',
        `UPDATE audit SET distributor_id = NULL`,
      ],
    ])('%s falla', async (_n, sql) => {
      await expect(ds.query(sql)).rejects.toThrow(/sólo escritura/);
    });

    it('un detalle no se puede borrar con su auditoría (RESTRICT)', async () => {
      await expect(
        ds.query(`DELETE FROM audit WHERE audit_id = $1`, [auditId]),
      ).rejects.toThrow();
      const det = await ds.query<unknown[]>(
        `SELECT 1 FROM audit_detail WHERE audit_detail_id = $1`,
        [detailId],
      );
      expect(det).toHaveLength(1);
    });

    it('borrar al usuario sólo vacía la referencia, la auditoría queda', async () => {
      await ds.query(`DELETE FROM "user" WHERE user_id = $1`, [userId]);
      const [fila] = await ds.query<
        Array<{ user_id: string | null; entity: string }>
      >(`SELECT user_id, entity FROM audit WHERE audit_id = $1`, [auditId]);
      expect(fila).toEqual({ user_id: null, entity: 'X' });
    });
  });

  it('se puede deshacer y volver a aplicar', async () => {
    // Se deshace desde la última hacia atrás hasta sacar la de auditoría, sin
    // depender de cuántas migraciones posteriores haya.
    const auditoriaExiste = async () => {
      const [{ existe }] = await ds.query<Array<{ existe: boolean }>>(
        `SELECT to_regclass('public.audit') IS NOT NULL AS existe`,
      );
      return existe;
    };
    for (let i = 0; i < 50 && (await auditoriaExiste()); i++) {
      await ds.undoLastMigration();
    }
    const [{ existe }] = await ds.query<Array<{ existe: boolean }>>(
      `SELECT to_regclass('public.audit') IS NOT NULL AS existe`,
    );
    expect(existe).toBe(false);
    const [{ funcion }] = await ds.query<Array<{ funcion: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'audit_datos_inmutable') AS funcion`,
    );
    expect(funcion).toBe(false);
    await ds.runMigrations();
    expect(await nombres()).toHaveLength(5);
  });
});
