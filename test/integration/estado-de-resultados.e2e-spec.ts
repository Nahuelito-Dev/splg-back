/**
 * Reglas de qué cuenta en el estado de resultados (ingresos y egresos), contra un
 * Postgres efímero con las tres tablas que lee el reporte. Prueba el significado
 * de las reglas, no el texto del SQL.
 */
import { randomUUID } from 'crypto';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { CashSystemCode } from '../../src/cash/domain/cash.enums';
import { CashIncomeStatementService } from '../../src/cash/application/cash-income-statement.service';

const IMAGEN = process.env.TEST_POSTGRES_IMAGE ?? 'postgres:16-alpine';

describe('estado de resultados (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;
  let servicio: CashIncomeStatementService;
  const distribuidora = randomUUID();
  const otraDistribuidora = randomUUID();
  const cats = {
    ventas: randomUUID(),
    gastos: randomUUID(),
    sobrante: randomUUID(),
    faltante: randomUUID(),
  };
  const dia = (n: number) => `2026-10-${String(n).padStart(2, '0')}T15:00:00Z`;
  let caja: string;

  async function caja_nueva(distributorId = distribuidora): Promise<string> {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO cash_box (cash_box_id, distributor_id, name, kind) VALUES ($1, $2, $3, 'cash')`,
      [id, distributorId, `Caja ${id.slice(0, 4)}`],
    );
    return id;
  }

  async function mov(m: {
    caja: string;
    direction: 'in' | 'out';
    amount: number;
    categoryId?: string;
    ref?: string;
    at: string;
    reverses?: string;
    distributorId?: string;
  }): Promise<string> {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO cash_movement (movement_id, distributor_id, cash_box_id, direction, amount, category_id, occurred_at, reference_type, reverses_movement_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        m.distributorId ?? distribuidora,
        m.caja,
        m.direction,
        m.amount,
        m.categoryId ?? (m.direction === 'in' ? cats.ventas : cats.gastos),
        m.at,
        m.ref ?? 'manual',
        m.reverses ?? null,
      ],
    );
    return id;
  }

  const consultar = (
    cashBoxId: string,
    from = '2026-10-01',
    to = '2026-10-31',
  ) => servicio.consultar(distribuidora, { from, to, cashBoxId });

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(IMAGEN)
      .withDatabase('resultados')
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
    });
    await ds.initialize();
    await ds.query(`
      CREATE TABLE cash_box (cash_box_id uuid PRIMARY KEY, distributor_id uuid NOT NULL, name text NOT NULL, kind text NOT NULL);
      CREATE TABLE cash_category (category_id uuid PRIMARY KEY, name text NOT NULL, system_code text);
      CREATE TABLE cash_movement (
        movement_id uuid PRIMARY KEY, distributor_id uuid NOT NULL, cash_box_id uuid NOT NULL,
        direction text NOT NULL, amount numeric(12,2) NOT NULL, category_id uuid NOT NULL,
        occurred_at timestamptz NOT NULL, reference_type text NOT NULL DEFAULT 'manual',
        reverses_movement_id uuid, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp());`);
    for (const [id, name, code] of [
      [cats.ventas, 'Ventas', null],
      [cats.gastos, 'Gastos', null],
      [cats.sobrante, 'Sobrante de caja', 'cash_surplus'],
      [cats.faltante, 'Faltante de caja', 'cash_shortage'],
    ]) {
      await ds.query(`INSERT INTO cash_category VALUES ($1, $2, $3)`, [
        id,
        name,
        code,
      ]);
    }
    servicio = new CashIncomeStatementService(ds);
  });

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  beforeEach(async () => {
    caja = await caja_nueva();
  });

  it('la carga inicial de una caja nueva no es un ingreso: va aparte', async () => {
    await mov({
      caja,
      direction: 'in',
      amount: 50000,
      categoryId: cats.sobrante,
      ref: 'session_opening',
      at: dia(1),
    });
    await mov({ caja, direction: 'in', amount: 1000, at: dia(2) });
    const r = await consultar(caja);
    expect(r.totals).toEqual({ income: 1000, expense: 0, net: 1000 });
    expect(r.initialLoad).toEqual({ amount: 50000, count: 1 });
  });

  it('apertura y cierre que se compensan dan neto cero', async () => {
    await mov({ caja, direction: 'in', amount: 100, at: dia(1) });
    await mov({
      caja,
      direction: 'in',
      amount: 900,
      categoryId: cats.sobrante,
      ref: 'session_opening',
      at: dia(2),
    });
    await mov({
      caja,
      direction: 'out',
      amount: 900,
      categoryId: cats.faltante,
      ref: 'session_closing',
      at: dia(3),
    });
    const r = await consultar(caja);
    expect(r.totals).toEqual({ income: 1000, expense: 900, net: 100 });
    expect(r.initialLoad.count).toBe(0);
    const sobrante = r.byCategory.find(
      (c) => c.systemCode === CashSystemCode.CASH_SURPLUS,
    );
    expect(sobrante?.amount).toBe(900);
  });

  it('un faltante real al abrir es un egreso', async () => {
    await mov({ caja, direction: 'in', amount: 500, at: dia(1) });
    await mov({
      caja,
      direction: 'out',
      amount: 80,
      categoryId: cats.faltante,
      ref: 'session_opening',
      at: dia(2),
    });
    const r = await consultar(caja);
    expect(r.totals).toEqual({ income: 500, expense: 80, net: 420 });
  });

  it('las transferencias entre cajas y sus anulaciones no cuentan', async () => {
    const destino = await caja_nueva();
    const salida = await mov({
      caja,
      direction: 'out',
      amount: 300,
      ref: 'box_transfer',
      at: dia(3),
    });
    const entrada = await mov({
      caja: destino,
      direction: 'in',
      amount: 300,
      ref: 'box_transfer',
      at: dia(3),
    });
    await mov({
      caja,
      direction: 'in',
      amount: 300,
      ref: 'reversal',
      reverses: salida,
      at: dia(4),
    });
    await mov({
      caja: destino,
      direction: 'out',
      amount: 300,
      ref: 'reversal',
      reverses: entrada,
      at: dia(4),
    });
    expect((await consultar(caja)).totals).toEqual({
      income: 0,
      expense: 0,
      net: 0,
    });
    expect((await consultar(destino)).totals).toEqual({
      income: 0,
      expense: 0,
      net: 0,
    });
  });

  it('un contraasiento resta en su período, en la categoría y el sentido de su original', async () => {
    const venta = await mov({ caja, direction: 'in', amount: 700, at: dia(5) });
    await mov({
      caja,
      direction: 'out',
      amount: 700,
      ref: 'reversal',
      reverses: venta,
      at: '2026-11-02T15:00:00Z',
    });
    const octubre = await consultar(caja);
    expect(octubre.totals).toEqual({ income: 700, expense: 0, net: 700 });
    const noviembre = await consultar(caja, '2026-11-01', '2026-11-30');
    expect(noviembre.totals).toEqual({ income: -700, expense: 0, net: -700 });
    expect(noviembre.byCategory).toEqual([
      expect.objectContaining({
        name: 'Ventas',
        direction: 'in',
        amount: -700,
      }),
    ]);
    const total = await consultar(caja, '2026-10-01', '2026-11-30');
    expect(total.totals.net).toBe(0);
  });

  it('el neto del período es la variación de saldo de la caja', async () => {
    await mov({ caja, direction: 'in', amount: 1000, at: dia(1) });
    const gasto = await mov({
      caja,
      direction: 'out',
      amount: 250,
      at: dia(2),
    });
    await mov({
      caja,
      direction: 'in',
      amount: 250,
      ref: 'reversal',
      reverses: gasto,
      at: dia(3),
    });
    await mov({
      caja,
      direction: 'out',
      amount: 40,
      categoryId: cats.faltante,
      ref: 'session_closing',
      at: dia(4),
    });
    const r = await consultar(caja);
    const saldo: { s: string }[] = await ds.query(
      `SELECT SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END)::text AS s FROM cash_movement WHERE cash_box_id = $1`,
      [caja],
    );
    expect(r.totals.net).toBe(Number(saldo[0].s));
  });

  it('aísla por distribuidora', async () => {
    await mov({ caja, direction: 'in', amount: 10, at: dia(2) });
    const ajena = await caja_nueva(otraDistribuidora);
    await mov({
      caja: ajena,
      direction: 'in',
      amount: 99999,
      at: dia(2),
      distributorId: otraDistribuidora,
    });
    const r = await servicio.consultar(distribuidora, {
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(r.byCashBox.find((c) => c.cashBoxId === ajena)).toBeUndefined();
    await expect(consultar(ajena)).rejects.toThrow('Caja no encontrada');
  });
});
