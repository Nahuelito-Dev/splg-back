/**
 * Tablero financiero (CU-245) y conciliación nocturna contra la API con
 * Postgres y Redis reales: saldos por caja, movimientos y rendiciones del día,
 * deuda de clientes y comisiones por liquidar; aislamiento entre distribuidoras.
 */
import { DataSource } from 'typeorm';
import { FinanceReconciliationCron } from '../../src/finance/application/finance-reconciliation.cron';
import { CustomerLedgerService } from '../../src/customer-account/application/customer-ledger.service';
import {
  PaymentMethod,
  PaymentStatus,
} from '../../src/order/entities/order.entity';
import { diaArgentino } from '../../src/common/utils/dias-argentina';
import { conIdempotencia } from './setup/con-idempotencia';
import { Finanzas, cuerpo } from './setup/finanzas';
import { TestEnv, createTestApp, truncateAllTables } from './setup/test-env';

interface Tablero {
  date: string;
  cashBoxes: Array<{
    cashBoxId: string;
    name: string;
    balance: number;
    hasOpenSession: boolean;
  }>;
  totalBalance: number;
  movements: { income: number; expense: number; count: number };
  settlements: {
    open: number;
    submitted: number;
    approved: number;
    overdue: number;
    pendingCash: number;
  };
  receivables: {
    totalDebt: number;
    overdueDebt: number;
    accountsWithDebt: number;
  };
  commissions: { pendingToLiquidate: number; employees: number };
}
interface Pagina<T> {
  data: T[];
  total: number;
}
interface Caja {
  cashBoxId: string;
}
interface Categoria {
  categoryId: string;
  direction: string;
  systemCode: string | null;
}

describe('Tablero financiero (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let f: Finanzas;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    f = new Finanzas(env);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const http = () => conIdempotencia(env.app.getHttpServer());

  it('junta cajas, movimientos, rendiciones, deuda y comisiones del día', async () => {
    const e = await f.distribuidora();
    const chofer = await f.chofer(e.distributorId);
    const cliente = await f.cliente();
    const [central] = cuerpo<Pagina<Caja>>(
      await http().get('/cash-boxes').set(e.headers).expect(200),
    ).data;
    const categorias = cuerpo<Pagina<Categoria>>(
      await http().get('/cash-categories').set(e.headers).expect(200),
    ).data;
    const ingreso =
      categorias.find((c) => c.direction === 'income' && !c.systemCode) ??
      cuerpo<Categoria>(
        await http()
          .post('/cash-categories')
          .set(e.headers)
          .send({ name: 'Venta', direction: 'income' })
          .expect(201),
      );
    await http()
      .post(`/cash-boxes/${central.cashBoxId}/sessions`)
      .set(e.headers)
      .send({ openingAmount: 1000 })
      .expect(201);
    await http()
      .post('/cash-movements')
      .set(e.headers)
      .send({
        cashBoxId: central.cashBoxId,
        direction: 'in',
        amount: 250,
        categoryId: ingreso.categoryId,
        description: 'Venta',
      })
      .expect(201);
    // Un banco, para que haya más de una caja.
    await http()
      .post('/cash-boxes')
      .set(e.headers)
      .send({ name: 'Banco', kind: 'bank' })
      .expect(201);

    // Una rendición abierta de hoy y una de ayer sin cerrar.
    await f.pedidoEntregado(e, {
      chofer,
      cliente,
      estadoDePago: PaymentStatus.PAID,
    });
    await http()
      .post('/driver-settlements')
      .set(e.headers)
      .send({ deliveryId: chofer.deliveryId, businessDate: diaArgentino() })
      .expect(201);
    await http()
      .post('/driver-settlements')
      .set(e.headers)
      .send({ deliveryId: chofer.deliveryId, businessDate: '2026-10-01' })
      .expect(201);

    // Deuda de un cliente y una comisión sin liquidar.
    await http()
      .post('/customer-accounts')
      .set(e.headers)
      .send({
        customerUserId: cliente.userId,
        businessName: 'Panadería',
        taxCondition: 'final_consumer',
        creditLimit: 100000,
        paymentTermsDays: 30,
      })
      .expect(201);
    const vieja = await f.pedidoEntregado(e, {
      chofer,
      cliente,
      cantidad: 2,
      metodo: PaymentMethod.ACCOUNT,
      entregadoEn: new Date(Date.now() - 40 * 86_400_000),
    });
    await env.app.get(CustomerLedgerService).asentarCargo(vieja.orderId);
    await http()
      .post('/commission-rules')
      .set(e.headers)
      .send({ basis: 'per_unit', value: 100, validFrom: '2020-01-01' })
      .expect(201);
    await ds.query(
      `INSERT INTO commission_entry (distributor_id, employee_id, type, amount, description)
       VALUES ($1, $2, 'delivery_commission', 700, 'Comisión')`,
      [e.distributorId, chofer.employeeId],
    );

    const t = cuerpo<Tablero>(
      await http().get('/finance/dashboard').set(e.headers).expect(200),
    );
    expect(t.date).toBe(diaArgentino());
    expect(t.cashBoxes).toHaveLength(2);
    expect(
      t.cashBoxes.find((c) => c.cashBoxId === central.cashBoxId),
    ).toMatchObject({
      balance: 1250,
      hasOpenSession: true,
    });
    expect(t.totalBalance).toBe(1250);
    // La apertura (ajuste) y el ingreso manual: entradas 1000 + 250.
    expect(t.movements).toMatchObject({ income: 1250, expense: 0, count: 2 });
    expect(t.settlements).toMatchObject({
      open: 1,
      overdue: 1,
      submitted: 0,
      approved: 0,
    });
    expect(t.receivables).toMatchObject({
      totalDebt: 2000,
      overdueDebt: 2000,
      accountsWithDebt: 1,
    });
    expect(t.commissions).toMatchObject({
      pendingToLiquidate: 700,
      employees: 1,
    });
  });

  it('acepta una fecha y rechaza una inválida (400)', async () => {
    const e = await f.distribuidora();
    const t = cuerpo<Tablero>(
      await http()
        .get('/finance/dashboard')
        .query({ date: '2026-01-15' })
        .set(e.headers)
        .expect(200),
    );
    expect(t.date).toBe('2026-01-15');
    expect(t.movements.count).toBe(0);
    await http()
      .get('/finance/dashboard')
      .query({ date: '2026-02-30' })
      .set(e.headers)
      .expect(400);
    await http()
      .get('/finance/dashboard')
      .query({ date: 'ayer' })
      .set(e.headers)
      .expect(400);
  });

  it('cada distribuidora ve sólo lo suyo y el cliente no entra (403)', async () => {
    const a = await f.distribuidora();
    const b = await f.distribuidora();
    const choferA = await f.chofer(a.distributorId);
    await ds.query(
      `INSERT INTO commission_entry (distributor_id, employee_id, type, amount, description)
       VALUES ($1, $2, 'delivery_commission', 500, 'Comisión')`,
      [a.distributorId, choferA.employeeId],
    );
    const tb = cuerpo<Tablero>(
      await http().get('/finance/dashboard').set(b.headers).expect(200),
    );
    expect(tb.commissions.pendingToLiquidate).toBe(0);
    expect(tb.cashBoxes).toHaveLength(1);
    await http().get('/finance/dashboard').set(choferA.headers).expect(403);
  });

  describe('conciliación nocturna', () => {
    it('recupera los asientos pendientes y avisa los saldos que no cierran contra su libro', async () => {
      const e = await f.distribuidora();
      const chofer = await f.chofer(e.distributorId);
      const cliente = await f.cliente();
      await http()
        .post('/commission-rules')
        .set(e.headers)
        .send({ basis: 'per_unit', value: 10, validFrom: '2020-01-01' })
        .expect(201);
      await f.pedidoEntregado(e, { chofer, cliente, cantidad: 3 });
      const cron = env.app.get(FinanceReconciliationCron);
      const r = await cron.correr();
      expect(r).toEqual({ comisiones: 1, cargos: 0, saldosDesfasados: 0 });

      // Un saldo tocado a mano se detecta, no se corrige.
      const [central] = cuerpo<Pagina<Caja>>(
        await http().get('/cash-boxes').set(e.headers).expect(200),
      ).data;
      await ds.query(
        `UPDATE cash_box SET balance = 999 WHERE cash_box_id = $1`,
        [central.cashBoxId],
      );
      expect((await cron.correr()).saldosDesfasados).toBe(1);
      const [caja] = await ds.query<Array<{ balance: string }>>(
        `SELECT balance FROM cash_box WHERE cash_box_id = $1`,
        [central.cashBoxId],
      );
      expect(Number(caja.balance)).toBe(999);
    });
  });
});
