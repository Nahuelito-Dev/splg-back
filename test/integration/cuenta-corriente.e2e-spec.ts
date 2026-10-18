/**
 * Cuentas corrientes de clientes (M-D parte 3) contra la API con Postgres y
 * Redis reales: habilitar y modificar, venta a cuenta con control de crédito,
 * cargo al entregar (idempotente y con barrido), pagos del administrador y del
 * chofer en la calle, imputación FIFO, ajustes, estado de cuenta, antigüedad,
 * aislamiento entre distribuidoras y concurrencia sobre el crédito.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { codigoSqlDelError } from '../../src/common/errors/db-exceptions';
import { CustomerLedgerService } from '../../src/customer-account/application/customer-ledger.service';
import { diaArgentino } from '../../src/common/utils/dias-argentina';
import {
  PaymentMethod,
  PaymentStatus,
} from '../../src/order/entities/order.entity';
import { conIdempotencia } from './setup/con-idempotencia';
import { entregarComoAdmin } from './setup/entrega-admin';
import { Finanzas, Headers, cuerpo } from './setup/finanzas';
import { TestEnv, createTestApp, truncateAllTables } from './setup/test-env';

const mockReintentos = { n: 0 };
jest.mock('../../src/common/utils/with-transaction-retry', () => {
  const real = jest.requireActual<
    typeof import('../../src/common/utils/with-transaction-retry')
  >('../../src/common/utils/with-transaction-retry');
  return {
    ...real,
    withTransactionRetry: <T>(
      fn: () => Promise<T>,
      options?: Parameters<typeof real.withTransactionRetry>[1],
    ): Promise<T> =>
      real.withTransactionRetry(async () => {
        try {
          return await fn();
        } catch (error) {
          const code = codigoSqlDelError(error);
          if (code === '40P01' || code === '40001') mockReintentos.n += 1;
          throw error;
        }
      }, options),
  };
});

interface Cuenta {
  accountId: string;
  customerUserId: string;
  businessName: string;
  taxId: string | null;
  creditLimit: number;
  paymentTermsDays: number;
  status: string;
  balance: number;
  pendingOrdersAmount: number;
  availableCredit: number;
  overdueAmount: number;
  aging: {
    upTo30Days: number;
    from31To60Days: number;
    from61To90Days: number;
    over90Days: number;
    total: number;
  };
}
interface Asiento {
  entryId: string;
  type: string;
  amount: number;
  signedAmount: number;
  balanceAfter: number;
  orderId: string | null;
  dueDate: string | null;
  cashMovementId: string | null;
  collectedByDeliveryId: string | null;
  pendingAmount: number;
}
interface Estado {
  openingBalance: number;
  closingBalance: number;
  total: number;
  data: Asiento[];
}
interface Pagina<T> {
  data: T[];
  total: number;
}
interface Caja {
  cashBoxId: string;
  balance: number;
}
interface Rendicion {
  settlementId: string;
  expectedCash: number;
  cashFromCollections: number;
  collections: Array<{ entryId: string; amount: number }>;
}
interface Pedido {
  order_id: string;
  payment_method: string;
  paymentMethodDetail: string;
  total_amount: number;
}

const CUIT = '30712345671';

describe('Cuentas corrientes (e2e)', () => {
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
    mockReintentos.n = 0;
  });

  const http = () => conIdempotencia(env.app.getHttpServer());
  type Entorno = Awaited<ReturnType<Finanzas['distribuidora']>>;

  async function armar() {
    const e = await f.distribuidora();
    const cliente = await f.cliente('Ana Gómez');
    const [central] = cuerpo<Pagina<Caja>>(
      await http().get('/cash-boxes').set(e.headers).expect(200),
    ).data;
    return { e, cliente, cajaId: central.cashBoxId };
  }

  const abrirCaja = (e: Entorno, cajaId: string, monto = 0) =>
    http()
      .post(`/cash-boxes/${cajaId}/sessions`)
      .set(e.headers)
      .send({ openingAmount: monto })
      .expect(201);

  const habilitar = (
    h: Headers,
    customerUserId: string,
    extra: Record<string, unknown> = {},
  ) =>
    http()
      .post('/customer-accounts')
      .set(h)
      .send({
        customerUserId,
        businessName: 'Panadería La Espiga S.R.L.',
        taxId: CUIT,
        taxCondition: 'registered',
        creditLimit: 10000,
        paymentTermsDays: 30,
        ...extra,
      });

  const cuentaDe = async (h: Headers, id: string) =>
    cuerpo<Cuenta>(
      await http().get(`/customer-accounts/${id}`).set(h).expect(200),
    );

  const venderACuenta = (
    e: Entorno,
    cliente: { userId: string; addressId: string },
    cantidad: number,
    extra: Record<string, unknown> = {},
  ) =>
    http()
      .post('/orders')
      .set(e.headers)
      .send({
        customerId: cliente.userId,
        addressId: cliente.addressId,
        paymentMethod: 'account',
        items: [
          {
            gasCylinderId: e.garrafa.gasCylinderId,
            quantity: cantidad,
            unitPrice: 1000,
          },
        ],
        ...extra,
      });

  const pagar = (h: Headers, cuentaId: string, body: Record<string, unknown>) =>
    http().post(`/customer-accounts/${cuentaId}/payments`).set(h).send(body);

  const saldoDe = async (cuentaId: string) =>
    Number(
      (
        await ds.query<Array<{ balance: string }>>(
          `SELECT balance FROM customer_account WHERE account_id = $1`,
          [cuentaId],
        )
      )[0].balance,
    );

  /** Un pedido a cuenta ya hecho y llevado a "en camino", listo para entregar. */
  async function pedidoEnCamino(
    e: Entorno,
    cliente: { userId: string; addressId: string },
    chofer: { deliveryId: string },
    cantidad = 1,
  ) {
    const p = cuerpo<Pedido>(
      await venderACuenta(e, cliente, cantidad).expect(201),
    );
    await ds.query(
      `UPDATE "order" SET status = 'on_the_way', delivery_id = $2, "acceptedAt" = now(), "onTheWayAt" = now()
       WHERE order_id = $1`,
      [p.order_id, chofer.deliveryId],
    );
    return p;
  }

  describe('habilitar (CU-235)', () => {
    it('habilita la cuenta con sus términos y la deja activa con saldo cero', async () => {
      const { e, cliente } = await armar();
      const res = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      expect(res).toMatchObject({
        businessName: 'Panadería La Espiga S.R.L.',
        taxId: CUIT,
        creditLimit: 10000,
        paymentTermsDays: 30,
        status: 'active',
        balance: 0,
        availableCredit: 10000,
      });
    });

    it('rechaza: segunda cuenta vigente (409), CUIT inválido (400), cliente inexistente (404), límite negativo o plazo no positivo (400)', async () => {
      const { e, cliente } = await armar();
      await habilitar(e.headers, cliente.userId).expect(201);
      await habilitar(e.headers, cliente.userId).expect(409);
      const otro = await f.cliente();
      await habilitar(e.headers, otro.userId, { taxId: '30712345670' }).expect(
        400,
      );
      await habilitar(e.headers, otro.userId, { taxId: '123' }).expect(400);
      await habilitar(e.headers, randomUUID()).expect(404);
      await habilitar(e.headers, otro.userId, { creditLimit: -1 }).expect(400);
      await habilitar(e.headers, otro.userId, { paymentTermsDays: 0 }).expect(
        400,
      );
      await habilitar(e.headers, otro.userId, { paymentTermsDays: 1.5 }).expect(
        400,
      );
      await habilitar(e.headers, otro.userId, { taxCondition: 'otra' }).expect(
        400,
      );
    });

    it('el mismo cliente puede tener una cuenta en cada distribuidora, con sus propios términos', async () => {
      const { e, cliente } = await armar();
      const b = await f.distribuidora();
      const a1 = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      const b1 = cuerpo<Cuenta>(
        await habilitar(b.headers, cliente.userId, { creditLimit: 500 }).expect(
          201,
        ),
      );
      expect(a1.accountId).not.toBe(b1.accountId);
      expect(b1.creditLimit).toBe(500);
      // Cada una ve sólo la suya.
      await http()
        .get(`/customer-accounts/${b1.accountId}`)
        .set(e.headers)
        .expect(404);
      const lista = cuerpo<Pagina<Cuenta>>(
        await http().get('/customer-accounts').set(e.headers).expect(200),
      );
      expect(lista.data.map((c) => c.accountId)).toEqual([a1.accountId]);
    });
  });

  describe('modificar (CU-331)', () => {
    it('cambia los términos y bloquea; cerrar con saldo distinto de cero es 409', async () => {
      const { e, cliente } = await armar();
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      const editada = cuerpo<Cuenta>(
        await http()
          .patch(`/customer-accounts/${cuenta.accountId}`)
          .set(e.headers)
          .send({ creditLimit: 25000, paymentTermsDays: 45, status: 'blocked' })
          .expect(200),
      );
      expect(editada).toMatchObject({
        creditLimit: 25000,
        paymentTermsDays: 45,
        status: 'blocked',
      });

      await http()
        .patch(`/customer-accounts/${cuenta.accountId}`)
        .set(e.headers)
        .send({ status: 'active' })
        .expect(200);
      await http()
        .post(`/customer-accounts/${cuenta.accountId}/adjustments`)
        .set(e.headers)
        .send({ kind: 'debit', amount: 100, reason: 'Cargo manual' })
        .expect(201);
      await http()
        .patch(`/customer-accounts/${cuenta.accountId}`)
        .set(e.headers)
        .send({ status: 'closed' })
        .expect(409);
      await http()
        .post(`/customer-accounts/${cuenta.accountId}/adjustments`)
        .set(e.headers)
        .send({ kind: 'credit', amount: 100, reason: 'Se perdona' })
        .expect(201);
      const cerrada = cuerpo<Cuenta>(
        await http()
          .patch(`/customer-accounts/${cuenta.accountId}`)
          .set(e.headers)
          .send({ status: 'closed' })
          .expect(200),
      );
      expect(cerrada.status).toBe('closed');
    });

    it('valida límite y plazo (400) y una cuenta de otra distribuidora es 404', async () => {
      const { e, cliente } = await armar();
      const b = await f.distribuidora();
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      await http()
        .patch(`/customer-accounts/${cuenta.accountId}`)
        .set(e.headers)
        .send({ creditLimit: -5 })
        .expect(400);
      await http()
        .patch(`/customer-accounts/${cuenta.accountId}`)
        .set(e.headers)
        .send({ paymentTermsDays: 0 })
        .expect(400);
      await http()
        .patch(`/customer-accounts/${cuenta.accountId}`)
        .set(b.headers)
        .send({ creditLimit: 1 })
        .expect(404);
    });
  });

  describe('vender a cuenta (CU-236)', () => {
    it('sin cuenta, bloqueada o cerrada el pedido se rechaza (409) y no se crea', async () => {
      const { e, cliente } = await armar();
      await venderACuenta(e, cliente, 1).expect(409);
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      await http()
        .patch(`/customer-accounts/${cuenta.accountId}`)
        .set(e.headers)
        .send({ status: 'blocked' })
        .expect(200);
      await venderACuenta(e, cliente, 1).expect(409);
      const [{ n }] = await ds.query<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM "order"`,
      );
      expect(n).toBe(0);
    });

    it('descuenta el crédito disponible con cada pedido y rechaza el que lo supera, informando el disponible', async () => {
      const { e, cliente } = await armar();
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      const p1 = cuerpo<Pedido>(await venderACuenta(e, cliente, 6).expect(201));
      expect(p1).toMatchObject({
        payment_method: 'account',
        paymentMethodDetail: 'account',
        total_amount: 6000,
      });

      const detalle = await cuentaDe(e.headers, cuenta.accountId);
      expect(detalle).toMatchObject({
        balance: 0,
        pendingOrdersAmount: 6000,
        availableCredit: 4000,
      });
      const rechazo = await venderACuenta(e, cliente, 5).expect(409);
      expect((rechazo.body as { message: string }).message).toContain(
        '4000.00',
      );
      await venderACuenta(e, cliente, 4).expect(201);
    });

    it('un pedido cancelado devuelve su crédito', async () => {
      const { e, cliente } = await armar();
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      const p = cuerpo<Pedido>(await venderACuenta(e, cliente, 8).expect(201));
      expect(
        (await cuentaDe(e.headers, cuenta.accountId)).availableCredit,
      ).toBe(2000);
      await ds.query(
        `UPDATE "order" SET status = 'cancelled' WHERE order_id = $1`,
        [p.order_id],
      );
      expect(
        (await cuentaDe(e.headers, cuenta.accountId)).availableCredit,
      ).toBe(10000);
    });

    it('sólo un administrador vende a cuenta: el cliente y el chofer reciben 403; una reserva no se paga a cuenta (400)', async () => {
      const { e, cliente } = await armar();
      await habilitar(e.headers, cliente.userId).expect(201);
      const chofer = await f.chofer(e.distributorId);
      const comoChofer = await http()
        .post('/orders')
        .set(chofer.headers)
        .send({
          customerId: cliente.userId,
          addressId: cliente.addressId,
          paymentMethod: 'account',
          items: [
            {
              gasCylinderId: e.garrafa.gasCylinderId,
              quantity: 1,
              unitPrice: 1000,
            },
          ],
        });
      expect(comoChofer.status).toBe(403);
      await venderACuenta(e, cliente, 1, {
        isReservation: true,
        scheduledDate: '2030-01-01',
        depositAmount: 100,
      }).expect(400);
    });

    it('un pedido a cuenta no se edita ni se le cambia el medio de pago', async () => {
      const { e, cliente } = await armar();
      await habilitar(e.headers, cliente.userId).expect(201);
      const p = cuerpo<Pedido>(await venderACuenta(e, cliente, 1).expect(201));
      const r = await http()
        .patch(`/orders/${p.order_id}`)
        .set(e.headers)
        .send({ notes: 'cambio' });
      expect(r.status).toBe(409);
    });

    it('pedidos simultáneos no superan el límite entre los dos', async () => {
      const { e, cliente } = await armar();
      await habilitar(e.headers, cliente.userId, { creditLimit: 10000 }).expect(
        201,
      );
      const respuestas = await Promise.all(
        Array.from({ length: 6 }, () => venderACuenta(e, cliente, 3)),
      );
      const estados = respuestas.map((r) => r.status).sort();
      expect(estados.filter((s) => s === 201)).toHaveLength(3);
      expect(estados.filter((s) => s === 409)).toHaveLength(3);
      const [{ total }] = await ds.query<Array<{ total: string }>>(
        `SELECT COALESCE(SUM("totalAmount"), 0) AS total FROM "order" WHERE "paymentMethod" = 'account'`,
      );
      expect(Number(total)).toBe(9000);
    });
  });

  describe('asentar el cargo al entregar (CU-332)', () => {
    it('el pedido entregado queda como deuda con su vencimiento; entregar de nuevo no duplica', async () => {
      const { e, cliente } = await armar();
      const chofer = await f.chofer(e.distributorId);
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId, {
          paymentTermsDays: 15,
        }).expect(201),
      );
      const p = await pedidoEnCamino(e, cliente, chofer, 3);
      await entregarComoAdmin(env, p.order_id);

      expect(await saldoDe(cuenta.accountId)).toBe(3000);
      const estado = cuerpo<Estado>(
        await http()
          .get(`/customer-accounts/${cuenta.accountId}/entries`)
          .set(e.headers)
          .expect(200),
      );
      expect(estado.data).toHaveLength(1);
      const vence = new Date();
      vence.setUTCDate(vence.getUTCDate() + 15);
      expect(estado.data[0]).toMatchObject({
        type: 'sale_charge',
        amount: 3000,
        orderId: p.order_id,
        balanceAfter: 3000,
        pendingAmount: 3000,
      });
      expect(estado.data[0].dueDate).toBe(
        diaArgentino(new Date(Date.now() + 15 * 86_400_000)),
      );

      // Reintento del asiento (evento duplicado): no duplica.
      const ledger = env.app.get(CustomerLedgerService);
      expect(await ledger.asentarCargo(p.order_id)).toBe('existente');
      expect(await saldoDe(cuenta.accountId)).toBe(3000);
      // Y el crédito ya no cuenta el pedido dos veces (saldo + abiertos).
      const despues = await cuentaDe(e.headers, cuenta.accountId);
      expect(despues).toMatchObject({
        pendingOrdersAmount: 0,
        availableCredit: 7000,
      });
    });

    it('un pedido que no es a cuenta o no está entregado no genera cargo', async () => {
      const { e, cliente } = await armar();
      const chofer = await f.chofer(e.distributorId);
      await habilitar(e.headers, cliente.userId).expect(201);
      const efectivo = await f.pedidoEntregado(e, {
        chofer,
        cliente,
        metodo: PaymentMethod.CASH,
      });
      const ledger = env.app.get(CustomerLedgerService);
      expect(await ledger.asentarCargo(efectivo.orderId)).toBe(
        'no-corresponde',
      );
      const enCamino = await pedidoEnCamino(e, cliente, chofer);
      expect(await ledger.asentarCargo(enCamino.order_id)).toBe(
        'no-corresponde',
      );
    });

    it('el barrido nocturno recupera los pedidos a cuenta entregados que quedaron sin cargo', async () => {
      const { e, cliente } = await armar();
      const chofer = await f.chofer(e.distributorId);
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      // Entregado "a mano" en la base: nadie publicó el evento.
      await f.pedidoEntregado(e, {
        chofer,
        cliente,
        cantidad: 2,
        metodo: PaymentMethod.ACCOUNT,
      });
      expect(await saldoDe(cuenta.accountId)).toBe(0);
      const ledger = env.app.get(CustomerLedgerService);
      expect(await ledger.barrer()).toBe(1);
      expect(await saldoDe(cuenta.accountId)).toBe(2000);
      expect(await ledger.barrer()).toBe(0);
    });

    it('un cliente sin cuenta (dada de baja luego) no rompe la entrega: queda para revisar', async () => {
      const { e, cliente } = await armar();
      const chofer = await f.chofer(e.distributorId);
      const pedido = await f.pedidoEntregado(e, {
        chofer,
        cliente,
        metodo: PaymentMethod.ACCOUNT,
      });
      expect(
        await env.app.get(CustomerLedgerService).asentarCargo(pedido.orderId),
      ).toBe('sin-cuenta');
    });
  });

  describe('pagos del administrador (CU-237)', () => {
    async function conDeuda() {
      const base = await armar();
      const chofer = await f.chofer(base.e.distributorId);
      const cuenta = cuerpo<Cuenta>(
        await habilitar(base.e.headers, base.cliente.userId, {
          creditLimit: 100000,
        }).expect(201),
      );
      const ledger = env.app.get(CustomerLedgerService);
      for (const [cantidad, dias] of [
        [3, 20],
        [2, 5],
      ]) {
        const pedido = await f.pedidoEntregado(base.e, {
          chofer,
          cliente: base.cliente,
          cantidad,
          metodo: PaymentMethod.ACCOUNT,
          entregadoEn: new Date(Date.now() - dias * 86_400_000),
        });
        await ledger.asentarCargo(pedido.orderId);
      }
      return { ...base, chofer, cuenta };
    }

    it('asienta el pago, la entrada a caja y lo imputa al cargo más viejo', async () => {
      const { e, cajaId, cuenta } = await conDeuda();
      await abrirCaja(e, cajaId);
      expect(await saldoDe(cuenta.accountId)).toBe(5000);

      const pago = cuerpo<Asiento>(
        await pagar(e.headers, cuenta.accountId, {
          amount: 3500,
          method: 'transfer',
          cashBoxId: cajaId,
          description: 'Transferencia octubre',
        }).expect(201),
      );
      expect(pago).toMatchObject({
        type: 'payment',
        amount: 3500,
        signedAmount: -3500,
        balanceAfter: 1500,
      });
      expect(pago.cashMovementId).not.toBeNull();
      expect(await saldoDe(cuenta.accountId)).toBe(1500);

      const [caja] = await ds.query<Array<{ balance: string }>>(
        `SELECT balance FROM cash_box WHERE cash_box_id = $1`,
        [cajaId],
      );
      expect(Number(caja.balance)).toBe(3500);
      const [mov] = await ds.query<
        Array<{ name: string; reference_type: string }>
      >(
        `SELECT c.name, m.reference_type FROM cash_movement m JOIN cash_category c ON c.category_id = m.category_id
         WHERE m.movement_id = $1`,
        [pago.cashMovementId],
      );
      expect(mov).toEqual({
        name: 'Cobro de cuenta corriente',
        reference_type: 'customer_payment',
      });

      // FIFO: el cargo de hace 20 días (3000) quedó saldado y el de hace 5 días, a medias.
      const estado = cuerpo<Estado>(
        await http()
          .get(`/customer-accounts/${cuenta.accountId}/entries`)
          .set(e.headers)
          .expect(200),
      );
      const cargos = estado.data.filter((a) => a.type === 'sale_charge');
      expect(cargos.map((c) => c.pendingAmount)).toEqual([0, 1500]);
    });

    it('un pago mayor a la deuda deja saldo a favor', async () => {
      const { e, cajaId, cuenta } = await conDeuda();
      await abrirCaja(e, cajaId);
      await pagar(e.headers, cuenta.accountId, {
        amount: 6000,
        method: 'cash',
        cashBoxId: cajaId,
      }).expect(201);
      expect(await saldoDe(cuenta.accountId)).toBe(-1000);
      const detalle = await cuentaDe(e.headers, cuenta.accountId);
      expect(detalle.availableCredit).toBe(101000);
    });

    it('valida: sin caja (409), caja sin sesión (409), importe no positivo (400), caja ajena (404), cuenta ajena (404), cuenta cerrada (409)', async () => {
      const { e, cajaId, cuenta } = await conDeuda();
      await pagar(e.headers, cuenta.accountId, {
        amount: 100,
        method: 'cash',
      }).expect(409);
      await pagar(e.headers, cuenta.accountId, {
        amount: 100,
        method: 'cash',
        cashBoxId: cajaId,
      }).expect(409);
      await abrirCaja(e, cajaId);
      await pagar(e.headers, cuenta.accountId, {
        amount: 0,
        method: 'cash',
        cashBoxId: cajaId,
      }).expect(400);
      await pagar(e.headers, cuenta.accountId, {
        amount: 100,
        method: 'cash',
        cashBoxId: randomUUID(),
      }).expect(404);
      const b = await f.distribuidora();
      await pagar(b.headers, cuenta.accountId, {
        amount: 100,
        method: 'cash',
        cashBoxId: cajaId,
      }).expect(404);
      await ds.query(
        `UPDATE customer_account SET status = 'closed' WHERE account_id = $1`,
        [cuenta.accountId],
      );
      await pagar(e.headers, cuenta.accountId, {
        amount: 100,
        method: 'cash',
        cashBoxId: cajaId,
      }).expect(409);
      expect(await saldoDe(cuenta.accountId)).toBe(5000);
    });

    it('la misma Idempotency-Key no duplica el pago y con otro cuerpo es 422', async () => {
      const { e, cajaId, cuenta } = await conDeuda();
      await abrirCaja(e, cajaId);
      const clave = randomUUID();
      const cuerpoPago = { amount: 1000, method: 'cash', cashBoxId: cajaId };
      const enviar = (c: Record<string, unknown>) =>
        http()
          .post(`/customer-accounts/${cuenta.accountId}/payments`)
          .set(e.headers)
          .set('Idempotency-Key', clave)
          .send(c);
      await enviar(cuerpoPago).expect(201);
      await enviar(cuerpoPago).expect(201);
      await enviar({ ...cuerpoPago, amount: 2000 }).expect(422);
      expect(await saldoDe(cuenta.accountId)).toBe(4000);
    });

    it('pagos simultáneos conservan el saldo y no se interbloquean', async () => {
      const { e, cajaId, cuenta } = await conDeuda();
      await abrirCaja(e, cajaId);
      const respuestas = await Promise.all(
        Array.from({ length: 8 }, () =>
          pagar(e.headers, cuenta.accountId, {
            amount: 100,
            method: 'cash',
            cashBoxId: cajaId,
          }),
        ),
      );
      expect(respuestas.every((r) => r.status === 201)).toBe(true);
      expect(await saldoDe(cuenta.accountId)).toBe(4200);
      expect(mockReintentos.n).toBe(0);
      const [{ aplicado }] = await ds.query<Array<{ aplicado: string }>>(
        `SELECT COALESCE(SUM(amount), 0) AS aplicado FROM customer_account_allocation WHERE account_id = $1`,
        [cuenta.accountId],
      );
      expect(Number(aplicado)).toBe(800);
    });
  });

  describe('cobro del chofer en la calle (CU-237)', () => {
    async function conChofer() {
      const base = await armar();
      const chofer = await f.chofer(base.e.distributorId, 'Juan Pérez');
      const cuenta = cuerpo<Cuenta>(
        await habilitar(base.e.headers, base.cliente.userId, {
          creditLimit: 100000,
        }).expect(201),
      );
      await f.pedidoEntregado(base.e, {
        chofer,
        cliente: base.cliente,
        cantidad: 5,
        metodo: PaymentMethod.ACCOUNT,
      });
      await env.app.get(CustomerLedgerService).barrer();
      return { ...base, chofer, cuenta };
    }

    it('sin rendición abierta el chofer no puede cobrar (409); con ella, el cobro suma al esperado y no toca la caja', async () => {
      const { e, chofer, cuenta, cajaId } = await conChofer();
      await pagar(chofer.headers, cuenta.accountId, {
        amount: 2000,
        method: 'cash',
      }).expect(409);

      const mia = cuerpo<Rendicion>(
        await http()
          .get('/driver-settlements/mine')
          .set(chofer.headers)
          .expect(200),
      );
      const pago = cuerpo<Asiento>(
        await pagar(chofer.headers, cuenta.accountId, {
          amount: 2000,
          method: 'cash',
        }).expect(201),
      );
      expect(pago).toMatchObject({
        type: 'payment',
        cashMovementId: null,
        collectedByDeliveryId: chofer.deliveryId,
        balanceAfter: 3000,
      });
      const [caja] = await ds.query<Array<{ balance: string; movs: number }>>(
        `SELECT balance, (SELECT COUNT(*)::int FROM cash_movement) AS movs FROM cash_box WHERE cash_box_id = $1`,
        [cajaId],
      );
      expect(Number(caja.balance)).toBe(0);
      expect(caja.movs).toBe(0);

      const rendicion = cuerpo<Rendicion>(
        await http()
          .get(`/driver-settlements/${mia.settlementId}`)
          .set(e.headers)
          .expect(200),
      );
      expect(rendicion).toMatchObject({
        cashFromCollections: 2000,
        expectedCash: 2000,
      });
      expect(rendicion.collections).toEqual([
        expect.objectContaining({ entryId: pago.entryId, amount: 2000 }),
      ]);
    });

    it('el dinero entra a la caja una sola vez, al aprobar la rendición', async () => {
      const { e, chofer, cuenta, cajaId } = await conChofer();
      await abrirCaja(e, cajaId);
      const mia = cuerpo<Rendicion>(
        await http()
          .get('/driver-settlements/mine')
          .set(chofer.headers)
          .expect(200),
      );
      await pagar(chofer.headers, cuenta.accountId, {
        amount: 1500,
        method: 'cash',
      }).expect(201);
      await pagar(chofer.headers, cuenta.accountId, {
        amount: 500,
        method: 'cash',
      }).expect(201);
      await http()
        .post(`/driver-settlements/${mia.settlementId}/submit`)
        .set(chofer.headers)
        .send({ declaredCash: 2000 })
        .expect(201);
      await http()
        .patch(`/driver-settlements/${mia.settlementId}/approve`)
        .set(e.headers)
        .send({ cashBoxId: cajaId })
        .expect(200);
      const [caja] = await ds.query<Array<{ balance: string }>>(
        `SELECT balance FROM cash_box WHERE cash_box_id = $1`,
        [cajaId],
      );
      expect(Number(caja.balance)).toBe(2000);
      const entradas = await ds.query<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM cash_movement WHERE reference_type IN ('customer_payment', 'driver_settlement')`,
      );
      expect(entradas[0].n).toBe(1);
    });

    it('el chofer no manda caja (400), no cobra por otro medio (400) y no cobra en una cuenta ajena (404)', async () => {
      const { e, chofer, cuenta, cajaId } = await conChofer();
      await http()
        .get('/driver-settlements/mine')
        .set(chofer.headers)
        .expect(200);
      await pagar(chofer.headers, cuenta.accountId, {
        amount: 100,
        method: 'cash',
        cashBoxId: cajaId,
      }).expect(400);
      await pagar(chofer.headers, cuenta.accountId, {
        amount: 100,
        method: 'transfer',
      }).expect(400);
      const b = await f.distribuidora();
      const choferB = await f.chofer(b.distributorId);
      await http()
        .get('/driver-settlements/mine')
        .set(choferB.headers)
        .expect(200);
      await pagar(choferB.headers, cuenta.accountId, {
        amount: 100,
        method: 'cash',
      }).expect(404);
      void e;
    });

    it('el cliente no registra pagos (403)', async () => {
      const { cuenta, e } = await conChofer();
      const cliente = await f.cliente();
      const r = await http()
        .post(`/customer-accounts/${cuenta.accountId}/payments`)
        .set({
          Authorization: `Bearer ${
            (
              await ds.query<Array<{ email: string }>>(
                `SELECT email FROM "user" WHERE user_id = $1`,
                [cliente.userId],
              )
            )[0].email
          }`,
          'X-Client-Source': 'customer-app',
          'X-Distributor': e.slug,
        })
        .send({ amount: 100, method: 'cash' });
      expect(r.status).toBe(403);
    });
  });

  describe('ajustes (CU-329)', () => {
    it('una nota de débito sube la deuda y una de crédito la baja, con su motivo', async () => {
      const { e, cliente } = await armar();
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      const debito = cuerpo<Asiento>(
        await http()
          .post(`/customer-accounts/${cuenta.accountId}/adjustments`)
          .set(e.headers)
          .send({ kind: 'debit', amount: 750.5, reason: 'Flete no facturado' })
          .expect(201),
      );
      expect(debito).toMatchObject({
        type: 'debit_note',
        signedAmount: 750.5,
        balanceAfter: 750.5,
        pendingAmount: 750.5,
      });
      const credito = cuerpo<Asiento>(
        await http()
          .post(`/customer-accounts/${cuenta.accountId}/adjustments`)
          .set(e.headers)
          .send({ kind: 'credit', amount: 250.25, reason: 'Garrafa devuelta' })
          .expect(201),
      );
      expect(credito).toMatchObject({
        type: 'credit_note',
        signedAmount: -250.25,
        balanceAfter: 500.25,
      });
      const estado = cuerpo<Estado>(
        await http()
          .get(`/customer-accounts/${cuenta.accountId}/entries`)
          .set(e.headers)
          .expect(200),
      );
      // La nota de crédito se imputó al débito.
      expect(
        estado.data.find((a) => a.type === 'debit_note')?.pendingAmount,
      ).toBe(500.25);
    });

    it('valida tipo, motivo e importe (400), cuenta cerrada (409) y cuenta ajena (404)', async () => {
      const { e, cliente } = await armar();
      const b = await f.distribuidora();
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      const url = `/customer-accounts/${cuenta.accountId}/adjustments`;
      await http()
        .post(url)
        .set(e.headers)
        .send({ kind: 'otro', amount: 1, reason: 'x' })
        .expect(400);
      await http()
        .post(url)
        .set(e.headers)
        .send({ kind: 'debit', amount: 1 })
        .expect(400);
      await http()
        .post(url)
        .set(e.headers)
        .send({ kind: 'debit', amount: 1, reason: '  ' })
        .expect(400);
      await http()
        .post(url)
        .set(e.headers)
        .send({ kind: 'debit', amount: 0, reason: 'x' })
        .expect(400);
      await http()
        .post(url)
        .set(b.headers)
        .send({ kind: 'debit', amount: 1, reason: 'x' })
        .expect(404);
      await http()
        .patch(`/customer-accounts/${cuenta.accountId}`)
        .set(e.headers)
        .send({ status: 'closed' })
        .expect(200);
      await http()
        .post(url)
        .set(e.headers)
        .send({ kind: 'debit', amount: 1, reason: 'x' })
        .expect(409);
    });
  });

  describe('estado de cuenta y antigüedad (CU-238, CU-239)', () => {
    /** Inserta cargos viejos en el libro (como si hubieran pasado hace N días). */
    async function cargoViejo(
      cuentaId: string,
      distributorId: string,
      dias: number,
      monto: number,
    ) {
      const ocurrio = new Date(Date.now() - dias * 86_400_000);
      await ds.query(
        `INSERT INTO customer_account_entry (distributor_id, account_id, type, amount, due_date, occurred_at, description)
         VALUES ($1, $2, 'sale_charge', $3, $4, $5, 'Cargo de prueba')`,
        [
          distributorId,
          cuentaId,
          monto,
          diaArgentino(new Date(ocurrio.getTime() + 30 * 86_400_000)),
          ocurrio,
        ],
      );
      await ds.query(
        `UPDATE customer_account SET balance = balance + $2 WHERE account_id = $1`,
        [cuentaId, monto],
      );
    }

    it('reparte la deuda por antigüedad del comprobante, por cuenta y en total', async () => {
      const { e, cliente } = await armar();
      const otroCliente = await f.cliente('Beto');
      const c1 = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      const c2 = cuerpo<Cuenta>(
        await habilitar(e.headers, otroCliente.userId, {
          businessName: 'Kiosco Beto',
        }).expect(201),
      );
      await cargoViejo(c1.accountId, e.distributorId, 10, 1000);
      await cargoViejo(c1.accountId, e.distributorId, 45, 2000);
      await cargoViejo(c1.accountId, e.distributorId, 100, 4000);
      await cargoViejo(c2.accountId, e.distributorId, 70, 500);

      const detalle = await cuentaDe(e.headers, c1.accountId);
      expect(detalle.aging).toEqual({
        upTo30Days: 1000,
        from31To60Days: 2000,
        from61To90Days: 0,
        over90Days: 4000,
        total: 7000,
      });
      // Vencido: los cargos de hace 45 y 100 días ya pasaron su vencimiento a 30 días.
      expect(detalle.overdueAmount).toBe(6000);

      const reporte = cuerpo<{
        totals: Cuenta['aging'];
        accounts: Array<{
          accountId: string;
          businessName: string;
          total: number;
        }>;
      }>(
        await http().get('/customer-accounts/aging').set(e.headers).expect(200),
      );
      expect(reporte.totals).toEqual({
        upTo30Days: 1000,
        from31To60Days: 2000,
        from61To90Days: 500,
        over90Days: 4000,
        total: 7500,
      });
      expect(reporte.accounts.map((a) => [a.businessName, a.total])).toEqual([
        ['Panadería La Espiga S.R.L.', 7000],
        ['Kiosco Beto', 500],
      ]);
    });

    it('un pago baja la deuda del cargo más viejo y se nota en la antigüedad', async () => {
      const { e, cliente, cajaId } = await armar();
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      await cargoViejo(cuenta.accountId, e.distributorId, 45, 2000);
      await cargoViejo(cuenta.accountId, e.distributorId, 5, 1000);
      await abrirCaja(e, cajaId);
      await pagar(e.headers, cuenta.accountId, {
        amount: 2500,
        method: 'cash',
        cashBoxId: cajaId,
      }).expect(201);
      const detalle = await cuentaDe(e.headers, cuenta.accountId);
      expect(detalle.aging).toMatchObject({
        from31To60Days: 0,
        upTo30Days: 500,
        total: 500,
      });
    });

    it('el estado de cuenta lleva el saldo corrido y se acota por período', async () => {
      const { e, cliente } = await armar();
      const cuenta = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      await cargoViejo(cuenta.accountId, e.distributorId, 40, 1000);
      await cargoViejo(cuenta.accountId, e.distributorId, 20, 500);
      await http()
        .post(`/customer-accounts/${cuenta.accountId}/adjustments`)
        .set(e.headers)
        .send({ kind: 'credit', amount: 300, reason: 'Descuento' })
        .expect(201);

      const completo = cuerpo<Estado>(
        await http()
          .get(`/customer-accounts/${cuenta.accountId}/entries`)
          .set(e.headers)
          .expect(200),
      );
      expect(completo.data.map((a) => a.balanceAfter)).toEqual([
        1000, 1500, 1200,
      ]);
      expect(completo).toMatchObject({
        openingBalance: 0,
        closingBalance: 1200,
        total: 3,
      });

      const desde = diaArgentino(new Date(Date.now() - 25 * 86_400_000));
      const parcial = cuerpo<Estado>(
        await http()
          .get(`/customer-accounts/${cuenta.accountId}/entries`)
          .query({ from: desde })
          .set(e.headers)
          .expect(200),
      );
      expect(parcial).toMatchObject({
        openingBalance: 1000,
        closingBalance: 1200,
        total: 2,
      });
      expect(parcial.data.map((a) => a.balanceAfter)).toEqual([1500, 1200]);

      await http()
        .get(`/customer-accounts/${cuenta.accountId}/entries`)
        .query({ from: '2026-10-10', to: '2026-10-01' })
        .set(e.headers)
        .expect(400);
      await http()
        .get(`/customer-accounts/${cuenta.accountId}/entries`)
        .set((await f.distribuidora()).headers)
        .expect(404);
    });

    it('el listado filtra por estado, texto y deuda vencida', async () => {
      const { e, cliente } = await armar();
      const otro = await f.cliente('Beto Pérez');
      const c1 = cuerpo<Cuenta>(
        await habilitar(e.headers, cliente.userId).expect(201),
      );
      const c2 = cuerpo<Cuenta>(
        await habilitar(e.headers, otro.userId, {
          businessName: 'Kiosco Beto',
        }).expect(201),
      );
      await cargoViejo(c1.accountId, e.distributorId, 50, 1000);
      await http()
        .patch(`/customer-accounts/${c2.accountId}`)
        .set(e.headers)
        .send({ status: 'blocked' })
        .expect(200);

      const lista = async (q: Record<string, string>) =>
        cuerpo<Pagina<Cuenta>>(
          await http()
            .get('/customer-accounts')
            .query(q)
            .set(e.headers)
            .expect(200),
        );
      expect((await lista({})).total).toBe(2);
      expect(
        (await lista({ status: 'blocked' })).data.map((c) => c.accountId),
      ).toEqual([c2.accountId]);
      expect((await lista({ q: 'beto' })).data.map((c) => c.accountId)).toEqual(
        [c2.accountId],
      );
      expect((await lista({ q: CUIT })).total).toBe(2);
      expect(
        (await lista({ overdue: 'true' })).data.map((c) => c.accountId),
      ).toEqual([c1.accountId]);
      await http()
        .get('/customer-accounts')
        .query({ status: 'rara' })
        .set(e.headers)
        .expect(400);
    });
  });

  it('el libro de la cuenta es de solo agregar y su saldo es la suma de los asientos', async () => {
    const { e, cliente, cajaId } = await armar();
    const chofer = await f.chofer(e.distributorId);
    const cuenta = cuerpo<Cuenta>(
      await habilitar(e.headers, cliente.userId, { creditLimit: 50000 }).expect(
        201,
      ),
    );
    await abrirCaja(e, cajaId);
    await f.pedidoEntregado(e, {
      chofer,
      cliente,
      cantidad: 4,
      metodo: PaymentMethod.ACCOUNT,
    });
    await env.app.get(CustomerLedgerService).barrer();
    await pagar(e.headers, cuenta.accountId, {
      amount: 1234.56,
      method: 'cash',
      cashBoxId: cajaId,
    }).expect(201);
    await http()
      .post(`/customer-accounts/${cuenta.accountId}/adjustments`)
      .set(e.headers)
      .send({ kind: 'debit', amount: 10.1, reason: 'Ajuste' })
      .expect(201);
    const [{ libro }] = await ds.query<Array<{ libro: string }>>(
      `SELECT SUM(CASE WHEN type IN ('sale_charge', 'debit_note') THEN amount ELSE -amount END) AS libro
       FROM customer_account_entry WHERE account_id = $1`,
      [cuenta.accountId],
    );
    expect(Number(libro)).toBe(await saldoDe(cuenta.accountId));
    expect(Number(libro)).toBe(2775.54);
    void PaymentStatus;
  });
});
