/**
 * La migración de la auditoría de datos contra un Postgres de cero: el
 * esquema que arma coincide con las entidades, siembra el catálogo, las tablas
 * son de sólo escritura (trigger) y se puede deshacer.
 */
import { TABLAS_EXCLUIDAS } from '../../src/audit/data/audit-exclusions';
import {
  construirMapa,
  FilaDeCampo,
  FilaDeEntidad,
} from '../../src/audit/data/auditoria-mapa';
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
      migrationsTransactionMode: 'each',
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
      'Ingreso',
      'Ingreso fallido',
      'Salida',
    ]);
  });

  describe('triggers de auditoría (F25)', () => {
    const tablasConTrigger = async () =>
      (
        await ds.query<Array<{ tabla: string }>>(
          `SELECT c.relname AS tabla FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
            WHERE t.tgname = 'TRG_auditoria' AND NOT t.tgisinternal`,
        )
      ).map((r) => r.tabla);

    it('toda tabla de una entidad tiene su trigger, salvo las excluidas', async () => {
      const esperadas = ds.entityMetadatas
        .map((m) => m.tableName)
        .filter((t) => !TABLAS_EXCLUIDAS.has(t));
      const instaladas = new Set(await tablasConTrigger());
      expect(esperadas.filter((t) => !instaladas.has(t))).toEqual([]);
      for (const excluida of TABLAS_EXCLUIDAS) {
        expect(instaladas.has(excluida)).toBe(false);
      }
    });

    it('un cambio por SQL directo queda con usuario nulo, la fecha y el rol de la base', async () => {
      const d = randomUUID();
      await ds.query(
        `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'Trig', $2)`,
        [d, `trig-${d.slice(0, 8)}`],
      );
      await ds.query(
        `UPDATE distributor SET name = 'Trig 2' WHERE distributor_id = $1`,
        [d],
      );
      const filas = await ds.query<
        Array<{
          name: string;
          user_id: string | null;
          source: string;
          table_name: string;
          db_user: string;
          distributor_id: string;
          campos: string;
        }>
      >(
        `SELECT t.name, a.user_id, a.source, a.table_name, a.db_user, a.distributor_id,
                (SELECT string_agg(field || '=' || coalesce(old_value, '') || '>' || coalesce(new_value, ''), ',' ORDER BY field)
                   FROM audit_detail WHERE audit_id = a.audit_id) AS campos
           FROM audit a JOIN audit_action_type t USING (action_type_id)
          WHERE a.entity = 'Distributor' AND a.record_id = $1 ORDER BY a.created_at, t.action_type_id`,
        [d],
      );
      expect(filas.map((f) => f.name)).toEqual(['Alta', 'Modificación']);
      expect(filas[1]).toMatchObject({
        user_id: null,
        source: 'db',
        table_name: 'distributor',
        db_user: 'test',
        distributor_id: d,
        campos: expect.stringContaining('name=Trig>Trig 2') as unknown,
      });
    });

    it('con el actor fijado en la transacción el asiento es de ese usuario, y no se filtra a la siguiente', async () => {
      const u = randomUUID();
      await ds.query(
        `INSERT INTO "user" ("user_id", "email") VALUES ($1, $2)`,
        [u, `${u}@t.local`],
      );
      const d = randomUUID();
      const slug = `trig-${d.slice(0, 8)}`;
      await ds.transaction(async (m) => {
        await m.query(
          `SELECT set_config('splg.user_id', $1, true), set_config('splg.ip', '10.1.1.1', true)`,
          [u],
        );
        await m.query(
          `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'A', $2)`,
          [d, slug],
        );
      });
      await ds.query(
        `UPDATE distributor SET name = 'B' WHERE distributor_id = $1`,
        [d],
      );
      const filas = await ds.query<
        Array<{ user_id: string | null; ip: string | null }>
      >(
        `SELECT user_id, ip FROM audit WHERE entity = 'Distributor' AND record_id = $1 ORDER BY created_at, action_type_id`,
        [d],
      );
      expect(filas).toEqual([
        { user_id: u, ip: '10.1.1.1' },
        { user_id: null, ip: null },
      ]);
    });

    it('baja lógica y reactivación se distinguen por la columna de baja', async () => {
      const d = randomUUID();
      await ds.query(
        `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'BL', $2)`,
        [d, `trig-${d.slice(0, 8)}`],
      );
      const [{ columna }] = await ds.query<Array<{ columna: string | null }>>(
        `SELECT delete_column AS columna FROM audit_entity_map WHERE table_name = 'distributor'`,
      );
      expect(columna).toBe('deletedAt');
      await ds.query(
        `UPDATE distributor SET "deletedAt" = now() WHERE distributor_id = $1`,
        [d],
      );
      await ds.query(
        `UPDATE distributor SET "deletedAt" = NULL WHERE distributor_id = $1`,
        [d],
      );
      const acciones = await ds.query<Array<{ name: string }>>(
        `SELECT t.name FROM audit a JOIN audit_action_type t USING (action_type_id)
          WHERE a.entity = 'Distributor' AND a.record_id = $1 ORDER BY a.created_at, t.action_type_id`,
        [d],
      );
      expect(acciones.map((a) => a.name)).toEqual([
        'Alta',
        'Baja lógica',
        'Reactivación',
      ]);
    });

    it('un UPDATE sin cambios reales no escribe nada', async () => {
      const d = randomUUID();
      await ds.query(
        `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'Igual', $2)`,
        [d, `trig-${d.slice(0, 8)}`],
      );
      await ds.query(
        `UPDATE distributor SET name = 'Igual' WHERE distributor_id = $1`,
        [d],
      );
      const [{ n }] = await ds.query<Array<{ n: string }>>(
        `SELECT count(*) AS n FROM audit WHERE entity = 'Distributor' AND record_id = $1`,
        [d],
      );
      expect(n).toBe('1');
    });
  });

  describe('rondas de revisión de F25', () => {
    it('el mapa cargado en la base coincide con el generado desde las entidades', async () => {
      const esperado = construirMapa(ds.entityMetadatas);
      const entidades = await ds.query<
        Array<Record<string, string | string[] | null>>
      >(`SELECT * FROM audit_entity_map`);
      const campos = await ds.query<
        Array<{
          table_name: string;
          column_name: string;
          property: string;
          secret: boolean;
          kind: string;
          position: number;
        }>
      >(`SELECT * FROM audit_field_map`);
      const porTabla = (a: { table: string }, b: { table: string }) =>
        a.table < b.table ? -1 : a.table > b.table ? 1 : 0;
      const enBase: FilaDeEntidad[] = entidades
        .map((e) => ({
          table: e.table_name as string,
          entity: e.entity as string,
          pk: e.pk_columns as string[],
          deleteColumn: e.delete_column as string | null,
          distributorMode:
            e.distributor_mode as FilaDeEntidad['distributorMode'],
          distributorColumn: e.distributor_column as string | null,
          parentTable: e.parent_table as string | null,
          parentFkColumn: e.parent_fk_column as string | null,
          parentPkColumn: e.parent_pk_column as string | null,
          parentDistributorColumn: e.parent_distributor_column as string | null,
          orderProperty: e.order_property as string | null,
          orderColumn: e.order_column as string | null,
        }))
        .sort(porTabla);
      expect(enBase).toEqual([...esperado.entities].sort(porTabla));
      const clave = (f: { table: string; position: number }) =>
        `${f.table}#${String(f.position).padStart(4, '0')}`;
      const camposEnBase: FilaDeCampo[] = campos
        .map((f) => ({
          table: f.table_name,
          column: f.column_name,
          property: f.property,
          secret: f.secret,
          kind: f.kind as FilaDeCampo['kind'],
          position: f.position,
        }))
        .sort((a, b) => (clave(a) < clave(b) ? -1 : 1));
      expect(camposEnBase).toEqual(
        [...esperado.fields].sort((a, b) => (clave(a) < clave(b) ? -1 : 1)),
      );
    });

    it('borrar una distribuidora con hijas en cascada no rompe y deja el id en el asiento', async () => {
      const d = randomUUID();
      const supplier = randomUUID();
      await ds.query(
        `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'Cascada', $2)`,
        [d, `casc-${d.slice(0, 8)}`],
      );
      // 20-12345678-6: CUIT con dígito verificador válido
      await ds.query(
        `INSERT INTO supplier (supplier_id, distributor_id, business_name, cuit) VALUES ($1, $2, 'Hija', '20123456786')`,
        [supplier, d],
      );
      await ds.query(`DELETE FROM distributor WHERE distributor_id = $1`, [d]);
      const filas = await ds.query<
        Array<{
          entity: string;
          accion: string;
          distributor_id: string | null;
          detalle: string | null;
        }>
      >(
        `SELECT a.entity, t.name AS accion, a.distributor_id,
                (SELECT old_value FROM audit_detail WHERE audit_id = a.audit_id AND field = 'distributorId') AS detalle
           FROM audit a JOIN audit_action_type t USING (action_type_id)
          WHERE a.record_id IN ($1, $2) AND t.name = 'Baja física'
          ORDER BY a.entity`,
        [d, supplier],
      );
      expect(filas).toEqual([
        {
          entity: 'Distributor',
          accion: 'Baja física',
          distributor_id: null,
          detalle: d,
        },
        {
          entity: 'Supplier',
          accion: 'Baja física',
          distributor_id: null,
          detalle: d,
        },
      ]);
    });

    it('un renglón sin distribuidora propia toma la del padre (modo parent)', async () => {
      await ds.query(
        `CREATE TABLE padre_t (id uuid PRIMARY KEY, distributor_id uuid)`,
      );
      await ds.query(
        `CREATE TABLE hijo_t (id uuid PRIMARY KEY, padre_id uuid NOT NULL, v text)`,
      );
      await ds.query(
        `INSERT INTO audit_entity_map (table_name, entity, pk_columns, distributor_mode,
            parent_table, parent_fk_column, parent_pk_column, parent_distributor_column)
         VALUES ('hijo_t', 'HijoT', ARRAY['id'], 'parent', 'padre_t', 'padre_id', 'id', 'distributor_id')`,
      );
      await ds.query(
        `INSERT INTO audit_field_map (table_name, column_name, property, kind, position)
         VALUES ('hijo_t', 'v', 'v', 'text', 0)`,
      );
      await ds.query(`SELECT auditoria_instalar('hijo_t')`);
      const d = randomUUID();
      const padre = randomUUID();
      const hijo = randomUUID();
      await ds.query(
        `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'Padre', $2)`,
        [d, `padre-${d.slice(0, 8)}`],
      );
      await ds.query(`INSERT INTO padre_t VALUES ($1, $2)`, [padre, d]);
      await ds.query(`INSERT INTO hijo_t VALUES ($1, $2, 'x')`, [hijo, padre]);
      const [fila] = await ds.query<Array<{ distributor_id: string }>>(
        `SELECT distributor_id FROM audit WHERE entity = 'HijoT' AND record_id = $1`,
        [hijo],
      );
      expect(fila.distributor_id).toBe(d);
    });

    it('un superusuario con splg.audit_off = on no deja asientos (mantenimiento de los seeds)', async () => {
      const d = randomUUID();
      const qr = ds.createQueryRunner();
      try {
        await qr.query(`SET splg.audit_off = 'on'`);
        await qr.query(
          `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'Sin', $2)`,
          [d, `sin-${d.slice(0, 8)}`],
        );
        await qr.query(`RESET splg.audit_off`);
      } finally {
        await qr.release();
      }
      const [{ n }] = await ds.query<Array<{ n: string }>>(
        `SELECT count(*) AS n FROM audit WHERE entity = 'Distributor' AND record_id = $1`,
        [d],
      );
      expect(n).toBe('0');
    });

    describe('splg.audit_off sólo lo respeta el rol de mantenimiento', () => {
      const conUsuario = async (usuario: string) => {
        const o = ds.options as {
          host: string;
          port: number;
          database: string;
        };
        const conexion = new DataSource({
          type: 'postgres',
          host: o.host,
          port: o.port,
          database: o.database,
          username: usuario,
          password: 'clave',
          synchronize: false,
        });
        await conexion.initialize();
        return conexion;
      };

      beforeAll(async () => {
        await ds.query(`CREATE ROLE u_comun LOGIN PASSWORD 'clave'`);
        await ds.query(`CREATE ROLE u_mant LOGIN PASSWORD 'clave'`);
        await ds.query(`GRANT splg_mantenimiento TO u_mant`);
        await ds.query(
          `GRANT ALL ON ALL TABLES IN SCHEMA public TO u_comun, u_mant`,
        );
      });

      const insertarConAuditOff = async (usuario: string) => {
        const d = randomUUID();
        const conexion = await conUsuario(usuario);
        try {
          const qr = conexion.createQueryRunner();
          await qr.query(`SET splg.audit_off = 'on'`);
          await qr.query(
            `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'Off', $2)`,
            [d, `off-${d.slice(0, 8)}`],
          );
          await qr.release();
        } finally {
          await conexion.destroy();
        }
        const [{ n }] = await ds.query<Array<{ n: string }>>(
          `SELECT count(*) AS n FROM audit WHERE entity = 'Distributor' AND record_id = $1`,
          [d],
        );
        return Number(n);
      };

      it('un usuario común con audit_off = on igual deja asiento', async () => {
        expect(await insertarConAuditOff('u_comun')).toBe(1);
      });

      it('un miembro de splg_mantenimiento con audit_off = on no deja asiento', async () => {
        expect(await insertarConAuditOff('u_mant')).toBe(0);
      });
    });

    it.each([
      ['TRUNCATE audit', 'TRUNCATE "audit" CASCADE'],
      ['TRUNCATE audit_detail', 'TRUNCATE "audit_detail"'],
      ['TRUNCATE en cascada desde user', 'TRUNCATE "user" CASCADE'],
    ])('%s se rechaza', async (_n, sql) => {
      await expect(ds.query(sql)).rejects.toThrow(/sólo escritura/);
    });

    it('revertir la migración y volver a correrla funciona', async () => {
      await ds.undoLastMigration();
      const [{ existe }] = await ds.query<Array<{ existe: boolean }>>(
        `SELECT to_regclass('public.audit_entity_map') IS NOT NULL AS existe`,
      );
      expect(existe).toBe(false);
      await ds.runMigrations();
      const [{ n }] = await ds.query<Array<{ n: string }>>(
        `SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'TRG_auditoria'`,
      );
      expect(Number(n)).toBeGreaterThan(70);
    });
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
    for (let i = 0; i < 300 && (await auditoriaExiste()); i++) {
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
    expect(await nombres()).toHaveLength(8);
  });
});
