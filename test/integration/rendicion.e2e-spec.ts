/**
 * Rendición diaria del chofer (M-D parte 2) contra la API con Postgres y Redis
 * reales: generación, esperado en vivo (efectivo, seña, impagos), presentar,
 * aprobar contra la caja, diferencias y su resolución, reabrir, atadura a la
 * carga del camión, un pedido en una sola rendición, procesos nocturnos,
 * aislamiento por chofer y por distribuidora, e idempotencia y concurrencia.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { codigoSqlDelError } from '../../src/common/errors/db-exceptions';
import { DriverSettlementCron } from '../../src/driver-settlement/application/driver-settlement.cron';
import { DriverSettlementService } from '../../src/driver-settlement/application/driver-settlement.service';
import { EmailSenderPort } from '../../src/email/ports/email-sender.port';
import {
  PaymentMethod,
  PaymentStatus,
} from '../../src/order/entities/order.entity';
import { diaArgentino } from '../../src/common/utils/dias-argentina';
import { Car } from '../../src/car/entities/car.entity';
import { WarehouseService } from '../../src/stock/application/warehouse.service';
import { conIdempotencia } from './setup/con-idempotencia';
import { Finanzas, Headers, cuerpo } from './setup/finanzas';
import { TestEnv, createTestApp, truncateAllTables } from './setup/test-env';
import { forzarEstado } from './setup/bypass';

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

interface Rendicion {
  settlementId: string;
  number: number;
  deliveryId: string;
  driverName: string;
  businessDate: string;
  status: string;
  expectedCash: number;
  declaredCash: number | null;
  driverExpenses: number;
  difference: number | null;
  differenceResolution: string | null;
  truckLoadId: string | null;
  cashMovementId: string | null;
  cashFromOrders: number;
  cashFromCollections: number;
  truckLoadStatus: string | null;
  orders: Array<{ orderId: string; amountToCollect: number }>;
  expenses: Array<{ categoryName: string; amount: number }>;
}
interface Caja {
  cashBoxId: string;
  balance: number;
}
interface Categoria {
  categoryId: string;
  systemCode: string | null;
}
interface Pagina<T> {
  data: T[];
  total: number;
}

describe('Rendición del chofer (e2e)', () => {
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
  type Chofer = Awaited<ReturnType<Finanzas['chofer']>>;
  const hoy = () => diaArgentino();

  /** Un entorno con admin, chofer, cliente y la caja central abierta con $0. */
  async function armar() {
    const e = await f.distribuidora();
    const chofer = await f.chofer(e.distributorId, 'Juan Pérez');
    const cliente = await f.cliente();
    const [central] = cuerpo<Pagina<Caja>>(
      await http().get('/cash-boxes').set(e.headers).expect(200),
    ).data;
    await http()
      .post(`/cash-boxes/${central.cashBoxId}/sessions`)
      .set(e.headers)
      .send({ openingAmount: 0 })
      .expect(201);
    const categorias = cuerpo<Pagina<Categoria>>(
      await http().get('/cash-categories').set(e.headers).expect(200),
    ).data;
    const gasto = cuerpo<Categoria>(
      await http()
        .post('/cash-categories')
        .set(e.headers)
        .send({ name: 'Combustible chofer', direction: 'expense' })
        .expect(201),
    );
    return { e, chofer, cliente, cajaId: central.cashBoxId, gasto, categorias };
  }

  const entregar = (
    e: Entorno,
    chofer: Chofer,
    cliente: { userId: string; addressId: string },
    extra: Partial<Parameters<Finanzas['pedidoEntregado']>[1]> = {},
  ) => f.pedidoEntregado(e, { chofer, cliente, ...extra });

  const abrirRendicion = async (
    e: Entorno,
    chofer: Chofer,
    businessDate = hoy(),
  ) =>
    cuerpo<Rendicion>(
      await http()
        .post('/driver-settlements')
        .set(e.headers)
        .send({ deliveryId: chofer.deliveryId, businessDate })
        .expect(201),
    );

  const presentar = (h: Headers, id: string, body: Record<string, unknown>) =>
    http().post(`/driver-settlements/${id}/submit`).set(h).send(body);

  const aprobar = (h: Headers, id: string, body: Record<string, unknown>) =>
    http().patch(`/driver-settlements/${id}/approve`).set(h).send(body);

  const saldoDe = async (id: string) =>
    Number(
      (
        await ds.query<Array<{ balance: string }>>(
          `SELECT balance FROM cash_box WHERE cash_box_id = $1`,
          [id],
        )
      )[0].balance,
    );

  describe('el esperado (CU-231)', () => {
    it('suma el efectivo cobrado o pendiente, descuenta la seña y deja afuera impagos y otros medios', async () => {
      const { e, chofer, cliente } = await armar();
      await entregar(e, chofer, cliente, {
        cantidad: 2,
        estadoDePago: PaymentStatus.PAID,
      });
      await entregar(e, chofer, cliente, {
        cantidad: 1,
        estadoDePago: PaymentStatus.PENDING,
      });
      await entregar(e, chofer, cliente, {
        cantidad: 3,
        sena: 1000,
        estadoDePago: PaymentStatus.PAID,
      });
      await entregar(e, chofer, cliente, {
        cantidad: 5,
        estadoDePago: PaymentStatus.UNPAID,
      });
      await entregar(e, chofer, cliente, {
        cantidad: 7,
        estadoDePago: PaymentStatus.WRITTEN_OFF,
      });
      await entregar(e, chofer, cliente, {
        cantidad: 4,
        metodo: PaymentMethod.TRANSFER,
        estadoDePago: PaymentStatus.PAID,
      });
      const otro = await f.chofer(e.distributorId, 'Otro chofer');
      await entregar(e, otro, cliente, {
        cantidad: 9,
        estadoDePago: PaymentStatus.PAID,
      });

      const r = await abrirRendicion(e, chofer);
      expect(r).toMatchObject({
        status: 'open',
        driverName: 'Juan Pérez',
        number: 1,
      });
      // 2000 + 1000 + (3000 − seña 1000)
      expect(r.cashFromOrders).toBe(5000);
      expect(r.expectedCash).toBe(5000);
      expect(r.orders).toHaveLength(3);
    });

    it('el chofer abre su propia rendición al pedirla (mine) y es idempotente', async () => {
      const { e, chofer, cliente } = await armar();
      await entregar(e, chofer, cliente, { estadoDePago: PaymentStatus.PAID });
      const uno = cuerpo<Rendicion>(
        await http()
          .get('/driver-settlements/mine')
          .set(chofer.headers)
          .expect(200),
      );
      const dos = cuerpo<Rendicion>(
        await http()
          .get('/driver-settlements/mine')
          .set(chofer.headers)
          .expect(200),
      );
      expect(uno.settlementId).toBe(dos.settlementId);
      expect(uno.expectedCash).toBe(1000);
      // Un administrador no tiene "mi rendición".
      await http().get('/driver-settlements/mine').set(e.headers).expect(403);
    });

    it('abrir dos veces la del mismo día para un chofer es 409; un chofer ajeno es 404', async () => {
      const { e, chofer } = await armar();
      await abrirRendicion(e, chofer);
      await http()
        .post('/driver-settlements')
        .set(e.headers)
        .send({ deliveryId: chofer.deliveryId, businessDate: hoy() })
        .expect(409);
      await http()
        .post('/driver-settlements')
        .set(e.headers)
        .send({ deliveryId: randomUUID(), businessDate: hoy() })
        .expect(404);
      const b = await f.distribuidora();
      await http()
        .post('/driver-settlements')
        .set(b.headers)
        .send({ deliveryId: chofer.deliveryId, businessDate: hoy() })
        .expect(404);
    });

    it('la fecha tiene que ser real (400)', async () => {
      const { e, chofer } = await armar();
      await http()
        .post('/driver-settlements')
        .set(e.headers)
        .send({ deliveryId: chofer.deliveryId, businessDate: '2026-02-30' })
        .expect(400);
    });
  });

  describe('declarar el efectivo (CU-232)', () => {
    it('el chofer declara con gastos: la diferencia es declarado + gastos − esperado', async () => {
      const { e, chofer, cliente, gasto } = await armar();
      await entregar(e, chofer, cliente, {
        cantidad: 5,
        estadoDePago: PaymentStatus.PAID,
      });
      const r = await abrirRendicion(e, chofer);

      const presentada = cuerpo<Rendicion>(
        await presentar(chofer.headers, r.settlementId, {
          declaredCash: 4300,
          expenses: [
            { categoryId: gasto.categoryId, amount: 500, description: 'Nafta' },
          ],
        }).expect(201),
      );
      expect(presentada).toMatchObject({
        status: 'submitted',
        expectedCash: 5000,
        declaredCash: 4300,
        driverExpenses: 500,
        difference: -200,
      });
      expect(presentada.expenses).toEqual([
        expect.objectContaining({
          categoryName: 'Combustible chofer',
          amount: 500,
        }),
      ]);
      // Presentada, ya no se presenta de nuevo.
      await presentar(chofer.headers, r.settlementId, {
        declaredCash: 5000,
      }).expect(409);
    });

    it('valida: efectivo o gasto negativo, gasto sin categoría de egreso y categoría inexistente (400)', async () => {
      const { e, chofer, gasto, categorias } = await armar();
      const r = await abrirRendicion(e, chofer);
      await presentar(chofer.headers, r.settlementId, {
        declaredCash: -1,
      }).expect(400);
      await presentar(chofer.headers, r.settlementId, {
        declaredCash: 0,
        expenses: [{ categoryId: gasto.categoryId, amount: -5 }],
      }).expect(400);
      await presentar(chofer.headers, r.settlementId, {
        declaredCash: 0,
        expenses: [{ amount: 5 }],
      }).expect(400);
      const ingreso = categorias.find(
        (c) => c.systemCode === 'driver_settlement',
      );
      await presentar(chofer.headers, r.settlementId, {
        declaredCash: 0,
        expenses: [{ categoryId: ingreso?.categoryId, amount: 5 }],
      }).expect(400);
      await presentar(chofer.headers, r.settlementId, {
        declaredCash: 0,
        expenses: [{ categoryId: randomUUID(), amount: 5 }],
      }).expect(400);
      // Nada quedó a medias.
      const detalle = cuerpo<Rendicion>(
        await http()
          .get(`/driver-settlements/${r.settlementId}`)
          .set(e.headers)
          .expect(200),
      );
      expect(detalle.status).toBe('open');
    });

    it('un chofer no ve ni presenta la rendición de otro (404); el admin de otra distribuidora tampoco', async () => {
      const { e, chofer } = await armar();
      const otro = await f.chofer(e.distributorId, 'Otro');
      const r = await abrirRendicion(e, chofer);
      await http()
        .get(`/driver-settlements/${r.settlementId}`)
        .set(otro.headers)
        .expect(404);
      await presentar(otro.headers, r.settlementId, { declaredCash: 0 }).expect(
        404,
      );
      await http()
        .get(`/driver-settlements/${r.settlementId}`)
        .set(chofer.headers)
        .expect(200);

      const b = await f.distribuidora();
      await http()
        .get(`/driver-settlements/${r.settlementId}`)
        .set(b.headers)
        .expect(404);
      await presentar(b.headers, r.settlementId, { declaredCash: 0 }).expect(
        404,
      );
      await aprobar(b.headers, r.settlementId, {
        cashBoxId: randomUUID(),
      }).expect(404);
      await http()
        .patch(`/driver-settlements/${r.settlementId}/reopen`)
        .set(b.headers)
        .expect(404);
    });

    it('el administrador también puede declarar por el chofer', async () => {
      const { e, chofer, cliente } = await armar();
      await entregar(e, chofer, cliente, { estadoDePago: PaymentStatus.PAID });
      const r = await abrirRendicion(e, chofer);
      const presentada = cuerpo<Rendicion>(
        await presentar(e.headers, r.settlementId, {
          declaredCash: 1000,
        }).expect(201),
      );
      expect(presentada.difference).toBe(0);
    });
  });

  describe('aprobar (CU-233)', () => {
    async function presentada(
      declared: number,
      opciones: { cantidad?: number } = {},
    ) {
      const base = await armar();
      await entregar(base.e, base.chofer, base.cliente, {
        cantidad: opciones.cantidad ?? 5,
        estadoDePago: PaymentStatus.PAID,
      });
      const r = await abrirRendicion(base.e, base.chofer);
      await presentar(base.chofer.headers, r.settlementId, {
        declaredCash: declared,
      }).expect(201);
      return { ...base, r };
    }

    it('sin diferencia: la entrada a caja es el efectivo declarado, con la categoría de sistema', async () => {
      const { e, r, cajaId } = await presentada(5000);
      const aprobada = cuerpo<Rendicion>(
        await aprobar(e.headers, r.settlementId, { cashBoxId: cajaId }).expect(
          200,
        ),
      );
      expect(aprobada).toMatchObject({
        status: 'approved',
        differenceResolution: 'none',
      });
      expect(aprobada.cashMovementId).not.toBeNull();
      expect(await saldoDe(cajaId)).toBe(5000);
      const [mov] = await ds.query<
        Array<{
          direction: string;
          amount: string;
          name: string;
          reference_type: string;
        }>
      >(
        `SELECT m.direction, m.amount, c.name, m.reference_type
         FROM cash_movement m JOIN cash_category c ON c.category_id = m.category_id
         WHERE m.movement_id = $1`,
        [aprobada.cashMovementId],
      );
      expect(mov).toMatchObject({
        direction: 'in',
        amount: '5000.00',
        name: 'Rendición de chofer',
        reference_type: 'driver_settlement',
      });
    });

    it('con diferencia hay que decir cómo se resuelve (400); un sobrante no se le descuenta al chofer (400)', async () => {
      const { e, r, cajaId } = await presentada(4800);
      await aprobar(e.headers, r.settlementId, { cashBoxId: cajaId }).expect(
        400,
      );
      await aprobar(e.headers, r.settlementId, {
        cashBoxId: cajaId,
        differenceResolution: 'none',
      }).expect(400);
      expect(await saldoDe(cajaId)).toBe(0);

      const sobrante = await presentada(5300);
      await aprobar(sobrante.e.headers, sobrante.r.settlementId, {
        cashBoxId: sobrante.cajaId,
        differenceResolution: 'charged_to_driver',
      }).expect(400);
    });

    it('un faltante absorbido entra a caja lo declarado y no toca al chofer', async () => {
      const { e, r, cajaId, chofer } = await presentada(4800);
      const aprobada = cuerpo<Rendicion>(
        await aprobar(e.headers, r.settlementId, {
          cashBoxId: cajaId,
          differenceResolution: 'absorbed',
        }).expect(200),
      );
      expect(aprobada).toMatchObject({
        difference: -200,
        differenceResolution: 'absorbed',
      });
      expect(await saldoDe(cajaId)).toBe(4800);
      const deducciones = await ds.query<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM commission_entry WHERE employee_id = $1`,
        [chofer.employeeId],
      );
      expect(deducciones[0].n).toBe(0);
    });

    it('un faltante a cargo del chofer genera la deducción negativa en su libro de comisiones', async () => {
      const { e, r, cajaId, chofer } = await presentada(4800);
      await aprobar(e.headers, r.settlementId, {
        cashBoxId: cajaId,
        differenceResolution: 'charged_to_driver',
      }).expect(200);
      const entradas = await ds.query<
        Array<{ type: string; amount: string; reference_id: string }>
      >(
        `SELECT type, amount, reference_id FROM commission_entry WHERE employee_id = $1`,
        [chofer.employeeId],
      );
      expect(entradas).toEqual([
        {
          type: 'settlement_shortage',
          amount: '-200.00',
          reference_id: r.settlementId,
        },
      ]);
    });

    it('la caja tiene que existir en la distribuidora (404) y, si exige sesión, tenerla abierta (409)', async () => {
      const { e, r, cajaId } = await presentada(5000);
      await aprobar(e.headers, r.settlementId, {
        cashBoxId: randomUUID(),
      }).expect(404);
      const b = await f.distribuidora();
      const [ajena] = cuerpo<Pagina<Caja>>(
        await http().get('/cash-boxes').set(b.headers).expect(200),
      ).data;
      await aprobar(e.headers, r.settlementId, {
        cashBoxId: ajena.cashBoxId,
      }).expect(404);

      const sesion = await ds.query<Array<{ session_id: string }>>(
        `SELECT session_id FROM cash_session WHERE cash_box_id = $1`,
        [cajaId],
      );
      await http()
        .patch(`/cash-sessions/${sesion[0].session_id}/close`)
        .set(e.headers)
        .send({ countedAmount: 0 })
        .expect(200);
      await aprobar(e.headers, r.settlementId, { cashBoxId: cajaId }).expect(
        409,
      );
      const intacta = cuerpo<Rendicion>(
        await http()
          .get(`/driver-settlements/${r.settlementId}`)
          .set(e.headers)
          .expect(200),
      );
      expect(intacta.status).toBe('submitted');
    });

    it('sólo se aprueba una presentada (409) y una aprobada no se reabre (409)', async () => {
      const base = await armar();
      const abierta = await abrirRendicion(base.e, base.chofer);
      await aprobar(base.e.headers, abierta.settlementId, {
        cashBoxId: base.cajaId,
      }).expect(409);

      await presentar(base.chofer.headers, abierta.settlementId, {
        declaredCash: 0,
      }).expect(201);
      await aprobar(base.e.headers, abierta.settlementId, {
        cashBoxId: base.cajaId,
      }).expect(200);
      await aprobar(base.e.headers, abierta.settlementId, {
        cashBoxId: base.cajaId,
      }).expect(409);
      await http()
        .patch(`/driver-settlements/${abierta.settlementId}/reopen`)
        .set(base.e.headers)
        .expect(409);
    });

    it('dos aprobaciones simultáneas: una sola entra a caja', async () => {
      const { e, r, cajaId } = await presentada(5000);
      const respuestas = await Promise.all(
        [1, 2, 3].map(() =>
          aprobar(e.headers, r.settlementId, { cashBoxId: cajaId }),
        ),
      );
      expect(respuestas.map((x) => x.status).sort()).toEqual([200, 409, 409]);
      expect(await saldoDe(cajaId)).toBe(5000);
      expect(mockReintentos.n).toBe(0);
    });
  });

  describe('reabrir (CU-330)', () => {
    it('una presentada vuelve a abierta, libera sus pedidos y se puede presentar de nuevo', async () => {
      const { e, chofer, cliente, gasto } = await armar();
      await entregar(e, chofer, cliente, {
        cantidad: 2,
        estadoDePago: PaymentStatus.PAID,
      });
      const r = await abrirRendicion(e, chofer);
      await presentar(chofer.headers, r.settlementId, {
        declaredCash: 1500,
        expenses: [{ categoryId: gasto.categoryId, amount: 500 }],
      }).expect(201);

      const reabierta = cuerpo<Rendicion>(
        await http()
          .patch(`/driver-settlements/${r.settlementId}/reopen`)
          .set(e.headers)
          .expect(200),
      );
      expect(reabierta).toMatchObject({
        status: 'open',
        declaredCash: null,
        difference: null,
        driverExpenses: 0,
      });
      expect(reabierta.orders).toHaveLength(1);
      expect(reabierta.expenses).toHaveLength(0);

      // Aparece otro pedido mientras estaba reabierta: entra en lo esperado al volver a presentar.
      await entregar(e, chofer, cliente, {
        cantidad: 1,
        estadoDePago: PaymentStatus.PAID,
      });
      const de_nuevo = cuerpo<Rendicion>(
        await presentar(chofer.headers, r.settlementId, {
          declaredCash: 3000,
        }).expect(201),
      );
      expect(de_nuevo).toMatchObject({ expectedCash: 3000, difference: 0 });
    });

    it('una abierta no se reabre (409)', async () => {
      const { e, chofer } = await armar();
      const r = await abrirRendicion(e, chofer);
      await http()
        .patch(`/driver-settlements/${r.settlementId}/reopen`)
        .set(e.headers)
        .expect(409);
    });
  });

  describe('un pedido se rinde una sola vez', () => {
    it('lo entregado después de presentar cae en la rendición del día siguiente y lo anterior queda en la suya', async () => {
      const { e, chofer, cliente } = await armar();
      const dia14 = '2026-10-14';
      const dia15 = '2026-10-15';
      const x = await entregar(e, chofer, cliente, {
        estadoDePago: PaymentStatus.PAID,
        entregadoEn: new Date('2026-10-14T15:00:00Z'),
      });
      const s14 = await abrirRendicion(e, chofer, dia14);
      expect(s14.orders.map((o) => o.orderId)).toEqual([x.orderId]);
      await presentar(chofer.headers, s14.settlementId, {
        declaredCash: 1000,
      }).expect(201);

      const y = await entregar(e, chofer, cliente, {
        cantidad: 2,
        estadoDePago: PaymentStatus.PAID,
        entregadoEn: new Date('2026-10-14T23:30:00Z'),
      });
      const s15 = await abrirRendicion(e, chofer, dia15);
      expect(s15.orders.map((o) => o.orderId)).toEqual([y.orderId]);
      expect(s15.expectedCash).toBe(2000);
      // La del 14 sigue mostrando sólo lo suyo.
      const releida = cuerpo<Rendicion>(
        await http()
          .get(`/driver-settlements/${s14.settlementId}`)
          .set(e.headers)
          .expect(200),
      );
      expect(releida.orders.map((o) => o.orderId)).toEqual([x.orderId]);
    });

    it('mientras la rendición de un día anterior sigue abierta, sus pedidos son de ella y no de la de hoy', async () => {
      const { e, chofer, cliente } = await armar();
      const x = await entregar(e, chofer, cliente, {
        estadoDePago: PaymentStatus.PAID,
        entregadoEn: new Date('2026-10-14T15:00:00Z'),
      });
      const s14 = await abrirRendicion(e, chofer, '2026-10-14');
      const s15 = await abrirRendicion(e, chofer, '2026-10-15');
      expect(s14.orders.map((o) => o.orderId)).toEqual([x.orderId]);
      expect(s15.orders).toHaveLength(0);
    });

    it('la base impide que dos rendiciones tomen el mismo pedido', async () => {
      const { e, chofer, cliente } = await armar();
      const x = await entregar(e, chofer, cliente, {
        estadoDePago: PaymentStatus.PAID,
        entregadoEn: new Date('2026-10-14T15:00:00Z'),
      });
      const s14 = await abrirRendicion(e, chofer, '2026-10-14');
      const s15 = await abrirRendicion(e, chofer, '2026-10-15');
      await ds.query(
        `INSERT INTO driver_settlement_order (settlement_id, order_id, amount, payment_method)
         VALUES ($1, $2, 1000, 'cash')`,
        [s14.settlementId, x.orderId],
      );
      await expect(
        ds.query(
          `INSERT INTO driver_settlement_order (settlement_id, order_id, amount, payment_method)
           VALUES ($1, $2, 1000, 'cash')`,
          [s15.settlementId, x.orderId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('carga del camión (CU-233)', () => {
    async function conCarga(estado: string) {
      const base = await armar();
      const auto = await ds.getRepository(Car).save({
        distributorId: base.e.distributorId,
        userId: base.chofer.userId,
        carPatent: `T${randomUUID().slice(0, 5).toUpperCase()}`,
      } as Partial<Car>);
      const deposito = await env.app
        .get(WarehouseService)
        .asegurarPredeterminado(base.e.distributorId);
      const [carga] = await ds.query<Array<{ load_id: string }>>(
        `INSERT INTO truck_load (distributor_id, number, car_id, delivery_id, origin_location_id, business_date, status, opened_by_user_id)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7) RETURNING load_id`,
        [
          base.e.distributorId,
          auto.carId,
          base.chofer.deliveryId,
          deposito.locationId,
          hoy(),
          estado,
          base.e.adminUserId,
        ],
      );
      return { ...base, cargaId: carga.load_id };
    }

    it('se ata a la carga del día y no se aprueba hasta que la carga esté cerrada', async () => {
      const { e, chofer, cajaId, cargaId } = await conCarga('returned');
      const r = await abrirRendicion(e, chofer);
      expect(r.truckLoadId).toBe(cargaId);
      await presentar(chofer.headers, r.settlementId, {
        declaredCash: 0,
      }).expect(201);

      await aprobar(e.headers, r.settlementId, { cashBoxId: cajaId }).expect(
        409,
      );
      await forzarEstado(
        ds,
        `UPDATE truck_load SET status = 'closed' WHERE load_id = $1`,
        [cargaId],
      );
      const aprobada = cuerpo<Rendicion>(
        await aprobar(e.headers, r.settlementId, { cashBoxId: cajaId }).expect(
          200,
        ),
      );
      expect(aprobada.status).toBe('approved');
      expect(aprobada.truckLoadStatus).toBe('closed');
    });
  });

  describe('procesos nocturnos (CU-231, CU-234)', () => {
    it('abre la rendición de los choferes con efectivo sin rendir, una sola vez', async () => {
      const { e, chofer, cliente } = await armar();
      const sin = await f.chofer(e.distributorId, 'Sin pedidos');
      await entregar(e, chofer, cliente, { estadoDePago: PaymentStatus.PAID });
      await entregar(e, sin, cliente, {
        metodo: PaymentMethod.TRANSFER,
        estadoDePago: PaymentStatus.PAID,
      });

      const servicio = env.app.get(DriverSettlementService);
      expect(await servicio.generarDelDia(hoy())).toBe(1);
      expect(await servicio.generarDelDia(hoy())).toBe(0);

      const lista = cuerpo<Pagina<Rendicion>>(
        await http()
          .get('/driver-settlements')
          .query({ date: hoy() })
          .set(e.headers)
          .expect(200),
      );
      expect(lista.total).toBe(1);
      expect(lista.data[0]).toMatchObject({
        deliveryId: chofer.deliveryId,
        expectedCash: 1000,
      });
    });

    it('avisa por mail las rendiciones de días anteriores sin cerrar, una sola vez', async () => {
      const { e, chofer } = await armar();
      const enviar = jest
        .spyOn(env.app.get(EmailSenderPort), 'send')
        .mockResolvedValue(undefined);
      await abrirRendicion(e, chofer, '2026-10-14');
      await abrirRendicion(e, chofer, hoy());

      const cron = env.app.get(DriverSettlementCron);
      await cron.avisar();
      expect(enviar).toHaveBeenCalledTimes(1);
      expect(enviar.mock.calls[0][0]).toMatchObject({
        to: expect.stringContaining('admin.') as string,
      });
      expect(enviar.mock.calls[0][0].subject).toContain('1');
      expect(enviar.mock.calls[0][0].html).toContain('2026-10-14');
      expect(enviar.mock.calls[0][0].html).not.toContain(hoy());

      await cron.avisar();
      expect(enviar).toHaveBeenCalledTimes(1);
    });
  });

  describe('listado (CU-233)', () => {
    it('filtra por día, estado y chofer, con lo esperado en vivo en las abiertas', async () => {
      const { e, chofer, cliente } = await armar();
      const otro = await f.chofer(e.distributorId, 'Otro');
      await entregar(e, chofer, cliente, { estadoDePago: PaymentStatus.PAID });
      const r = await abrirRendicion(e, chofer);
      await abrirRendicion(e, otro);
      // Entra un pedido DESPUÉS de abrirla: la abierta lo muestra en vivo.
      await entregar(e, chofer, cliente, { estadoDePago: PaymentStatus.PAID });

      const lista = cuerpo<Pagina<Rendicion>>(
        await http()
          .get('/driver-settlements')
          .query({ date: hoy(), status: 'open', deliveryId: chofer.deliveryId })
          .set(e.headers)
          .expect(200),
      );
      expect(lista.total).toBe(1);
      expect(lista.data[0]).toMatchObject({
        settlementId: r.settlementId,
        expectedCash: 2000,
      });
      const todas = cuerpo<Pagina<Rendicion>>(
        await http().get('/driver-settlements').set(e.headers).expect(200),
      );
      expect(todas.total).toBe(2);
      await http()
        .get('/driver-settlements')
        .query({ status: 'raro' })
        .set(e.headers)
        .expect(400);
    });
  });
});
