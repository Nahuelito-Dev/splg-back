/**
 * Comisiones por entrega (M-D parte 4) contra la API con Postgres y Redis
 * reales: reglas con vigencia y solapamiento, devengo al entregar (precedencia,
 * idempotencia, copia de la regla, barrido), consulta del chofer, y liquidación
 * (borrador, aprobar, pagar contra la caja, anular, numeración y concurrencia).
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { codigoSqlDelError } from '../../src/common/errors/db-exceptions';
import { CommissionLedgerService } from '../../src/commission/application/commission-ledger.service';
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

interface Regla {
  ruleId: string;
  employeeId: string | null;
  employeeName: string | null;
  gasCylinderId: string | null;
  gasCylinderType: string | null;
  basis: string;
  value: number;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
}
interface Asiento {
  entryId: string;
  employeeId: string;
  type: string;
  amount: number;
  orderId: string | null;
  ruleId: string | null;
  liquidationId: string | null;
}
interface Asientos {
  data: Asiento[];
  total: number;
  totalAmount: number;
}
interface Liquidacion {
  liquidationId: string;
  number: number;
  employeeName: string;
  gross: number;
  deductions: number;
  net: number;
  status: string;
  cashMovementId: string | null;
  entries?: Asiento[];
}
interface Mias extends Asientos {
  pendingAmount: number;
  liquidatedAmount: number;
}
interface Pagina<T> {
  data: T[];
  total: number;
}
interface Caja {
  cashBoxId: string;
  balance: number;
}

describe('Comisiones (e2e)', () => {
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
    const chofer = await f.chofer(e.distributorId, 'Juan Pérez');
    const cliente = await f.cliente();
    const [central] = cuerpo<Pagina<Caja>>(
      await http().get('/cash-boxes').set(e.headers).expect(200),
    ).data;
    return { e, chofer, cliente, cajaId: central.cashBoxId };
  }

  const crearRegla = (h: Headers, body: Record<string, unknown>) =>
    http()
      .post('/commission-rules')
      .set(h)
      .send({
        basis: 'per_unit',
        value: 100,
        validFrom: '2020-01-01',
        ...body,
      });

  /** Entrega un pedido de verdad (por la máquina de estados) para que se publique el evento. */
  async function entregarPedido(
    e: Entorno,
    chofer: { deliveryId: string },
    cliente: { userId: string; addressId: string },
    cantidad = 1,
  ) {
    const o = await f.pedidoEntregado(e, { chofer, cliente, cantidad });
    await ds.query(
      `UPDATE "order" SET status = 'on_the_way', "deliveredAt" = NULL WHERE order_id = $1`,
      [o.orderId],
    );
    await entregarComoAdmin(env, o.orderId);
    return o;
  }

  const asientosDe = async (h: Headers, q: Record<string, string> = {}) =>
    cuerpo<Asientos>(
      await http().get('/commissions').query(q).set(h).expect(200),
    );

  describe('reglas (CU-240, CU-333)', () => {
    it('crea una regla general y otra por chofer y producto, con sus nombres', async () => {
      const { e, chofer } = await armar();
      const general = cuerpo<Regla>(
        await crearRegla(e.headers, { value: 150 }).expect(201),
      );
      expect(general).toMatchObject({
        employeeId: null,
        employeeName: null,
        gasCylinderId: null,
        basis: 'per_unit',
        value: 150,
        validTo: null,
        isActive: true,
      });
      const propia = cuerpo<Regla>(
        await crearRegla(e.headers, {
          employeeId: chofer.employeeId,
          gasCylinderId: e.garrafa.gasCylinderId,
          basis: 'percent_of_total',
          value: 2.5,
        }).expect(201),
      );
      expect(propia).toMatchObject({
        employeeName: expect.stringContaining('Juan') as string,
        gasCylinderType: '10kg',
        value: 2.5,
      });
      const lista = cuerpo<Pagina<Regla>>(
        await http().get('/commission-rules').set(e.headers).expect(200),
      );
      expect(lista.total).toBe(2);
    });

    it('valida base, valor negativo, porcentaje mayor a 100 y vigencia al revés (400)', async () => {
      const { e } = await armar();
      await crearRegla(e.headers, { basis: 'por_kilo' }).expect(400);
      await crearRegla(e.headers, { value: -1 }).expect(400);
      await crearRegla(e.headers, {
        basis: 'percent_of_total',
        value: 100.5,
      }).expect(400);
      await crearRegla(e.headers, {
        validFrom: '2026-10-10',
        validTo: '2026-10-01',
      }).expect(400);
      await crearRegla(e.headers, { validFrom: '2026-02-31' }).expect(400);
      await crearRegla(e.headers, {
        basis: 'percent_of_total',
        value: 100,
      }).expect(201);
    });

    it('un empleado o un producto inexistente o de otra distribuidora es 404', async () => {
      const { e } = await armar();
      const b = await f.distribuidora();
      const choferB = await f.chofer(b.distributorId);
      await crearRegla(e.headers, { employeeId: randomUUID() }).expect(404);
      await crearRegla(e.headers, { employeeId: choferB.employeeId }).expect(
        404,
      );
      await crearRegla(e.headers, {
        gasCylinderId: b.garrafa.gasCylinderId,
      }).expect(404);
    });

    it('rechaza solaparse con otra regla vigente del mismo alcance; los alcances distintos y los períodos contiguos conviven', async () => {
      const { e, chofer } = await armar();
      await crearRegla(e.headers, {
        validFrom: '2026-10-01',
        validTo: '2026-10-31',
      }).expect(201);
      await crearRegla(e.headers, {
        validFrom: '2026-10-31',
        validTo: null,
      }).expect(409);
      await crearRegla(e.headers, {
        validFrom: '2026-11-01',
        validTo: '2026-11-30',
      }).expect(201);
      // Otro alcance (un chofer) puede coincidir en fechas.
      await crearRegla(e.headers, {
        employeeId: chofer.employeeId,
        validFrom: '2026-10-01',
        validTo: '2026-10-31',
      }).expect(201);
    });

    it('reglas simultáneas del mismo alcance: sólo una entra', async () => {
      const { e } = await armar();
      const respuestas = await Promise.all(
        Array.from({ length: 5 }, () =>
          crearRegla(e.headers, { validFrom: '2026-10-01' }),
        ),
      );
      expect(respuestas.map((r) => r.status).sort()).toEqual([
        201, 409, 409, 409, 409,
      ]);
    });

    it('modifica el valor, cierra la vigencia y desactiva; no deja solaparse y no toca lo ya devengado', async () => {
      const { e, chofer, cliente } = await armar();
      const regla = cuerpo<Regla>(
        await crearRegla(e.headers, { value: 100 }).expect(201),
      );
      await entregarPedido(e, chofer, cliente, 2);
      expect((await asientosDe(e.headers)).data[0].amount).toBe(200);

      const editada = cuerpo<Regla>(
        await http()
          .patch(`/commission-rules/${regla.ruleId}`)
          .set(e.headers)
          .send({ value: 500, validTo: '2099-12-31' })
          .expect(200),
      );
      expect(editada).toMatchObject({ value: 500, validTo: '2099-12-31' });
      // Lo devengado conserva el importe con que se calculó.
      expect((await asientosDe(e.headers)).data[0].amount).toBe(200);

      const otra = cuerpo<Regla>(
        await crearRegla(e.headers, { validFrom: '2100-01-01' }).expect(201),
      );
      await http()
        .patch(`/commission-rules/${otra.ruleId}`)
        .set(e.headers)
        .send({ validFrom: '2099-06-01' })
        .expect(409);
      await http()
        .patch(`/commission-rules/${regla.ruleId}`)
        .set(e.headers)
        .send({ validTo: null })
        .expect(409);
      await http()
        .patch(`/commission-rules/${regla.ruleId}`)
        .set(e.headers)
        .send({ isActive: false })
        .expect(200);
      await http()
        .patch(`/commission-rules/${regla.ruleId}`)
        .set(e.headers)
        .send({ basis: 'percent_of_total', value: 101 })
        .expect(400);
    });

    it('una regla de otra distribuidora es 404', async () => {
      const { e } = await armar();
      const b = await f.distribuidora();
      const regla = cuerpo<Regla>(await crearRegla(e.headers, {}).expect(201));
      await http()
        .patch(`/commission-rules/${regla.ruleId}`)
        .set(b.headers)
        .send({ value: 1 })
        .expect(404);
      expect(
        cuerpo<Pagina<Regla>>(
          await http().get('/commission-rules').set(b.headers).expect(200),
        ).total,
      ).toBe(0);
    });
  });

  describe('devengar al entregar (CU-241)', () => {
    it('genera un asiento por entrega con la regla vigente y una copia de ella', async () => {
      const { e, chofer, cliente } = await armar();
      const regla = cuerpo<Regla>(
        await crearRegla(e.headers, { value: 150 }).expect(201),
      );
      const pedido = await entregarPedido(e, chofer, cliente, 3);

      const r = await asientosDe(e.headers);
      expect(r.total).toBe(1);
      expect(r.data[0]).toMatchObject({
        type: 'delivery_commission',
        amount: 450,
        orderId: pedido.orderId,
        ruleId: regla.ruleId,
        employeeId: chofer.employeeId,
        liquidationId: null,
      });
      const [fila] = await ds.query<
        Array<{
          rule_snapshot: Array<{
            ruleId: string;
            amount: number;
            quantity: number;
          }>;
        }>
      >(`SELECT rule_snapshot FROM commission_entry WHERE order_id = $1`, [
        pedido.orderId,
      ]);
      expect(fila.rule_snapshot).toEqual([
        expect.objectContaining({
          ruleId: regla.ruleId,
          amount: 450,
          quantity: 3,
        }),
      ]);
    });

    it('es idempotente: devengar de nuevo no duplica', async () => {
      const { e, chofer, cliente } = await armar();
      await crearRegla(e.headers, {}).expect(201);
      const pedido = await entregarPedido(e, chofer, cliente);
      const ledger = env.app.get(CommissionLedgerService);
      expect(await ledger.devengarPorPedido(pedido.orderId)).toBe('existente');
      const [{ n }] = await ds.query<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM commission_entry WHERE order_id = $1`,
        [pedido.orderId],
      );
      expect(n).toBe(1);
    });

    it('gana la regla más específica: chofer y producto > chofer > producto > general', async () => {
      const { e, chofer, cliente } = await armar();
      const otro = await f.chofer(e.distributorId, 'Otro');
      await crearRegla(e.headers, { value: 10 }).expect(201);
      await crearRegla(e.headers, {
        gasCylinderId: e.garrafa.gasCylinderId,
        value: 20,
      }).expect(201);
      await crearRegla(e.headers, {
        employeeId: chofer.employeeId,
        value: 30,
      }).expect(201);
      await crearRegla(e.headers, {
        employeeId: chofer.employeeId,
        gasCylinderId: e.garrafa.gasCylinderId,
        value: 40,
      }).expect(201);
      await entregarPedido(e, chofer, cliente, 1);
      await entregarPedido(e, otro, cliente, 1);
      const r = await asientosDe(e.headers);
      const de = (emp: string) =>
        r.data.find((a) => a.employeeId === emp)?.amount;
      expect(de(chofer.employeeId)).toBe(40);
      // El otro chofer: producto > general.
      expect(de(otro.employeeId)).toBe(20);
    });

    it('sin regla vigente ese día no hay asiento; una regla futura tampoco cuenta', async () => {
      const { e, chofer, cliente } = await armar();
      await crearRegla(e.headers, { validFrom: '2999-01-01' }).expect(201);
      const pedido = await entregarPedido(e, chofer, cliente);
      expect((await asientosDe(e.headers)).total).toBe(0);
      expect(
        await env.app
          .get(CommissionLedgerService)
          .devengarPorPedido(pedido.orderId),
      ).toBe('sin-regla');
    });

    it('el porcentaje se redondea a centavos', async () => {
      const { e, chofer, cliente } = await armar();
      await crearRegla(e.headers, {
        basis: 'percent_of_total',
        value: 3.333,
      }).expect(201);
      await entregarPedido(e, chofer, cliente, 1);
      expect((await asientosDe(e.headers)).data[0].amount).toBe(33.33);
    });

    it('un pedido sin chofer o sin legajo no devenga', async () => {
      const { e, cliente } = await armar();
      await crearRegla(e.headers, {}).expect(201);
      const ledger = env.app.get(CommissionLedgerService);
      const sinChofer = await f.pedidoEntregado(e, { chofer: null, cliente });
      expect(await ledger.devengarPorPedido(sinChofer.orderId)).toBe(
        'no-entregado',
      );
      // Chofer con perfil pero sin legajo.
      const sinLegajo = await f.chofer(e.distributorId);
      await ds.query(
        `UPDATE employee SET user_id = NULL WHERE employee_id = $1`,
        [sinLegajo.employeeId],
      );
      const pedido = await f.pedidoEntregado(e, { chofer: sinLegajo, cliente });
      expect(await ledger.devengarPorPedido(pedido.orderId)).toBe('sin-chofer');
    });

    it('el barrido nocturno recupera las entregas que se quedaron sin asiento', async () => {
      const { e, chofer, cliente } = await armar();
      await crearRegla(e.headers, { value: 50 }).expect(201);
      await f.pedidoEntregado(e, { chofer, cliente, cantidad: 2 });
      await f.pedidoEntregado(e, { chofer, cliente, cantidad: 1 });
      const ledger = env.app.get(CommissionLedgerService);
      expect(await ledger.barrer()).toBe(2);
      expect(await ledger.barrer()).toBe(0);
      expect((await asientosDe(e.headers)).totalAmount).toBe(150);
    });
  });

  describe('consultas (CU-244)', () => {
    async function conEntregas() {
      const base = await armar();
      await crearRegla(base.e.headers, { value: 100 }).expect(201);
      await entregarPedido(base.e, base.chofer, base.cliente, 2);
      await entregarPedido(base.e, base.chofer, base.cliente, 1);
      return base;
    }

    it('el administrador filtra por chofer, tipo, período y liquidación', async () => {
      const { e, chofer } = await conEntregas();
      const otro = await f.chofer(e.distributorId);
      expect(
        (await asientosDe(e.headers, { employeeId: chofer.employeeId })).total,
      ).toBe(2);
      expect(
        (await asientosDe(e.headers, { employeeId: otro.employeeId })).total,
      ).toBe(0);
      expect(
        (await asientosDe(e.headers, { type: 'settlement_shortage' })).total,
      ).toBe(0);
      expect(
        (await asientosDe(e.headers, { liquidated: 'false' })).totalAmount,
      ).toBe(300);
      expect((await asientosDe(e.headers, { liquidated: 'true' })).total).toBe(
        0,
      );
      expect(
        (await asientosDe(e.headers, { from: '2000-01-01', to: '2000-12-31' }))
          .total,
      ).toBe(0);
      await http()
        .get('/commissions')
        .query({ from: '2026-02-31' })
        .set(e.headers)
        .expect(400);
      await http()
        .get('/commissions')
        .query({ from: '2026-10-10', to: '2026-10-01' })
        .set(e.headers)
        .expect(400);
    });

    it('el chofer ve sólo las suyas, con lo pendiente y lo liquidado', async () => {
      const { e, chofer, cliente } = await conEntregas();
      const otro = await f.chofer(e.distributorId, 'Otro');
      await entregarPedido(e, otro, cliente, 9);
      const mias = cuerpo<Mias>(
        await http().get('/commissions/mine').set(chofer.headers).expect(200),
      );
      expect(mias).toMatchObject({
        total: 2,
        totalAmount: 300,
        pendingAmount: 300,
        liquidatedAmount: 0,
      });
      expect(mias.data.every((a) => a.employeeId === chofer.employeeId)).toBe(
        true,
      );

      await http()
        .post('/driver-liquidations')
        .set(e.headers)
        .send({
          employeeId: chofer.employeeId,
          periodFrom: '2000-01-01',
          periodTo: '2100-01-01',
        })
        .expect(201);
      const despues = cuerpo<Mias>(
        await http().get('/commissions/mine').set(chofer.headers).expect(200),
      );
      expect(despues).toMatchObject({
        pendingAmount: 0,
        liquidatedAmount: 300,
      });
    });

    it('un administrador no tiene "mis comisiones" (403) y un chofer sin legajo recibe 404', async () => {
      const { e } = await armar();
      await http().get('/commissions/mine').set(e.headers).expect(403);
      const sinLegajo = await f.chofer(e.distributorId);
      await ds.query(
        `UPDATE employee SET user_id = NULL WHERE employee_id = $1`,
        [sinLegajo.employeeId],
      );
      await http().get('/commissions/mine').set(sinLegajo.headers).expect(404);
    });

    it('las comisiones de otra distribuidora no se ven', async () => {
      const { e } = await conEntregas();
      const b = await f.distribuidora();
      expect((await asientosDe(b.headers)).total).toBe(0);
      void e;
    });
  });

  describe('liquidar (CU-242, 334, 335, 243)', () => {
    async function conComisiones(monto = 100) {
      const base = await armar();
      await crearRegla(base.e.headers, { value: monto }).expect(201);
      await entregarPedido(base.e, base.chofer, base.cliente, 2);
      await entregarPedido(base.e, base.chofer, base.cliente, 3);
      return base;
    }

    const liquidar = (
      h: Headers,
      employeeId: string,
      extra: Record<string, unknown> = {},
    ) =>
      http()
        .post('/driver-liquidations')
        .set(h)
        .send({
          employeeId,
          periodFrom: '2000-01-01',
          periodTo: '2100-01-01',
          ...extra,
        });

    const fondear = async (e: Entorno, cajaId: string, monto: number) => {
      await http()
        .post(`/cash-boxes/${cajaId}/sessions`)
        .set(e.headers)
        .send({ openingAmount: monto })
        .expect(201);
    };

    it('toma los asientos del período y calcula bruto, deducciones y neto; nace en borrador y numerada', async () => {
      const { e, chofer } = await conComisiones();
      // Una deducción por faltante de rendición.
      await ds.query(
        `INSERT INTO commission_entry (distributor_id, employee_id, delivery_id, type, amount, description)
         VALUES ($1, $2, $3, 'settlement_shortage', -120.5, 'Faltante')`,
        [e.distributorId, chofer.employeeId, chofer.deliveryId],
      );
      const l = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      expect(l).toMatchObject({
        number: 1,
        status: 'draft',
        gross: 500,
        deductions: 120.5,
        net: 379.5,
        employeeName: expect.stringContaining('Juan') as string,
      });
      const detalle = cuerpo<Liquidacion>(
        await http()
          .get(`/driver-liquidations/${l.liquidationId}`)
          .set(e.headers)
          .expect(200),
      );
      expect(detalle.entries).toHaveLength(3);
      expect((await asientosDe(e.headers, { liquidated: 'false' })).total).toBe(
        0,
      );
    });

    it('no hay nada que liquidar (409), período inválido (400), empleado inexistente (404) o de otra distribuidora (404)', async () => {
      const { e, chofer } = await conComisiones();
      await liquidar(e.headers, chofer.employeeId, {
        periodFrom: '2000-01-01',
        periodTo: '2000-01-31',
      }).expect(409);
      await liquidar(e.headers, chofer.employeeId, {
        periodFrom: '2026-10-10',
        periodTo: '2026-10-01',
      }).expect(400);
      await liquidar(e.headers, chofer.employeeId, {
        periodFrom: '2026-13-01',
      }).expect(400);
      await liquidar(e.headers, randomUUID()).expect(404);
      const b = await f.distribuidora();
      await liquidar(b.headers, chofer.employeeId).expect(404);
      await liquidar(e.headers, chofer.employeeId).expect(201);
      await liquidar(e.headers, chofer.employeeId).expect(409);
    });

    it('dos liquidaciones simultáneas del mismo chofer no toman el mismo asiento', async () => {
      const { e, chofer } = await conComisiones();
      const respuestas = await Promise.all(
        Array.from({ length: 4 }, () => liquidar(e.headers, chofer.employeeId)),
      );
      expect(respuestas.map((r) => r.status).sort()).toEqual([
        201, 409, 409, 409,
      ]);
      const [{ n }] = await ds.query<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM driver_liquidation`,
      );
      expect(n).toBe(1);
      expect(mockReintentos.n).toBe(0);
    });

    it('la numeración es correlativa por distribuidora y sin huecos', async () => {
      const { e, chofer, cliente } = await conComisiones();
      const l1 = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      await entregarPedido(e, chofer, cliente, 1);
      const l2 = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      expect([l1.number, l2.number]).toEqual([1, 2]);
      // Una que falla no consume número.
      await liquidar(e.headers, chofer.employeeId).expect(409);
      await entregarPedido(e, chofer, cliente, 1);
      const l3 = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      expect(l3.number).toBe(3);
    });

    it('aprobar sólo un borrador; pagar sólo una aprobada: el egreso del neto sale de la caja con su categoría', async () => {
      const { e, chofer, cajaId } = await conComisiones();
      await fondear(e, cajaId, 10000);
      const l = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      const id = l.liquidationId;

      await http()
        .patch(`/driver-liquidations/${id}/pay`)
        .set(e.headers)
        .send({ cashBoxId: cajaId })
        .expect(409);
      const aprobada = cuerpo<Liquidacion>(
        await http()
          .patch(`/driver-liquidations/${id}/approve`)
          .set(e.headers)
          .expect(200),
      );
      expect(aprobada.status).toBe('approved');
      await http()
        .patch(`/driver-liquidations/${id}/approve`)
        .set(e.headers)
        .expect(409);

      const pagada = cuerpo<Liquidacion>(
        await http()
          .patch(`/driver-liquidations/${id}/pay`)
          .set(e.headers)
          .send({ cashBoxId: cajaId })
          .expect(200),
      );
      expect(pagada).toMatchObject({ status: 'paid', net: 500 });
      expect(pagada.cashMovementId).not.toBeNull();
      const [caja] = await ds.query<Array<{ balance: string }>>(
        `SELECT balance FROM cash_box WHERE cash_box_id = $1`,
        [cajaId],
      );
      expect(Number(caja.balance)).toBe(9500);
      const [mov] = await ds.query<
        Array<{ direction: string; amount: string; name: string }>
      >(
        `SELECT m.direction, m.amount, c.name FROM cash_movement m JOIN cash_category c ON c.category_id = m.category_id
         WHERE m.movement_id = $1`,
        [pagada.cashMovementId],
      );
      expect(mov).toEqual({
        direction: 'out',
        amount: '500.00',
        name: 'Pago de comisiones',
      });

      await http()
        .patch(`/driver-liquidations/${id}/pay`)
        .set(e.headers)
        .send({ cashBoxId: cajaId })
        .expect(409);
      await http()
        .patch(`/driver-liquidations/${id}/void`)
        .set(e.headers)
        .expect(409);
    });

    it('pagar con una caja de efectivo sin saldo o sin sesión es 409 y la caja ajena es 404; nada queda a medias', async () => {
      const { e, chofer, cajaId } = await conComisiones();
      const l = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      await http()
        .patch(`/driver-liquidations/${l.liquidationId}/approve`)
        .set(e.headers)
        .expect(200);
      const pagar = (caja: string) =>
        http()
          .patch(`/driver-liquidations/${l.liquidationId}/pay`)
          .set(e.headers)
          .send({ cashBoxId: caja });
      await pagar(cajaId).expect(409);
      await fondear(e, cajaId, 100);
      await pagar(cajaId).expect(409);
      const b = await f.distribuidora();
      const [ajena] = cuerpo<Pagina<Caja>>(
        await http().get('/cash-boxes').set(b.headers).expect(200),
      ).data;
      await pagar(ajena.cashBoxId).expect(404);
      const detalle = cuerpo<Liquidacion>(
        await http()
          .get(`/driver-liquidations/${l.liquidationId}`)
          .set(e.headers)
          .expect(200),
      );
      expect(detalle).toMatchObject({
        status: 'approved',
        cashMovementId: null,
      });
    });

    it('un neto que no es positivo no se paga (409)', async () => {
      const { e, chofer, cajaId } = await conComisiones();
      await ds.query(
        `INSERT INTO commission_entry (distributor_id, employee_id, type, amount, description)
         VALUES ($1, $2, 'settlement_shortage', -900, 'Faltante grande')`,
        [e.distributorId, chofer.employeeId],
      );
      await fondear(e, cajaId, 1000);
      const l = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      expect(l.net).toBe(-400);
      await http()
        .patch(`/driver-liquidations/${l.liquidationId}/approve`)
        .set(e.headers)
        .expect(200);
      await http()
        .patch(`/driver-liquidations/${l.liquidationId}/pay`)
        .set(e.headers)
        .send({ cashBoxId: cajaId })
        .expect(409);
    });

    it('anular un borrador o una aprobada libera los asientos para otra liquidación; no se anula dos veces', async () => {
      const { e, chofer } = await conComisiones();
      const l = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      await http()
        .patch(`/driver-liquidations/${l.liquidationId}/approve`)
        .set(e.headers)
        .expect(200);
      const anulada = cuerpo<Liquidacion>(
        await http()
          .patch(`/driver-liquidations/${l.liquidationId}/void`)
          .set(e.headers)
          .expect(200),
      );
      expect(anulada.status).toBe('voided');
      expect((await asientosDe(e.headers, { liquidated: 'false' })).total).toBe(
        2,
      );
      await http()
        .patch(`/driver-liquidations/${l.liquidationId}/void`)
        .set(e.headers)
        .expect(409);
      await http()
        .patch(`/driver-liquidations/${l.liquidationId}/approve`)
        .set(e.headers)
        .expect(409);
      const otra = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      expect(otra).toMatchObject({ number: 2, gross: 500 });
    });

    it('una liquidación de otra distribuidora es 404 en todo', async () => {
      const { e, chofer } = await conComisiones();
      const b = await f.distribuidora();
      const l = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      await http()
        .get(`/driver-liquidations/${l.liquidationId}`)
        .set(b.headers)
        .expect(404);
      await http()
        .patch(`/driver-liquidations/${l.liquidationId}/approve`)
        .set(b.headers)
        .expect(404);
      await http()
        .patch(`/driver-liquidations/${l.liquidationId}/void`)
        .set(b.headers)
        .expect(404);
      await http()
        .patch(`/driver-liquidations/${l.liquidationId}/pay`)
        .set(b.headers)
        .send({ cashBoxId: randomUUID() })
        .expect(404);
      expect(
        cuerpo<Pagina<Liquidacion>>(
          await http().get('/driver-liquidations').set(b.headers).expect(200),
        ).total,
      ).toBe(0);
    });

    it('el listado filtra por chofer y estado', async () => {
      const { e, chofer, cliente } = await conComisiones();
      const otro = await f.chofer(e.distributorId, 'Otro');
      await entregarPedido(e, otro, cliente, 1);
      const l1 = cuerpo<Liquidacion>(
        await liquidar(e.headers, chofer.employeeId).expect(201),
      );
      await liquidar(e.headers, otro.employeeId).expect(201);
      await http()
        .patch(`/driver-liquidations/${l1.liquidationId}/approve`)
        .set(e.headers)
        .expect(200);
      const lista = async (q: Record<string, string>) =>
        cuerpo<Pagina<Liquidacion>>(
          await http()
            .get('/driver-liquidations')
            .query(q)
            .set(e.headers)
            .expect(200),
        );
      expect((await lista({})).total).toBe(2);
      expect((await lista({ employeeId: chofer.employeeId })).total).toBe(1);
      expect((await lista({ status: 'approved' })).data[0].liquidationId).toBe(
        l1.liquidationId,
      );
      expect((await lista({ status: 'paid' })).total).toBe(0);
      await http()
        .get('/driver-liquidations')
        .query({ status: 'rara' })
        .set(e.headers)
        .expect(400);
    });
  });
});
