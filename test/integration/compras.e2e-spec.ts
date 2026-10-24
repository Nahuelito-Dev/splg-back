/**
 * Compras (M-C parte 2) contra la API con Postgres y Redis reales: proveedores,
 * orden de compra, recepciones parciales y total, libro, costo promedio,
 * conciliación, anulación, aislamiento entre distribuidoras, idempotencia y
 * concurrencia sobre la misma orden.
 */
import { randomUUID } from 'crypto';
import { codigoSqlDelError } from '../../src/common/errors/db-exceptions';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  truncateAllTables,
} from './setup/test-env';
import { conIdempotencia } from './setup/con-idempotencia';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { WarehouseService } from '../../src/stock/application/warehouse.service';
import { Customer } from '../../src/customer/entities/customer.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { OrderItem } from '../../src/order/entities/order-item.entity';
import { entregarComoAdmin } from './setup/entrega-admin';
import { conBypass } from './setup/bypass';

type Headers = Record<string, string>;

/**
 * Cuenta los deadlocks (40P01) y fallas de serialización que
 * `withTransactionRetry` reintenta en silencio: un test que los permitiera
 * escondería un orden de locks roto.
 */
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
const cuerpo = <T>(res: { body: unknown }): T => res.body as T;

interface Proveedor {
  supplierId: string;
  cuit: string;
}
interface Orden {
  purchaseOrderId: string;
  number: number;
  status: string;
  totalAmount: number;
  receivedQuantity: number;
  pendingQuantity: number;
  items: Array<{
    gasCylinderId: string;
    receivedQuantity: number;
    pendingQuantity: number;
  }>;
  receipts: unknown[];
}
interface Recepcion {
  receiptId: string;
  number: number;
  status: string;
  totalAmount: number;
  batchId: string;
  voidBatchId: string | null;
}
interface Mensaje {
  message: string;
}
interface Pendiente {
  totalPending: number;
}
interface Costo {
  gasCylinderId: string;
  averageUnitCost: number | null;
  fullOnHand: number;
}
interface Conciliacion {
  consistent: boolean;
}
interface Pagina {
  total: number;
  data: unknown[];
}

describe('Compras (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
    mockReintentos.n = 0;
  });

  const http = () => conIdempotencia(env.app.getHttpServer());

  async function rol(type: string): Promise<Role> {
    const roles = ds.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function seedDistribuidora() {
    const sufijo = randomUUID().slice(0, 8);
    const distribuidora = (await ds.getRepository(Distributor).save({
      name: `Distribuidora ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
    const deposito = await env.app
      .get(WarehouseService)
      .asegurarPredeterminado(distribuidora.distributorId);
    const email = `admin.${sufijo}@splg.local`;
    const user = (await ds.getRepository(User).save({
      email,
      fullName: 'Admin Test',
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol('admin')).roleId,
    } as Partial<User>)) as User;
    await ds.getRepository(Admin).save({
      userId: user.userId,
      distributorId: distribuidora.distributorId,
    } as Partial<Admin>);
    const headers: Headers = {
      Authorization: `Bearer ${email}`,
      'X-Client-Source': 'panel-app',
    };
    return {
      distributorId: distribuidora.distributorId,
      slug: distribuidora.slug,
      warehouseId: deposito.warehouse.warehouseId,
      locationId: deposito.locationId,
      headers,
    };
  }

  const seedGarrafa = (distributorId: string, type = '10kg') =>
    ds.getRepository(GasCylinder).save({
      type,
      price: 1000,
      weight: 10,
      stock: 0,
      isActive: true,
      distributorId,
    } as Partial<GasCylinder>);

  const saldo = async (
    locationId: string,
    gasCylinderId: string,
    condition: string,
  ) => {
    const [fila] = await ds.query<Array<{ quantity: number }>>(
      `SELECT quantity FROM stock_balance WHERE location_id = $1 AND gas_cylinder_id = $2 AND condition = $3`,
      [locationId, gasCylinderId, condition],
    );
    return fila?.quantity ?? 0;
  };
  const vendible = async (gasCylinderId: string) =>
    (await ds.getRepository(GasCylinder).findOneByOrFail({ gasCylinderId }))
      .stock;

  const CUITS = ['30712345671', '30709988774', '20123456786'];

  const proveedor = async (e: { headers: Headers }, cuit = CUITS[0]) =>
    cuerpo<Proveedor>(
      await http()
        .post('/suppliers')
        .set(e.headers)
        .send({
          businessName: `Proveedor ${cuit}`,
          cuit,
          kind: 'filling_plant',
          paymentTermsDays: 30,
        })
        .expect(201),
    );

  const ordenEnviada = async (
    e: { headers: Headers },
    supplierId: string,
    items: Array<{
      gasCylinderId: string;
      quantity: number;
      unitCost: number;
      emptiesToExchange?: number;
    }>,
  ) => {
    const creada = cuerpo<Orden>(
      await http()
        .post('/purchase-orders')
        .set(e.headers)
        .send({ supplierId, items })
        .expect(201),
    );
    await http()
      .patch(`/purchase-orders/${creada.purchaseOrderId}/send`)
      .set(e.headers)
      .expect(200);
    return creada;
  };

  const recibir = (
    e: { headers: Headers },
    body: Record<string, unknown>,
    key?: string,
  ) => {
    const req = http().post('/purchase-receipts').set(e.headers);
    if (key) req.set('Idempotency-Key', key);
    return req.send({ supplierDocumentType: 'delivery_note', ...body });
  };

  const conciliacion = async (e: { headers: Headers }) =>
    cuerpo<Conciliacion>(
      await http().get('/stock/reconciliation').set(e.headers).expect(200),
    );

  /** Vacías en el depósito por conteo inicial (lo que un cliente devolvió antes). */
  const vaciasEnElDeposito = (
    e: { headers: Headers; warehouseId: string },
    g: GasCylinder,
    empty: number,
  ) =>
    http()
      .post('/stock/initial-counts')
      .set(e.headers)
      .send({
        warehouseId: e.warehouseId,
        items: [{ gasCylinderId: g.gasCylinderId, full: 0, empty }],
      })
      .expect(201);

  describe('proveedores', () => {
    it('valida el CUIT, no lo repite, lo libera al dar de baja y aísla por tenant', async () => {
      const a = await seedDistribuidora();
      const b = await seedDistribuidora();
      const mal = await http()
        .post('/suppliers')
        .set(a.headers)
        .send({ businessName: 'X', cuit: '30712345670', kind: 'other' })
        .expect(400);
      expect(JSON.stringify(mal.body)).toMatch(/CUIT/);

      const p = await proveedor(a);
      const repetido = await http()
        .post('/suppliers')
        .set(a.headers)
        .send({ businessName: 'Otro', cuit: '30-71234567-1', kind: 'other' })
        .expect(409);
      expect(cuerpo<Mensaje>(repetido).message).toMatch(
        /Ya hay un proveedor vigente con el CUIT/,
      );

      // otra distribuidora puede tener el mismo CUIT y no ve el proveedor de la primera
      await proveedor(b);
      await http().get(`/suppliers/${p.supplierId}`).set(b.headers).expect(404);
      await http()
        .patch(`/suppliers/${p.supplierId}`)
        .set(b.headers)
        .send({ businessName: 'Hack' })
        .expect(404);
      await http()
        .delete(`/suppliers/${p.supplierId}`)
        .set(b.headers)
        .expect(404);

      await http()
        .delete(`/suppliers/${p.supplierId}`)
        .set(a.headers)
        .expect(200);
      await http().get(`/suppliers/${p.supplierId}`).set(a.headers).expect(404);
      await proveedor(a); // el CUIT quedó libre
      const lista = cuerpo<Pagina>(
        await http().get('/suppliers').set(a.headers).expect(200),
      );
      expect(lista.total).toBe(1);
    });

    it('no se da de baja con una orden abierta', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      await ordenEnviada(e, p.supplierId, [
        { gasCylinderId: g.gasCylinderId, quantity: 5, unitCost: 100 },
      ]);
      await http()
        .delete(`/suppliers/${p.supplierId}`)
        .set(e.headers)
        .expect(409);
    });
  });

  describe('recorrido: proveedor → orden → recepción parcial → total → costo → anulación', () => {
    it('mantiene saldos, libro, vendible, costo promedio y conciliación', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await vaciasEnElDeposito(e, g, 50);
      const p = await proveedor(e);

      const borrador = cuerpo<Orden>(
        await http()
          .post('/purchase-orders')
          .set(e.headers)
          .send({
            supplierId: p.supplierId,
            items: [
              {
                gasCylinderId: g.gasCylinderId,
                quantity: 40,
                unitCost: 1000,
                emptiesToExchange: 40,
              },
            ],
          })
          .expect(201),
      );
      expect(borrador).toMatchObject({
        number: 1,
        status: 'draft',
        totalAmount: 40000,
      });

      // en borrador no se recibe; se edita; una vez enviada no se edita
      await recibir(e, {
        purchaseOrderId: borrador.purchaseOrderId,
        supplierDocumentNumber: 'R-0',
        items: [{ gasCylinderId: g.gasCylinderId, quantityFull: 1 }],
      }).expect(400);
      await http()
        .patch(`/purchase-orders/${borrador.purchaseOrderId}`)
        .set(e.headers)
        .send({
          items: [
            {
              gasCylinderId: g.gasCylinderId,
              quantity: 40,
              unitCost: 1000,
              emptiesToExchange: 40,
            },
          ],
          notes: 'ok',
        })
        .expect(200);
      await http()
        .patch(`/purchase-orders/${borrador.purchaseOrderId}/send`)
        .set(e.headers)
        .expect(200);
      await http()
        .patch(`/purchase-orders/${borrador.purchaseOrderId}`)
        .set(e.headers)
        .send({ notes: 'tarde' })
        .expect(400);

      // recepción parcial: 25 llenas, 25 vacías a la planta
      const r1 = cuerpo<Recepcion>(
        await recibir(e, {
          purchaseOrderId: borrador.purchaseOrderId,
          supplierDocumentNumber: 'R-1',
          items: [
            {
              gasCylinderId: g.gasCylinderId,
              quantityFull: 25,
              quantityEmptyOut: 25,
            },
          ],
        }).expect(201),
      );
      expect(r1).toMatchObject({
        number: 1,
        status: 'confirmed',
        totalAmount: 25000,
      });
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(25);
      expect(await saldo(e.locationId, g.gasCylinderId, 'empty')).toBe(25);
      expect(await vendible(g.gasCylinderId)).toBe(25);
      const parcial = cuerpo<Orden>(
        await http()
          .get(`/purchase-orders/${borrador.purchaseOrderId}`)
          .set(e.headers)
          .expect(200),
      );
      expect(parcial).toMatchObject({
        status: 'partially_received',
        receivedQuantity: 25,
        pendingQuantity: 15,
      });
      expect(parcial.receipts).toHaveLength(1);
      expect(
        cuerpo<Pendiente>(
          await http()
            .get(`/purchase-orders/${borrador.purchaseOrderId}/pending`)
            .set(e.headers)
            .expect(200),
        ).totalPending,
      ).toBe(15);
      expect((await conciliacion(e)).consistent).toBe(true);

      // pasarse de lo pedido
      const exceso = await recibir(e, {
        purchaseOrderId: borrador.purchaseOrderId,
        supplierDocumentNumber: 'R-X',
        items: [
          { gasCylinderId: g.gasCylinderId, quantityFull: 16, unitCost: 1400 },
        ],
      }).expect(400);
      expect(cuerpo<Mensaje>(exceso).message).toMatch(
        /llegan 16 y sólo quedan 15/,
      );
      // no cancelar con mercadería recibida
      await http()
        .patch(`/purchase-orders/${borrador.purchaseOrderId}/cancel`)
        .set(e.headers)
        .send({ reason: 'tarde' })
        .expect(409);

      // total, a otro costo: promedio (25 × 1000 + 15 × 1400) / 40 = 1150
      const r2 = cuerpo<Recepcion>(
        await recibir(e, {
          purchaseOrderId: borrador.purchaseOrderId,
          supplierDocumentNumber: 'R-2',
          items: [
            {
              gasCylinderId: g.gasCylinderId,
              quantityFull: 15,
              quantityEmptyOut: 15,
              unitCost: 1400,
            },
          ],
        }).expect(201),
      );
      expect(r2.number).toBe(2);
      const completa = cuerpo<Orden>(
        await http()
          .get(`/purchase-orders/${borrador.purchaseOrderId}`)
          .set(e.headers)
          .expect(200),
      );
      expect(completa).toMatchObject({
        status: 'received',
        pendingQuantity: 0,
      });
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(40);
      expect(await saldo(e.locationId, g.gasCylinderId, 'empty')).toBe(10);
      expect(await vendible(g.gasCylinderId)).toBe(40);
      const costos = cuerpo<Costo[]>(
        await http()
          .get('/purchase-receipts/average-costs')
          .set(e.headers)
          .expect(200),
      );
      expect(costos[0]).toMatchObject({
        averageUnitCost: 1150,
        fullOnHand: 40,
      });
      expect((await conciliacion(e)).consistent).toBe(true);

      // el libro tiene los dos lotes con sus motivos
      const libro = cuerpo<{ data: Array<{ reason: string }> }>(
        await http()
          .get(`/stock/movements?batchId=${r2.batchId}`)
          .set(e.headers)
          .expect(200),
      );
      expect(libro.data.map((m) => m.reason).sort()).toEqual([
        'plant_empty_out',
        'purchase_receipt',
      ]);

      // anular la segunda: sale lo recibido, vuelven las vacías, la orden queda parcial, el promedio vuelve a 1000
      const anulada = cuerpo<Recepcion>(
        await http()
          .patch(`/purchase-receipts/${r2.receiptId}/void`)
          .set(e.headers)
          .send({ reason: 'Cargada con el costo equivocado' })
          .expect(200),
      );
      expect(anulada.status).toBe('voided');
      expect(anulada.voidBatchId).not.toBeNull();
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(25);
      expect(await saldo(e.locationId, g.gasCylinderId, 'empty')).toBe(25);
      expect(await vendible(g.gasCylinderId)).toBe(25);
      expect(
        cuerpo<Orden>(
          await http()
            .get(`/purchase-orders/${borrador.purchaseOrderId}`)
            .set(e.headers)
            .expect(200),
        ).status,
      ).toBe('partially_received');
      expect(
        cuerpo<Costo[]>(
          await http()
            .get('/purchase-receipts/average-costs')
            .set(e.headers)
            .expect(200),
        )[0].averageUnitCost,
      ).toBe(1000);
      expect((await conciliacion(e)).consistent).toBe(true);
      await http()
        .patch(`/purchase-receipts/${r2.receiptId}/void`)
        .set(e.headers)
        .send({ reason: 'otra vez' })
        .expect(409);

      // el documento anulado sigue ocupando su número: no se reutiliza
      await recibir(e, {
        purchaseOrderId: borrador.purchaseOrderId,
        supplierDocumentNumber: 'R-2',
        items: [{ gasCylinderId: g.gasCylinderId, quantityFull: 1 }],
      }).expect(409);

      // historial y listados
      const historial = cuerpo<{
        receiptsCount: number;
        totalAmount: number;
        fullReceived: number;
        total: number;
      }>(
        await http()
          .get(`/suppliers/${p.supplierId}/purchase-history`)
          .set(e.headers)
          .expect(200),
      );
      expect(historial).toMatchObject({
        receiptsCount: 1,
        totalAmount: 25000,
        fullReceived: 25,
        total: 2,
      });
      const filtradas = cuerpo<Pagina>(
        await http()
          .get(`/purchase-receipts?supplierId=${p.supplierId}&status=voided`)
          .set(e.headers)
          .expect(200),
      );
      expect(filtradas.total).toBe(1);
      const ordenes = cuerpo<Pagina>(
        await http()
          .get(
            `/purchase-orders?status=partially_received&supplierId=${p.supplierId}`,
          )
          .set(e.headers)
          .expect(200),
      );
      expect(ordenes.total).toBe(1);
    });

    it('si las vacías no alcanzan responde 400 y no cambia nada', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await vaciasEnElDeposito(e, g, 3);
      const p = await proveedor(e);
      const res = await recibir(e, {
        supplierId: p.supplierId,
        supplierDocumentNumber: 'R-1',
        items: [
          {
            gasCylinderId: g.gasCylinderId,
            quantityFull: 10,
            quantityEmptyOut: 5,
            unitCost: 900,
          },
        ],
      }).expect(400);
      expect(cuerpo<Mensaje>(res).message).toMatch(
        /vacías en .* \(hay 3, se necesitan 5\)/,
      );
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(0);
      expect(await saldo(e.locationId, g.gasCylinderId, 'empty')).toBe(3);
      expect(await vendible(g.gasCylinderId)).toBe(0);
      const [{ n }] = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM purchase_receipt`,
      );
      expect(Number(n)).toBe(0);
    });

    it('no se anula si las llenas ya salieron del depósito y el 409 dice dónde están', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const r = cuerpo<Recepcion>(
        await recibir(e, {
          supplierId: p.supplierId,
          supplierDocumentNumber: 'R-1',
          items: [
            { gasCylinderId: g.gasCylinderId, quantityFull: 10, unitCost: 900 },
          ],
        }).expect(201),
      );
      // 6 llenas se van a otro depósito
      const otro = cuerpo<{ warehouseId: string }>(
        await http()
          .post('/warehouses')
          .set(e.headers)
          .send({ name: 'Norte', code: 'NORTE' })
          .expect(201),
      );
      await http()
        .post('/stock/transfers')
        .set(e.headers)
        .send({
          from: { warehouseId: e.warehouseId },
          to: { warehouseId: otro.warehouseId },
          items: [{ gasCylinderId: g.gasCylinderId, quantity: 6 }],
        })
        .expect(201);
      const res = await http()
        .patch(`/purchase-receipts/${r.receiptId}/void`)
        .set(e.headers)
        .send({ reason: 'error' })
        .expect(409);
      expect(cuerpo<Mensaje>(res).message).toMatch(
        /la recepción trajo 10 llenas y hoy hay 6 en Norte, 4 en/,
      );
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(4);
      expect(
        cuerpo<Recepcion>(
          await http()
            .get(`/purchase-receipts/${r.receiptId}`)
            .set(e.headers)
            .expect(200),
        ).status,
      ).toBe('confirmed');
    });

    it('con el depósito de la recepción dado de baja no se anula: 409 claro y no 500', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const r = cuerpo<Recepcion>(
        await recibir(e, {
          supplierId: p.supplierId,
          supplierDocumentNumber: 'R-1',
          items: [
            { gasCylinderId: g.gasCylinderId, quantityFull: 10, unitCost: 900 },
          ],
        }).expect(201),
      );
      const otro = cuerpo<{ warehouseId: string }>(
        await http()
          .post('/warehouses')
          .set(e.headers)
          .send({ name: 'Norte', code: 'NORTE' })
          .expect(201),
      );
      await http()
        .post('/stock/transfers')
        .set(e.headers)
        .send({
          from: { warehouseId: e.warehouseId },
          to: { warehouseId: otro.warehouseId },
          items: [{ gasCylinderId: g.gasCylinderId, quantity: 10 }],
        })
        .expect(201);
      await http()
        .patch(`/warehouses/${otro.warehouseId}`)
        .set(e.headers)
        .send({ isDefault: true })
        .expect(200);
      await http()
        .delete(`/warehouses/${e.warehouseId}`)
        .set(e.headers)
        .expect(200);
      const res = await http()
        .patch(`/purchase-receipts/${r.receiptId}/void`)
        .set(e.headers)
        .send({ reason: 'error' })
        .expect(409);
      expect(cuerpo<Mensaje>(res).message).toMatch(/dado de baja/);
      expect(
        cuerpo<Recepcion>(
          await http()
            .get(`/purchase-receipts/${r.receiptId}`)
            .set(e.headers)
            .expect(200),
        ).status,
      ).toBe('confirmed');
    });

    it('una recepción pagada no se anula; impaga sí', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const r = cuerpo<Recepcion>(
        await recibir(e, {
          supplierId: p.supplierId,
          supplierDocumentNumber: 'R-1',
          items: [
            { gasCylinderId: g.gasCylinderId, quantityFull: 2, unitCost: 900 },
          ],
        }).expect(201),
      );
      await http()
        .patch(`/purchase-receipts/${r.receiptId}/payment-status`)
        .set(e.headers)
        .send({ paymentStatus: 'paid' })
        .expect(200);
      await http()
        .patch(`/purchase-receipts/${r.receiptId}/void`)
        .set(e.headers)
        .send({ reason: 'x' })
        .expect(400);
      await http()
        .patch(`/purchase-receipts/${r.receiptId}/payment-status`)
        .set(e.headers)
        .send({ paymentStatus: 'unpaid' })
        .expect(200);
      await http()
        .patch(`/purchase-receipts/${r.receiptId}/void`)
        .set(e.headers)
        .send({ reason: 'x' })
        .expect(200);
    });
  });

  describe('aislamiento entre distribuidoras', () => {
    it('lo de otra distribuidora responde 404 en órdenes y recepciones', async () => {
      const a = await seedDistribuidora();
      const b = await seedDistribuidora();
      const ga = await seedGarrafa(a.distributorId);
      const gb = await seedGarrafa(b.distributorId);
      const pa = await proveedor(a);
      const pb = await proveedor(b);
      const orden = await ordenEnviada(a, pa.supplierId, [
        { gasCylinderId: ga.gasCylinderId, quantity: 5, unitCost: 10 },
      ]);
      const r = cuerpo<Recepcion>(
        await recibir(a, {
          supplierId: pa.supplierId,
          supplierDocumentNumber: 'R-1',
          items: [
            { gasCylinderId: ga.gasCylinderId, quantityFull: 1, unitCost: 10 },
          ],
        }).expect(201),
      );
      await http()
        .get(`/purchase-orders/${orden.purchaseOrderId}`)
        .set(b.headers)
        .expect(404);
      await http()
        .patch(`/purchase-orders/${orden.purchaseOrderId}/send`)
        .set(b.headers)
        .expect(404);
      await http()
        .get(`/purchase-receipts/${r.receiptId}`)
        .set(b.headers)
        .expect(404);
      await http()
        .patch(`/purchase-receipts/${r.receiptId}/void`)
        .set(b.headers)
        .send({ reason: 'x' })
        .expect(404);
      await recibir(b, {
        purchaseOrderId: orden.purchaseOrderId,
        supplierDocumentNumber: 'R-1',
        items: [{ gasCylinderId: ga.gasCylinderId, quantityFull: 1 }],
      }).expect(404);
      // proveedor y garrafa ajenos
      await http()
        .post('/purchase-orders')
        .set(b.headers)
        .send({
          supplierId: pa.supplierId,
          items: [
            { gasCylinderId: gb.gasCylinderId, quantity: 1, unitCost: 1 },
          ],
        })
        .expect(404);
      await http()
        .post('/purchase-orders')
        .set(b.headers)
        .send({
          supplierId: pb.supplierId,
          items: [
            { gasCylinderId: ga.gasCylinderId, quantity: 1, unitCost: 1 },
          ],
        })
        .expect(404);
      expect(
        cuerpo<Pagina>(
          await http().get('/purchase-orders').set(b.headers).expect(200),
        ).total,
      ).toBe(0);
      expect(
        cuerpo<Pagina>(
          await http().get('/purchase-receipts').set(b.headers).expect(200),
        ).total,
      ).toBe(0);
    });
  });

  describe('idempotencia y concurrencia', () => {
    it('la misma Idempotency-Key recibe una sola vez', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const body = {
        supplierId: p.supplierId,
        supplierDocumentNumber: 'R-1',
        items: [
          { gasCylinderId: g.gasCylinderId, quantityFull: 7, unitCost: 100 },
        ],
      };
      const key = randomUUID();
      const a = cuerpo<Recepcion>(await recibir(e, body, key).expect(201));
      const b = cuerpo<Recepcion>(await recibir(e, body, key).expect(201));
      expect(b.receiptId).toBe(a.receiptId);
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(7);
    });

    it('dos recepciones simultáneas sobre la misma orden no pasan lo pedido', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const orden = await ordenEnviada(e, p.supplierId, [
        { gasCylinderId: g.gasCylinderId, quantity: 10, unitCost: 100 },
      ]);
      const intentos = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          recibir(e, {
            purchaseOrderId: orden.purchaseOrderId,
            supplierDocumentNumber: `R-${i}`,
            items: [{ gasCylinderId: g.gasCylinderId, quantityFull: 4 }],
          }),
        ),
      );
      const estados = intentos.map((r) => r.status).sort();
      // 10 pedidas, de a 4: caben 2; las otras 4 se rechazan por exceso
      expect(estados.filter((s) => s === 201)).toHaveLength(2);
      expect(estados.filter((s) => s === 400)).toHaveLength(4);
      const final = cuerpo<Orden>(
        await http()
          .get(`/purchase-orders/${orden.purchaseOrderId}`)
          .set(e.headers)
          .expect(200),
      );
      expect(final.items[0].receivedQuantity).toBe(8);
      expect(final.status).toBe('partially_received');
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(8);
      expect(await vendible(g.gasCylinderId)).toBe(8);
      expect(mockReintentos.n).toBe(0);
      expect((await conciliacion(e)).consistent).toBe(true);
    });

    it('recibir y anular a la vez, y ajustes del mismo tipo, no se traban', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const base = cuerpo<Recepcion>(
        await recibir(e, {
          supplierId: p.supplierId,
          supplierDocumentNumber: 'BASE',
          items: [
            { gasCylinderId: g.gasCylinderId, quantityFull: 20, unitCost: 100 },
          ],
        }).expect(201),
      );
      const trabajo = [
        ...Array.from({ length: 4 }, (_, i) =>
          recibir(e, {
            supplierId: p.supplierId,
            supplierDocumentNumber: `N-${i}`,
            items: [
              {
                gasCylinderId: g.gasCylinderId,
                quantityFull: 3,
                unitCost: 120,
              },
            ],
          }),
        ),
        http()
          .patch(`/purchase-receipts/${base.receiptId}/void`)
          .set(e.headers)
          .send({ reason: 'x' }),
        ...Array.from({ length: 4 }, () =>
          http()
            .post('/stock/adjustments')
            .set(e.headers)
            .send({
              location: { warehouseId: e.warehouseId },
              reason: 'found',
              notes: 'n',
              items: [
                {
                  gasCylinderId: g.gasCylinderId,
                  condition: 'full',
                  quantityDelta: 1,
                },
              ],
            }),
        ),
      ];
      const respuestas = await Promise.all(trabajo);
      respuestas.forEach((r) => expect([200, 201]).toContain(r.status));
      expect(mockReintentos.n).toBe(0);
      expect((await conciliacion(e)).consistent).toBe(true);
    });
  });

  describe('ajustes de la revisión', () => {
    it('una recepción sólo de vacías deja la orden enviada, impide cancelarla (409) y se puede anular', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await vaciasEnElDeposito(e, g, 10);
      const p = await proveedor(e);
      const orden = await ordenEnviada(e, p.supplierId, [
        { gasCylinderId: g.gasCylinderId, quantity: 10, unitCost: 100 },
      ]);
      const r = cuerpo<Recepcion>(
        await recibir(e, {
          purchaseOrderId: orden.purchaseOrderId,
          supplierDocumentNumber: 'V-1',
          items: [
            {
              gasCylinderId: g.gasCylinderId,
              quantityFull: 0,
              quantityEmptyOut: 4,
            },
          ],
        }).expect(201),
      );
      expect(
        cuerpo<Orden>(
          await http()
            .get(`/purchase-orders/${orden.purchaseOrderId}`)
            .set(e.headers)
            .expect(200),
        ).status,
      ).toBe('sent');
      await http()
        .patch(`/purchase-orders/${orden.purchaseOrderId}/cancel`)
        .set(e.headers)
        .send({ reason: 'x' })
        .expect(409);
      await http()
        .patch(`/purchase-receipts/${r.receiptId}/void`)
        .set(e.headers)
        .send({ reason: 'x' })
        .expect(200);
      expect(await saldo(e.locationId, g.gasCylinderId, 'empty')).toBe(10);
      // anuladas todas, ahora sí se cancela
      await http()
        .patch(`/purchase-orders/${orden.purchaseOrderId}/cancel`)
        .set(e.headers)
        .send({ reason: 'x' })
        .expect(200);
    });

    it('cerrar con faltante: motivo obligatorio, no espera más, libera al proveedor y sus recepciones se pueden anular', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const orden = await ordenEnviada(e, p.supplierId, [
        { gasCylinderId: g.gasCylinderId, quantity: 10, unitCost: 100 },
      ]);
      const url = `/purchase-orders/${orden.purchaseOrderId}/close-short`;
      await http().patch(url).set(e.headers).send({ reason: 'x' }).expect(400); // enviada sin recibir: se cancela
      const r = cuerpo<Recepcion>(
        await recibir(e, {
          purchaseOrderId: orden.purchaseOrderId,
          supplierDocumentNumber: 'C-1',
          items: [{ gasCylinderId: g.gasCylinderId, quantityFull: 6 }],
        }).expect(201),
      );
      await http()
        .delete(`/suppliers/${p.supplierId}`)
        .set(e.headers)
        .expect(409);
      const sinMotivo = await http()
        .patch(url)
        .set(e.headers)
        .send({})
        .expect(400);
      expect(JSON.stringify(sinMotivo.body)).toMatch(
        /el motivo es obligatorio/,
      );
      const cerrada = cuerpo<Orden & { closeReason: string }>(
        await http()
          .patch(url)
          .set(e.headers)
          .send({ reason: 'La planta no repone' })
          .expect(200),
      );
      expect(cerrada).toMatchObject({
        status: 'closed_short',
        closeReason: 'La planta no repone',
        pendingQuantity: 0,
        receivedQuantity: 6,
      });
      await recibir(e, {
        purchaseOrderId: orden.purchaseOrderId,
        supplierDocumentNumber: 'C-2',
        items: [{ gasCylinderId: g.gasCylinderId, quantityFull: 1 }],
      }).expect(400);
      expect(
        cuerpo<Pendiente>(
          await http()
            .get(`/purchase-orders/${orden.purchaseOrderId}/pending`)
            .set(e.headers)
            .expect(200),
        ).totalPending,
      ).toBe(0);
      // anular su recepción no falla por la transición y la orden sigue cerrada con faltante
      await http()
        .patch(`/purchase-receipts/${r.receiptId}/void`)
        .set(e.headers)
        .send({ reason: 'x' })
        .expect(200);
      expect(
        cuerpo<Orden>(
          await http()
            .get(`/purchase-orders/${orden.purchaseOrderId}`)
            .set(e.headers)
            .expect(200),
        ).status,
      ).toBe('closed_short');
      await http()
        .delete(`/suppliers/${p.supplierId}`)
        .set(e.headers)
        .expect(200);
    });

    it.each([1, 2, 5])(
      'anular la última compra restaura EXACTO el promedio previo aunque se hayan perdido %s llenas entre medio',
      async (perdidas) => {
        const e = await seedDistribuidora();
        const g = await seedGarrafa(e.distributorId);
        const p = await proveedor(e);
        const compra = (doc: string, cantidad: number, unitCost: number) =>
          recibir(e, {
            supplierId: p.supplierId,
            supplierDocumentNumber: doc,
            items: [
              {
                gasCylinderId: g.gasCylinderId,
                quantityFull: cantidad,
                unitCost,
              },
            ],
          }).expect(201);
        await compra('A', 10, 100);
        const r2 = cuerpo<Recepcion>(await compra('B', 10, 200));
        const promedio = async () =>
          cuerpo<Costo[]>(
            await http()
              .get('/purchase-receipts/average-costs')
              .set(e.headers)
              .expect(200),
          )[0].averageUnitCost;
        expect(await promedio()).toBe(150);
        await http()
          .post('/stock/adjustments')
          .set(e.headers)
          .send({
            location: { warehouseId: e.warehouseId },
            reason: 'lost',
            notes: 'ventas simuladas',
            items: [
              {
                gasCylinderId: g.gasCylinderId,
                condition: 'full',
                quantityDelta: -perdidas,
              },
            ],
          })
          .expect(201);
        expect(await promedio()).toBe(150); // las pérdidas no cambian el promedio
        await http()
          .patch(`/purchase-receipts/${r2.receiptId}/void`)
          .set(e.headers)
          .send({ reason: 'x' })
          .expect(200);
        expect(await promedio()).toBe(100);
        expect((await conciliacion(e)).consistent).toBe(true);
      },
    );

    it('si se anula la única compra el costo vuelve a null', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const r = cuerpo<Recepcion>(
        await recibir(e, {
          supplierId: p.supplierId,
          supplierDocumentNumber: 'U-1',
          items: [
            { gasCylinderId: g.gasCylinderId, quantityFull: 10, unitCost: 300 },
          ],
        }).expect(201),
      );
      const costo = async () =>
        cuerpo<Costo[]>(
          await http()
            .get('/purchase-receipts/average-costs')
            .set(e.headers)
            .expect(200),
        )[0].averageUnitCost;
      expect(await costo()).toBe(300);
      await http()
        .patch(`/purchase-receipts/${r.receiptId}/void`)
        .set(e.headers)
        .send({ reason: 'x' })
        .expect(200);
      expect(await costo()).toBeNull();
    });

    it('con una compra posterior repite las vigentes sin las llenas de la anulada', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const compra = async (doc: string, cantidad: number, unitCost: number) =>
        cuerpo<Recepcion>(
          await recibir(e, {
            supplierId: p.supplierId,
            supplierDocumentNumber: doc,
            items: [
              {
                gasCylinderId: g.gasCylinderId,
                quantityFull: cantidad,
                unitCost,
              },
            ],
          }).expect(201),
        );
      await compra('A', 10, 100); // 100
      const b = await compra('B', 10, 200); // 150
      await compra('C', 20, 300); // (20 x 150 + 20 x 300) / 40 = 225
      await http()
        .patch(`/purchase-receipts/${b.receiptId}/void`)
        .set(e.headers)
        .send({ reason: 'x' })
        .expect(200);
      // C vio 20 llenas; sin las 10 de B eran 10: (10 x 100 + 20 x 300) / 30
      const [c] = cuerpo<Costo[]>(
        await http()
          .get('/purchase-receipts/average-costs')
          .set(e.headers)
          .expect(200),
      );
      expect(c.averageUnitCost).toBe(233.33);
    });

    it.each([
      ['R2 y después R3', [1, 2], 100],
      ['R3 y después R2', [2, 1], 100],
      ['sólo R2', [1], 100],
      ['sólo R3', [2], 144.44],
    ])(
      'varias anulaciones seguidas (%s) dejan el promedio exacto de las compras que quedan',
      async (_nombre, aAnular, esperado) => {
        const e = await seedDistribuidora();
        const g = await seedGarrafa(e.distributorId);
        const p = await proveedor(e);
        // 25 llenas sin costo en el depósito; después R1 a 100, R2 a 300 y R3 a 100 (10 cada una)
        await conBypass(
          ds,
          ['saldos'],
          `INSERT INTO "stock_balance" ("distributor_id","location_id","gas_cylinder_id","condition","quantity")
           VALUES ($1, $2, $3, 'full', 25)`,
          [e.distributorId, e.locationId, g.gasCylinderId],
        );
        await ds.query(
          `UPDATE "gas_cylinder" SET "stock" = 25 WHERE "gas_cylinder_id" = $1`,
          [g.gasCylinderId],
        );
        const compras: Recepcion[] = [];
        for (const [doc, costo] of [
          ['R1', 100],
          ['R2', 300],
          ['R3', 100],
        ] as const) {
          compras.push(
            cuerpo<Recepcion>(
              await recibir(e, {
                supplierId: p.supplierId,
                supplierDocumentNumber: doc,
                items: [
                  {
                    gasCylinderId: g.gasCylinderId,
                    quantityFull: 10,
                    unitCost: costo,
                  },
                ],
              }).expect(201),
            ),
          );
        }
        const promedio = async () =>
          cuerpo<Costo[]>(
            await http()
              .get('/purchase-receipts/average-costs')
              .set(e.headers)
              .expect(200),
          )[0].averageUnitCost;
        expect(await promedio()).toBe(136.36);
        for (const i of aAnular) {
          await http()
            .patch(`/purchase-receipts/${compras[i].receiptId}/void`)
            .set(e.headers)
            .send({ reason: 'x' })
            .expect(200);
        }
        expect(await promedio()).toBe(esperado);
      },
    );

    it('anular con un motivo largo no desborda las notas del libro: se anula y el motivo queda entero', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const r = cuerpo<Recepcion>(
        await recibir(e, {
          supplierId: p.supplierId,
          supplierDocumentNumber: 'LARGO',
          items: [
            { gasCylinderId: g.gasCylinderId, quantityFull: 2, unitCost: 10 },
          ],
        }).expect(201),
      );
      const motivo = 'm'.repeat(500);
      await http()
        .patch(`/purchase-receipts/${r.receiptId}/void`)
        .set(e.headers)
        .send({ reason: motivo })
        .expect(200);
      const [{ void_reason: guardado }] = await ds.query<
        Array<{ void_reason: string }>
      >(
        `SELECT "void_reason" FROM "purchase_receipt" WHERE "receipt_id" = $1`,
        [r.receiptId],
      );
      expect(guardado).toBe(motivo);
      const [{ notes }] = await ds.query<Array<{ notes: string }>>(
        `SELECT "notes" FROM "stock_movement" WHERE "reason" = 'reversal' AND "gas_cylinder_id" = $1 LIMIT 1`,
        [g.gasCylinderId],
      );
      expect(notes).toHaveLength(300);
    });

    it('una recepción fechada antes del conteo inicial del depósito es 400 y no escribe', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      await http()
        .post('/stock/initial-counts')
        .set(e.headers)
        .send({
          warehouseId: e.warehouseId,
          items: [{ gasCylinderId: g.gasCylinderId, full: 5 }],
        })
        .expect(201);
      const antes = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM "stock_movement" WHERE "distributor_id" = $1`,
        [e.distributorId],
      );
      const r = await recibir(e, {
        supplierId: p.supplierId,
        supplierDocumentNumber: 'VIEJA',
        receivedAt: '2020-01-01T10:00:00Z',
        items: [
          { gasCylinderId: g.gasCylinderId, quantityFull: 2, unitCost: 10 },
        ],
      }).expect(400);
      expect(cuerpo<{ message: string }>(r).message).toMatch(
        /anterior al conteo inicial de este depósito/,
      );
      const despues = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM "stock_movement" WHERE "distributor_id" = $1`,
        [e.distributorId],
      );
      expect(despues[0].n).toBe(antes[0].n);
    });

    it('sin conteo inicial una recepción con fecha pasada se acepta y la reaplicación no toca pedidos anteriores', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      await recibir(e, {
        supplierId: p.supplierId,
        supplierDocumentNumber: 'AYER',
        receivedAt: '2020-01-01T10:00:00Z',
        items: [
          { gasCylinderId: g.gasCylinderId, quantityFull: 2, unitCost: 10 },
        ],
      }).expect(201);
      await http()
        .post('/stock/reconciliation/reapply-deliveries')
        .set(e.headers)
        .send({})
        .expect(201);
      const c = cuerpo<{
        consistent: boolean;
        deliveriesWithoutMovement: unknown[];
      }>(await http().get('/stock/reconciliation').set(e.headers).expect(200));
      expect(c.deliveriesWithoutMovement).toHaveLength(0);
      expect(c.consistent).toBe(true);
    });

    it('las escrituras de compras sin Idempotency-Key son 400', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      await recibir(e, {
        supplierId: p.supplierId,
        supplierDocumentNumber: 'SIN-CLAVE',
        items: [
          { gasCylinderId: g.gasCylinderId, quantityFull: 1, unitCost: 10 },
        ],
      })
        .unset('Idempotency-Key')
        .expect(400);
      await http()
        .patch(`/purchase-receipts/${randomUUID()}/void`)
        .set(e.headers)
        .unset('Idempotency-Key')
        .send({ reason: 'x' })
        .expect(400);
    });

    it('el documento del proveedor es único por tipo: remito y factura numeran aparte', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const body = (tipo: string) => ({
        supplierId: p.supplierId,
        supplierDocumentType: tipo,
        supplierDocumentNumber: '0001-1',
        items: [
          { gasCylinderId: g.gasCylinderId, quantityFull: 1, unitCost: 10 },
        ],
      });
      await recibir(e, body('delivery_note')).expect(201);
      await recibir(e, body('invoice')).expect(201);
      await recibir(e, body('invoice')).expect(409);
    });

    it('rechaza cantidades y costos que desbordarían numeric(12,2)', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      const orden = (items: unknown[]) =>
        http()
          .post('/purchase-orders')
          .set(e.headers)
          .send({ supplierId: p.supplierId, items });
      await orden([
        { gasCylinderId: g.gasCylinderId, quantity: 5001, unitCost: 1 },
      ]).expect(400);
      await orden([
        { gasCylinderId: g.gasCylinderId, quantity: 1, unitCost: 90001 },
      ]).expect(400);
      await orden([
        { gasCylinderId: g.gasCylinderId, quantity: 5000, unitCost: 90000 },
      ]).expect(201);
      await recibir(e, {
        supplierId: p.supplierId,
        supplierDocumentNumber: 'G-1',
        items: [
          { gasCylinderId: g.gasCylinderId, quantityFull: 5001, unitCost: 1 },
        ],
      }).expect(400);
    });

    it('recepciones, altas de pedido y entregas a la vez sobre la misma garrafa: sin deadlock ni reintentos', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const p = await proveedor(e);
      await recibir(e, {
        supplierId: p.supplierId,
        supplierDocumentNumber: 'BASE',
        items: [
          { gasCylinderId: g.gasCylinderId, quantityFull: 60, unitCost: 100 },
        ],
      }).expect(201);

      const rolDe = async (t: string) => (await rol(t)).roleId;
      const sufijo = randomUUID().slice(0, 6);
      const clienteUser = await ds.getRepository(User).save({
        email: `cli.${sufijo}@splg.local`,
        fullName: 'Cliente',
        phoneNumber: telefonoDePrueba(),
        roleId: await rolDe('customer'),
      } as Partial<User>);
      await ds.getRepository(Customer).save({
        userId: clienteUser.userId,
        notificationToken: 'fake',
      } as Partial<Customer>);
      const direccion = (await ds.getRepository(UserAddress).save({
        userId: clienteUser.userId,
        street: 'Av. Test 123',
        city: 'CABA',
        latitude: '-34.6037',
        longitude: '-58.3816',
      } as Partial<UserAddress>)) as UserAddress;
      const choferUser = await ds.getRepository(User).save({
        email: `chofer.${sufijo}@splg.local`,
        fullName: 'Chofer',
        phoneNumber: telefonoDePrueba(),
      } as Partial<User>);
      const chofer = (await ds.getRepository(Delivery).save({
        userId: choferUser.userId,
        distributorId: e.distributorId,
        validated: true,
        isEnabled: true,
      } as Partial<Delivery>)) as Delivery;

      // 6 pedidos en camino ya reservados (el vendible baja 6)
      const enCamino: Order[] = [];
      for (let i = 0; i < 6; i++) {
        const o = (await ds.getRepository(Order).save({
          customerId: clienteUser.userId,
          distributorId: e.distributorId,
          addressId: direccion.addressId,
          status: OrderStatus.ON_THE_WAY,
          paymentMethod: PaymentMethod.CASH,
          totalAmount: 1000,
          subtotalItems: 1000,
          deliveryId: chofer.deliveryId,
          acceptedAt: new Date(),
          onTheWayAt: new Date(),
        } as Partial<Order>)) as Order;
        await ds.getRepository(OrderItem).save({
          orderId: o.orderId,
          gasCylinderId: g.gasCylinderId,
          quantity: 1,
          unitPrice: 1000,
          subtotal: 1000,
        } as Partial<OrderItem>);
        enCamino.push(o);
      }
      await ds.query(
        `UPDATE gas_cylinder SET stock = stock - 6 WHERE gas_cylinder_id = $1`,
        [g.gasCylinderId],
      );

      const headersCliente: Headers = {
        Authorization: `Bearer cli.${sufijo}@splg.local`,
        'X-Client-Source': 'customer-app',
        'X-Distributor': e.slug,
      };
      const trabajo = [
        ...Array.from({ length: 5 }, (_, i) =>
          recibir(e, {
            supplierId: p.supplierId,
            supplierDocumentNumber: `M-${i}`,
            items: [
              {
                gasCylinderId: g.gasCylinderId,
                quantityFull: 3,
                unitCost: 120,
              },
            ],
          }).then((r) => r.status),
        ),
        ...Array.from({ length: 6 }, () =>
          http()
            .post('/orders')
            .set(headersCliente)
            .send({
              customerId: clienteUser.userId,
              addressId: direccion.addressId,
              paymentMethod: 'cash',
              items: [
                {
                  gasCylinderId: g.gasCylinderId,
                  quantity: 1,
                  unitPrice: 1000,
                },
              ],
            })
            .then((r) => r.status),
        ),
        ...enCamino.map((o) =>
          entregarComoAdmin(env, o.orderId).then(() => 200),
        ),
      ];
      const estados = await Promise.all(trabajo);
      estados.forEach((s) => expect([200, 201]).toContain(s));
      expect(mockReintentos.n).toBe(0);
      expect((await conciliacion(e)).consistent).toBe(true);
    }, 90000);
  });
});
