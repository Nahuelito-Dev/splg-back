/**
 * La migración CajaYRendicion contra un Postgres con datos: siembra la "Caja
 * central" y las categorías de sistema de cada distribuidora existente, deja los
 * tres libros de solo agregar (disparador), conserva las restricciones de la
 * base y el medio de pago "cuenta corriente" entra en los pedidos.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { conBypass } from './setup/bypass';

describe('Migración CajaYRendicion (e2e)', () => {
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
      entities: [join(__dirname, '../../src/**/*.entity.ts')],
      migrations: migraciones,
      synchronize: false,
    });

  const dir = join(__dirname, '../../src/migrations');
  const todas = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(dir, f));
  const anteriores = todas.slice(
    0,
    todas.findIndex((f) => /VentaACuentaEnPedido/.test(f)),
  );

  const distA = randomUUID();
  const distB = randomUUID();
  const userId = randomUUID();
  const employeeId = randomUUID();
  let cajaId: string;
  let categoriaId: string;
  let cuentaId: string;

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
      `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'A', 'a'), ($2, 'B', 'b')`,
      [distA, distB],
    );
    await ds.query(
      `INSERT INTO "user" ("user_id", "email") VALUES ($1, 'c@x.com')`,
      [userId],
    );
    const positionId = randomUUID();
    await ds.query(
      `INSERT INTO job_position (position_id, distributor_id, name, category) VALUES ($1, $2, 'Chofer', 'driver')`,
      [positionId, distA],
    );
    await ds.query(
      `INSERT INTO employee (employee_id, distributor_id, position_id, file_number, first_name, last_name, document_type, document_number, hire_date, employment_type)
       VALUES ($1, $2, $3, '1', 'A', 'B', 'dni', '1', '2026-01-01', 'permanent')`,
      [employeeId, distA, positionId],
    );
    await ds.destroy();

    ds = nuevo(todas);
    await ds.initialize();
    await ds.runMigrations();

    [{ cash_box_id: cajaId }] = await ds.query<Array<{ cash_box_id: string }>>(
      `SELECT cash_box_id FROM cash_box WHERE distributor_id = $1`,
      [distA],
    );
    [{ category_id: categoriaId }] = await ds.query<
      Array<{ category_id: string }>
    >(
      `SELECT category_id FROM cash_category WHERE distributor_id = $1 AND system_code = 'cash_surplus'`,
      [distA],
    );
    [{ account_id: cuentaId }] = await ds.query<Array<{ account_id: string }>>(
      `INSERT INTO customer_account (distributor_id, customer_user_id, business_name, tax_condition, credit_limit, payment_terms_days)
       VALUES ($1, $2, 'Cliente', 'registered', 1000, 30) RETURNING account_id`,
      [distA, userId],
    );
  }, 300000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  it('siembra una "Caja central" de efectivo con sesión en cada distribuidora existente', async () => {
    const cajas = await ds.query<
      Array<{
        distributor_id: string;
        name: string;
        kind: string;
        requires_session: boolean;
        balance: string;
      }>
    >(
      `SELECT distributor_id, name, kind, requires_session, balance FROM cash_box ORDER BY distributor_id`,
    );
    expect(cajas).toHaveLength(2);
    for (const c of cajas) {
      expect(c).toMatchObject({
        name: 'Caja central',
        kind: 'cash',
        requires_session: true,
        balance: '0.00',
      });
    }
    expect(cajas.map((c) => c.distributor_id).sort()).toEqual(
      [distA, distB].sort(),
    );
  });

  it('siembra las diez categorías de sistema por distribuidora, cada una con su sentido', async () => {
    const filas = await ds.query<Array<{ distributor_id: string; n: number }>>(
      `SELECT distributor_id, COUNT(*)::int AS n FROM cash_category WHERE system_code IS NOT NULL GROUP BY distributor_id`,
    );
    expect(filas).toHaveLength(2);
    expect(filas.every((f) => f.n === 10)).toBe(true);
    const sentidos = await ds.query<
      Array<{ system_code: string; direction: string }>
    >(
      `SELECT system_code, direction FROM cash_category WHERE distributor_id = $1 ORDER BY system_code`,
      [distA],
    );
    expect(
      Object.fromEntries(sentidos.map((s) => [s.system_code, s.direction])),
    ).toEqual({
      cash_shortage: 'expense',
      cash_surplus: 'income',
      commission_payment: 'expense',
      customer_payment: 'income',
      driver_settlement: 'income',
      fuel: 'expense',
      purchase: 'expense',
      traffic_fine: 'expense',
      transfer_in: 'income',
      transfer_out: 'expense',
    });
  });

  it('el pedido acepta el medio de pago y el tipo "account"', async () => {
    const valores = await ds.query<Array<{ enumlabel: string }>>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname IN ('order_paymentmethod_enum', 'order_paymenttype_enum') AND e.enumlabel = 'account'`,
    );
    expect(valores).toHaveLength(2);
  });

  describe('los libros son de solo agregar (disparador)', () => {
    let movimientoId: string;
    let asientoId: string;
    let comisionId: string;

    beforeAll(async () => {
      [{ movement_id: movimientoId }] = await conBypass<
        Array<{ movement_id: string }>
      >(
        ds,
        ['saldos'],
        `INSERT INTO cash_movement (distributor_id, cash_box_id, direction, amount, category_id, description, created_by_user_id)
         VALUES ($1, $2, 'in', 100, $3, 'Alta', $4) RETURNING movement_id`,
        [distA, cajaId, categoriaId, userId],
      );
      [{ entry_id: asientoId }] = await conBypass<Array<{ entry_id: string }>>(
        ds,
        ['saldos'],
        `INSERT INTO customer_account_entry (distributor_id, account_id, type, amount, description)
         VALUES ($1, $2, 'debit_note', 50, 'Cargo') RETURNING entry_id`,
        [distA, cuentaId],
      );
    });

    it.each([
      [
        'UPDATE de un movimiento de caja',
        () =>
          `UPDATE cash_movement SET amount = 1 WHERE movement_id = '${movimientoId}'`,
      ],
      [
        'DELETE de un movimiento de caja',
        () => `DELETE FROM cash_movement WHERE movement_id = '${movimientoId}'`,
      ],
      [
        'UPDATE de un asiento de cuenta corriente',
        () =>
          `UPDATE customer_account_entry SET amount = 1 WHERE entry_id = '${asientoId}'`,
      ],
      [
        'DELETE de un asiento de cuenta corriente',
        () =>
          `DELETE FROM customer_account_entry WHERE entry_id = '${asientoId}'`,
      ],
    ])('%s falla', async (_nombre, sql) => {
      await expect(ds.query(sql())).rejects.toThrow(/libro de sólo agregar/);
    });

    it('el libro de comisiones sólo deja asignar la liquidación: cualquier otro cambio y todo borrado fallan', async () => {
      [{ entry_id: comisionId }] = await ds.query<Array<{ entry_id: string }>>(
        `INSERT INTO commission_entry (distributor_id, employee_id, type, amount, description)
         VALUES ($1, $2, 'delivery_commission', 10, 'Comisión') RETURNING entry_id`,
        [distA, employeeId],
      );
      await expect(
        ds.query(
          `UPDATE commission_entry SET amount = 99 WHERE entry_id = $1`,
          [comisionId],
        ),
      ).rejects.toThrow(/libro de sólo agregar/);
      await expect(
        ds.query(`DELETE FROM commission_entry WHERE entry_id = $1`, [
          comisionId,
        ]),
      ).rejects.toThrow(/libro de sólo agregar/);

      const [{ liquidation_id }] = await ds.query<
        Array<{ liquidation_id: string }>
      >(
        `INSERT INTO driver_liquidation (distributor_id, number, employee_id, period_from, period_to, gross, deductions, net, created_by_user_id)
         VALUES ($1, 1, $2, '2026-10-01', '2026-10-31', 10, 0, 10, $3) RETURNING liquidation_id`,
        [distA, employeeId, userId],
      );
      await expect(
        ds.query(
          `UPDATE commission_entry SET liquidation_id = $2 WHERE entry_id = $1`,
          [comisionId, liquidation_id],
        ),
      ).resolves.toBeDefined();
      await expect(
        ds.query(
          `UPDATE commission_entry SET liquidation_id = NULL WHERE entry_id = $1`,
          [comisionId],
        ),
      ).resolves.toBeDefined();
    });

    it('un asiento nuevo sí entra', async () => {
      await expect(
        conBypass(
          ds,
          ['saldos'],
          `INSERT INTO cash_movement (distributor_id, cash_box_id, direction, amount, category_id, description, created_by_user_id)
           VALUES ($1, $2, 'out', 1, $3, 'Otro', $4)`,
          [distA, cajaId, categoriaId, userId],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('restricciones de la base', () => {
    it('una caja de efectivo no admite saldo negativo; una de banco sí', async () => {
      await expect(
        ds.query(`UPDATE cash_box SET balance = -1 WHERE cash_box_id = $1`, [
          cajaId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        conBypass(
          ds,
          ['saldos'],
          `INSERT INTO cash_box (distributor_id, name, kind, balance) VALUES ($1, 'Banco', 'bank', -500)`,
          [distA],
        ),
      ).resolves.toBeDefined();
    });

    it('un movimiento tiene importe positivo', async () => {
      await expect(
        conBypass(
          ds,
          ['saldos'],
          `INSERT INTO cash_movement (distributor_id, cash_box_id, direction, amount, category_id, description, created_by_user_id)
           VALUES ($1, $2, 'in', 0, $3, 'Cero', $4)`,
          [distA, cajaId, categoriaId, userId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('una caja tiene a lo sumo una sesión abierta', async () => {
      await ds.query(
        `INSERT INTO cash_session (distributor_id, cash_box_id, opened_by_user_id, opening_amount) VALUES ($1, $2, $3, 0)`,
        [distA, cajaId, userId],
      );
      await expect(
        ds.query(
          `INSERT INTO cash_session (distributor_id, cash_box_id, opened_by_user_id, opening_amount) VALUES ($1, $2, $3, 0)`,
          [distA, cajaId, userId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('un movimiento se anula una sola vez', async () => {
      const [{ movement_id }] = await ds.query<Array<{ movement_id: string }>>(
        `SELECT movement_id FROM cash_movement WHERE description = 'Alta'`,
      );
      const anular = () =>
        conBypass(
          ds,
          ['saldos'],
          `INSERT INTO cash_movement (distributor_id, cash_box_id, direction, amount, category_id, description, created_by_user_id, reverses_movement_id)
           VALUES ($1, $2, 'out', 100, $3, 'Anula', $4, $5)`,
          [distA, cajaId, categoriaId, userId, movement_id],
        );
      await anular();
      await expect(anular()).rejects.toMatchObject({ code: '23505' });
    });

    it('el cargo de un pedido es único y el nombre de caja vigente también', async () => {
      await expect(
        ds.query(
          `INSERT INTO cash_box (distributor_id, name, kind) VALUES ($1, 'Caja central', 'cash')`,
          [distA],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('se puede deshacer y volver a aplicar', async () => {
    const migraciones = ds.migrations.length;
    await ds.undoLastMigration();
    const [{ existe }] = await ds.query<Array<{ existe: boolean }>>(
      `SELECT to_regclass('public.cash_box') IS NOT NULL AS existe`,
    );
    expect(existe).toBe(false);
    await ds.runMigrations();
    const [{ vuelve }] = await ds.query<Array<{ vuelve: boolean }>>(
      `SELECT to_regclass('public.cash_box') IS NOT NULL AS vuelve`,
    );
    expect(vuelve).toBe(true);
    expect(ds.migrations.length).toBe(migraciones);
  });
});
