/**
 * Stock físico (M-C parte 1) contra la API con Postgres y Redis reales:
 * depósitos, conteo inicial, transferencias, ajustes, libro, conciliación,
 * aislamiento entre distribuidoras, idempotencia y concurrencia sobre el
 * mismo saldo.
 */
import { randomUUID } from 'crypto';
import { codigoSqlDelError } from '../../src/common/errors/db-exceptions';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  truncateAllTables,
} from './setup/test-env';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { Car } from '../../src/car/entities/car.entity';
import { WarehouseService } from '../../src/stock/application/warehouse.service';
import { StockLocationService } from '../../src/stock/application/stock-location.service';
import { StockLedgerPort } from '../../src/stock/domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../src/stock/domain/stock.enums';

interface Movimiento {
  movementId: string;
  reason: string;
  quantity: number;
  fromCondition: string | null;
  toCondition: string | null;
  reversedMovementId: string | null;
}
interface Operacion {
  batchId: string;
  movements: Movimiento[];
}
interface Ajuste {
  adjustmentId: string;
  number: number;
  reason: string;
  notes: string;
  items: Array<{ quantityDelta: number; condition: string }>;
}
interface Deposito {
  warehouseId: string;
  locationId: string;
  code: string;
  isDefault: boolean;
}
interface Saldo {
  locationKind: string;
  condition: string;
  quantity: number;
}
interface Pagina {
  total: number;
  data: unknown[];
}
interface Conciliacion {
  consistent: boolean;
  cylinders: Array<Record<string, number>>;
}
interface Mensaje {
  message: string;
}
/** El cuerpo de una respuesta de supertest, con el tipo que el test espera. */
const cuerpo = <T>(res: { body: unknown }): T => res.body as T;
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

describe('Stock físico (e2e)', () => {
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
    for (const tipo of ['admin', 'delivery', 'customer', 'super_admin']) {
      await rol(tipo);
    }
  });

  const http = () => request(env.app.getHttpServer());

  /** Deja llenas en un camión como lo haría la carga: depósito -> camión por el libro. */
  const alCamion = (
    e: { distributorId: string; locationId: string },
    carId: string,
    gasCylinderId: string,
    quantity: number,
  ) =>
    ds.transaction(async (manager) => {
      const camion = await env.app
        .get(StockLocationService)
        .ubicacionDeVehiculo(manager, e.distributorId, carId);
      await env.app.get(StockLedgerPort).aplicar(manager, {
        distributorId: e.distributorId,
        referenceType: StockReferenceType.TRANSFER,
        referenceId: null,
        actorUserId: null,
        movimientos: [
          {
            gasCylinderId,
            quantity,
            from: { locationId: e.locationId, condition: StockCondition.FULL },
            to: {
              locationId: camion.locationId,
              condition: StockCondition.FULL,
            },
            reason: StockMovementReason.TRANSFER,
          },
        ],
      });
    });

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
      warehouseId: deposito.warehouse.warehouseId,
      locationId: deposito.locationId,
      headers,
    };
  }

  async function seedGarrafa(distributorId: string, type = '10kg', stock = 0) {
    return (await ds.getRepository(GasCylinder).save({
      type,
      price: 1000,
      weight: 10,
      stock,
      isActive: true,
      distributorId,
    } as Partial<GasCylinder>)) as GasCylinder;
  }

  async function seedAuto(distributorId: string, userId: string) {
    return (await ds.getRepository(Car).save({
      distributorId,
      userId,
      carPatent: `AB${Math.floor(Math.random() * 900 + 100)}CD`,
    } as Partial<Car>)) as Car;
  }

  const saldo = async (
    locationId: string,
    gasCylinderId: string,
    condition = 'full',
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

  function conteoInicial(
    e: Awaited<ReturnType<typeof seedDistribuidora>>,
    g: GasCylinder,
    full: number,
    empty = 0,
  ) {
    return http()
      .post('/stock/initial-counts')
      .set(e.headers)
      .send({
        warehouseId: e.warehouseId,
        items: [{ gasCylinderId: g.gasCylinderId, full, empty }],
      });
  }

  const ajuste = (
    headers: Headers,
    e: { warehouseId: string },
    g: GasCylinder,
    reason: string,
    quantityDelta: number,
    notes = 'nota de prueba',
    condition = 'full',
  ) =>
    http()
      .post('/stock/adjustments')
      .set(headers)
      .send({
        location: { warehouseId: e.warehouseId },
        reason,
        notes,
        items: [{ gasCylinderId: g.gasCylinderId, condition, quantityDelta }],
      });

  describe('recorrido: conteo inicial → camión → merma → saldos, libro y conciliación', () => {
    it('mantiene el vendible igual al físico menos lo reservado en cada paso', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId, '10kg', 0);
      const chofer = (await ds.getRepository(User).save({
        email: `chofer.${randomUUID().slice(0, 6)}@splg.local`,
        fullName: 'Chofer',
        phoneNumber: telefonoDePrueba(),
        roleId: (await rol('delivery')).roleId,
      } as Partial<User>)) as User;
      const auto = await seedAuto(e.distributorId, chofer.userId);

      // 1. Conteo inicial: 40 llenas y 12 vacías; el vendible pasa a 40.
      const conteo = await conteoInicial(e, g, 40, 12).expect(201);
      expect(cuerpo<Ajuste>(conteo)).toMatchObject({
        number: 1,
        reason: 'initial_count',
      });
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(40);
      expect(await saldo(e.locationId, g.gasCylinderId, 'empty')).toBe(12);
      expect(await vendible(g.gasCylinderId)).toBe(40);

      // Un pedido abierto reserva 5 (así lo hace CreateOrderUseCase).
      await ds.query(
        `UPDATE gas_cylinder SET stock = stock - 5 WHERE gas_cylinder_id = $1`,
        [g.gasCylinderId],
      );
      const cliente = (await ds.getRepository(User).save({
        email: `cli.${randomUUID().slice(0, 6)}@splg.local`,
        fullName: 'Cliente',
        phoneNumber: telefonoDePrueba(),
        roleId: (await rol('customer')).roleId,
      } as Partial<User>)) as User;
      const [{ address_id }] = await ds.query<Array<{ address_id: string }>>(
        `INSERT INTO user_address (user_id, street, city) VALUES ($1, 'x', 'y') RETURNING address_id`,
        [cliente.userId],
      );
      const [{ order_id }] = await ds.query<Array<{ order_id: string }>>(
        `INSERT INTO "order" (distributor_id, customer_id, address_id, status, "paymentMethod", "totalAmount", subtotal_items)
         VALUES ($1, $2, $3, 'pending', 'cash', 5000, 5000) RETURNING order_id`,
        [e.distributorId, cliente.userId, address_id],
      );
      await ds.query(
        `INSERT INTO order_item (order_id, gas_cylinder_id, quantity, "unitPrice", subtotal) VALUES ($1, $2, 5, 1000, 5000)`,
        [order_id, g.gasCylinderId],
      );

      // 2. Transferencia de 10 llenas al camión (depósito → vehículo).
      // Por la API ya no: el camión se carga desde la carga del día.
      const rechazada = await http()
        .post('/stock/transfers')
        .set(e.headers)
        .send({
          from: { warehouseId: e.warehouseId },
          to: { carId: auto.carId },
          items: [{ gasCylinderId: g.gasCylinderId, quantity: 10 }],
        })
        .expect(400);
      expect(cuerpo<Mensaje>(rechazada).message).toMatch(
        /se carga y se rinde desde la carga del día/,
      );
      await alCamion(e, auto.carId, g.gasCylinderId, 10);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(30);
      expect(await vendible(g.gasCylinderId)).toBe(35); // la transferencia no cambia el vendible

      // 3. Merma de 2 llenas en el depósito: el vendible baja 2.
      const merma = await ajuste(
        e.headers,
        e,
        g,
        'shrinkage',
        -2,
        'Se descartaron dos con la válvula floja',
      ).expect(201);
      expect(cuerpo<Ajuste>(merma)).toMatchObject({
        number: 2,
        reason: 'shrinkage',
        items: [{ quantityDelta: -2, condition: 'full' }],
      });
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(28);
      expect(await vendible(g.gasCylinderId)).toBe(33);

      // 4. Saldos, resumen galpón vs camiones, libro y detalle del ajuste.
      const saldos = await http().get('/stock').set(e.headers).expect(200);
      expect(
        cuerpo<Saldo[]>(saldos)
          .map((s) => [s.locationKind, s.condition, s.quantity])
          .sort(),
      ).toEqual([
        ['vehicle', 'full', 10],
        ['warehouse', 'empty', 12],
        ['warehouse', 'full', 28],
      ]);
      const resumen = await http()
        .get('/stock/summary')
        .set(e.headers)
        .expect(200);
      expect(cuerpo<Array<Record<string, unknown>>>(resumen)[0]).toMatchObject({
        warehouses: { full: 28, empty: 12, defective: 0 },
        vehicles: { full: 10, empty: 0, defective: 0 },
        physicalFull: 38,
        reserved: 5,
        sellable: 33,
      });
      const libro = await http()
        .get('/stock/movements?limit=50')
        .set(e.headers)
        .expect(200);
      expect(cuerpo<Pagina>(libro).total).toBe(4); // 2 del conteo + 1 transferencia + 1 merma
      const soloMermas = await http()
        .get('/stock/movements?reason=shrinkage')
        .set(e.headers)
        .expect(200);
      expect(cuerpo<Pagina>(soloMermas).total).toBe(1);
      const delCamion = await http()
        .get(
          `/stock/movements?locationId=${(await ds.query<Array<{ location_id: string }>>(`SELECT location_id FROM stock_location WHERE car_id = $1`, [auto.carId]))[0].location_id}`,
        )
        .set(e.headers)
        .expect(200);
      expect(cuerpo<Pagina>(delCamion).total).toBe(1);
      const detalle = await http()
        .get(`/stock/adjustments/${cuerpo<Ajuste>(merma).adjustmentId}`)
        .set(e.headers)
        .expect(200);
      expect(cuerpo<Ajuste>(detalle).notes).toBe(
        'Se descartaron dos con la válvula floja',
      );

      // 5. Conciliación: 33 = 38 − 5.
      const concil = await http()
        .get('/stock/reconciliation')
        .set(e.headers)
        .expect(200);
      expect(cuerpo<Conciliacion>(concil).consistent).toBe(true);
      expect(cuerpo<Conciliacion>(concil).cylinders[0]).toMatchObject({
        sellable: 33,
        physicalFull: 38,
        reserved: 5,
        expected: 33,
        difference: 0,
      });

      // Si alguien toca el vendible por fuera, la conciliación lo ve y no lo corrige.
      await ds.query(
        `UPDATE gas_cylinder SET stock = stock + 4 WHERE gas_cylinder_id = $1`,
        [g.gasCylinderId],
      );
      const roto = await http()
        .get('/stock/reconciliation')
        .set(e.headers)
        .expect(200);
      expect(cuerpo<Conciliacion>(roto).consistent).toBe(false);
      expect(cuerpo<Conciliacion>(roto).cylinders[0]).toMatchObject({
        difference: 4,
      });
      expect(await vendible(g.gasCylinderId)).toBe(37);
    });

    it('el PATCH de stock del catálogo es un ajuste: deja rastro y respeta el físico', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId, '10kg', 0);
      await conteoInicial(e, g, 10).expect(201);

      const sube = await http()
        .patch(`/gascylinder/${g.gasCylinderId}/stock`)
        .set(e.headers)
        .send({ quantity: 5 })
        .expect(200);
      expect(cuerpo<{ stock: number }>(sube).stock).toBe(15);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(15);

      await http()
        .patch(`/gascylinder/${g.gasCylinderId}/stock`)
        .set(e.headers)
        .send({ quantity: -20 })
        .expect(400);
      expect(await vendible(g.gasCylinderId)).toBe(15);
      const ajustes = await http()
        .get('/stock/adjustments')
        .set(e.headers)
        .expect(200);
      expect(cuerpo<Pagina>(ajustes).total).toBe(2); // conteo + el ajuste del catálogo
    });
  });

  describe('casos de error', () => {
    it('no deja saldos negativos: una merma mayor al saldo del camión es 400 y no cambia nada', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const chofer = (await ds.getRepository(User).save({
        email: `chofer.${randomUUID().slice(0, 6)}@splg.local`,
        fullName: 'Chofer',
        phoneNumber: telefonoDePrueba(),
        roleId: (await rol('delivery')).roleId,
      } as Partial<User>)) as User;
      const auto = await seedAuto(e.distributorId, chofer.userId);
      await conteoInicial(e, g, 10).expect(201);
      await alCamion(e, auto.carId, g.gasCylinderId, 5);

      const res = await http()
        .post('/stock/adjustments')
        .set(e.headers)
        .send({
          location: { carId: auto.carId },
          reason: 'shrinkage',
          notes: 'pérdida en ruta',
          items: [
            {
              gasCylinderId: g.gasCylinderId,
              condition: 'full',
              quantityDelta: -6,
            },
          ],
        })
        .expect(400);
      expect(cuerpo<Mensaje>(res).message).toMatch(
        /Stock insuficiente: 10kg llenas en vehículo .* \(hay 5, se necesitan 6\)/,
      );
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(5);
      expect(await vendible(g.gasCylinderId)).toBe(10);
      const [{ n }] = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM stock_adjustment`,
      );
      expect(Number(n)).toBe(1); // sólo el conteo: el fallido no dejó cabecera ni número
    });

    it('el vendible no queda negativo: no se pueden sacar llenas reservadas por pedidos', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);
      await ds.query(
        `UPDATE gas_cylinder SET stock = 2 WHERE gas_cylinder_id = $1`,
        [g.gasCylinderId],
      ); // 8 reservadas
      const res = await ajuste(e.headers, e, g, 'lost', -3).expect(400);
      expect(cuerpo<Mensaje>(res).message).toMatch(/vendible/);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(10);
    });

    it('un ajuste sin nota es 400', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 5).expect(201);
      await http()
        .post('/stock/adjustments')
        .set(e.headers)
        .send({
          location: { warehouseId: e.warehouseId },
          reason: 'lost',
          items: [
            {
              gasCylinderId: g.gasCylinderId,
              condition: 'full',
              quantityDelta: -1,
            },
          ],
        })
        .expect(400);
      await ajuste(e.headers, e, g, 'lost', -1, '   ').expect(400);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(5);
    });

    it('otra distribuidora no ve ni toca nada de la primera (404)', async () => {
      const a = await seedDistribuidora();
      const b = await seedDistribuidora();
      const g = await seedGarrafa(a.distributorId);
      const gB = await seedGarrafa(b.distributorId);
      const conteo = await conteoInicial(a, g, 10).expect(201);

      // El depósito, el ajuste y la garrafa de A no existen para B.
      await http()
        .get(`/warehouses/${a.warehouseId}`)
        .set(b.headers)
        .expect(404);
      await http()
        .get(`/stock/adjustments/${cuerpo<Ajuste>(conteo).adjustmentId}`)
        .set(b.headers)
        .expect(404);
      await http()
        .post('/stock/adjustments')
        .set(b.headers)
        .send({
          location: { warehouseId: a.warehouseId },
          reason: 'lost',
          notes: 'x',
          items: [
            {
              gasCylinderId: gB.gasCylinderId,
              condition: 'full',
              quantityDelta: -1,
            },
          ],
        })
        .expect(404);
      await ajuste(b.headers, b, g, 'lost', -1).expect(404);
      await http()
        .post('/stock/transfers')
        .set(b.headers)
        .send({
          from: { warehouseId: a.warehouseId },
          to: { warehouseId: b.warehouseId },
          items: [{ gasCylinderId: g.gasCylinderId, quantity: 1 }],
        })
        .expect(404);
      await http()
        .delete(`/warehouses/${a.warehouseId}`)
        .set(b.headers)
        .expect(404);
      await http()
        .patch(`/gascylinder/${g.gasCylinderId}/stock`)
        .set(b.headers)
        .send({ quantity: 1 })
        .expect(404);

      // Los listados de B están vacíos y el saldo de A no se movió.
      expect(
        cuerpo<unknown[]>(
          await http().get('/stock').set(b.headers).expect(200),
        ),
      ).toEqual([]);
      expect(
        cuerpo<Pagina>(
          await http().get('/stock/movements').set(b.headers).expect(200),
        ).total,
      ).toBe(0);
      expect(await saldo(a.locationId, g.gasCylinderId)).toBe(10);
    });

    it('un camión de otra distribuidora es 404 como destino', async () => {
      const a = await seedDistribuidora();
      const b = await seedDistribuidora();
      const g = await seedGarrafa(a.distributorId);
      await conteoInicial(a, g, 10).expect(201);
      const chofer = (await ds.getRepository(User).save({
        email: `chofer.${randomUUID().slice(0, 6)}@splg.local`,
        fullName: 'Chofer B',
        phoneNumber: telefonoDePrueba(),
        roleId: (await rol('delivery')).roleId,
      } as Partial<User>)) as User;
      const autoB = await seedAuto(b.distributorId, chofer.userId);
      await http()
        .post('/stock/transfers')
        .set(a.headers)
        .send({
          from: { warehouseId: a.warehouseId },
          to: { carId: autoB.carId },
          items: [{ gasCylinderId: g.gasCylinderId, quantity: 1 }],
        })
        .expect(404);
      expect(await saldo(a.locationId, g.gasCylinderId)).toBe(10);
    });

    it('repetir la misma Idempotency-Key devuelve lo mismo y mueve el stock una sola vez', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);
      const clave = randomUUID();
      const enviar = () =>
        http()
          .post('/stock/adjustments')
          .set(e.headers)
          .set('Idempotency-Key', clave)
          .send({
            location: { warehouseId: e.warehouseId },
            reason: 'lost',
            notes: 'una',
            items: [
              {
                gasCylinderId: g.gasCylinderId,
                condition: 'full',
                quantityDelta: -3,
              },
            ],
          });
      const primero = await enviar().expect(201);
      const segundo = await enviar().expect(201);
      expect(cuerpo<Ajuste>(segundo).adjustmentId).toBe(
        cuerpo<Ajuste>(primero).adjustmentId,
      );
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(7);
      const [{ n }] = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM stock_adjustment WHERE reason = 'lost'`,
      );
      expect(Number(n)).toBe(1);
    });

    it('el conteo inicial se hace una sola vez por depósito', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);
      await conteoInicial(e, g, 20).expect(409);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(10);
    });

    it('no se da de baja un depósito con saldo ni el predeterminado; sí uno vacío', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);
      await http()
        .delete(`/warehouses/${e.warehouseId}`)
        .set(e.headers)
        .expect(409);
      const suc = await http()
        .post('/warehouses')
        .set(e.headers)
        .send({ name: 'Sucursal', code: 'suc' })
        .expect(201);
      expect(cuerpo<Deposito>(suc)).toMatchObject({
        code: 'SUC',
        isDefault: false,
      });
      await http()
        .post('/warehouses')
        .set(e.headers)
        .send({ name: 'Otra', code: 'SUC' })
        .expect(409);
      await http()
        .delete(`/warehouses/${cuerpo<Deposito>(suc).warehouseId}`)
        .set(e.headers)
        .expect(200);
      // La baja es lógica: la fila sigue en la base, pero ya no se ve.
      await http()
        .get(`/warehouses/${cuerpo<Deposito>(suc).warehouseId}`)
        .set(e.headers)
        .expect(404);
      const [{ borrado }] = await ds.query<Array<{ borrado: boolean }>>(
        `SELECT "deletedAt" IS NOT NULL AS borrado FROM warehouse WHERE warehouse_id = $1`,
        [cuerpo<Deposito>(suc).warehouseId],
      );
      expect(borrado).toBe(true);
      const lista = await http().get('/warehouses').set(e.headers).expect(200);
      expect(cuerpo<Deposito[]>(lista).map((w) => w.code)).toEqual(['CENTRAL']);
    });

    it('una transferencia contraasentada devuelve las garrafas; no se puede contraasentar dos veces', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);
      const suc = await http()
        .post('/warehouses')
        .set(e.headers)
        .send({ name: 'Sucursal', code: 'SUC' })
        .expect(201);
      const t = await http()
        .post('/stock/transfers')
        .set(e.headers)
        .send({
          from: { warehouseId: e.warehouseId },
          to: { warehouseId: cuerpo<Deposito>(suc).warehouseId },
          items: [{ gasCylinderId: g.gasCylinderId, quantity: 4 }],
        })
        .expect(201);
      expect(
        await saldo(cuerpo<Deposito>(suc).locationId, g.gasCylinderId),
      ).toBe(4);
      const rev = await http()
        .post(
          `/stock/movements/batches/${cuerpo<Operacion>(t).batchId}/reverse`,
        )
        .set(e.headers)
        .send({ notes: 'error de carga' })
        .expect(201);
      expect(cuerpo<Operacion>(rev).movements[0]).toMatchObject({
        reason: 'reversal',
        reversedMovementId: cuerpo<Operacion>(t).movements[0].movementId,
      });
      expect(
        await saldo(cuerpo<Deposito>(suc).locationId, g.gasCylinderId),
      ).toBe(0);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(10);
      await http()
        .post(
          `/stock/movements/batches/${cuerpo<Operacion>(t).batchId}/reverse`,
        )
        .set(e.headers)
        .send({})
        .expect(409);
    });

    it('una rotura pasa llenas a defectuosas y baja el vendible', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);
      await ajuste(e.headers, e, g, 'damaged', -3, 'Cayeron del camión').expect(
        201,
      );
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(7);
      expect(await saldo(e.locationId, g.gasCylinderId, 'defective')).toBe(3);
      expect(await vendible(g.gasCylinderId)).toBe(7);
    });
  });

  describe('revisión: conciliación, alta de producto, predeterminado y estados', () => {
    it('el ajuste de conciliación corrige sólo el vendible, deja documento sin movimientos físicos y exige nota', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);
      await ds.query(
        `UPDATE gas_cylinder SET stock = stock + 4 WHERE gas_cylinder_id = $1`,
        [g.gasCylinderId],
      );

      const concil = cuerpo<Conciliacion>(
        await http().get('/stock/reconciliation').set(e.headers).expect(200),
      );
      expect(concil.cylinders[0]).toMatchObject({
        difference: 4,
        correction: -4,
      });
      const [{ n: movsAntes }] = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM stock_movement`,
      );

      const pedir = (body: object) =>
        http()
          .post('/stock/reconciliation/adjustments')
          .set(e.headers)
          .send({ gasCylinderId: g.gasCylinderId, ...body });
      await pedir({}).expect(400); // sin nota
      await pedir({ notes: 'x', expectedDifference: 9 }).expect(409); // número viejo
      const ok = await pedir({
        notes: 'Se tocó a mano antes del módulo',
        expectedDifference: 4,
      }).expect(201);
      expect(cuerpo<Ajuste>(ok)).toMatchObject({
        reason: 'reconciliation',
        items: [{ quantityDelta: -4 }],
      });

      expect(await vendible(g.gasCylinderId)).toBe(10);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(10); // el físico no se tocó
      const [{ n: movsDespues }] = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM stock_movement`,
      );
      expect(movsDespues).toBe(movsAntes);
      expect(
        cuerpo<Conciliacion>(
          await http().get('/stock/reconciliation').set(e.headers).expect(200),
        ).consistent,
      ).toBe(true);
      await pedir({ notes: 'otra vez' }).expect(400); // ya no hay diferencia
    });

    it('un producto nuevo con stock queda con su físico en la MISMA transacción (sin esperar a nadie)', async () => {
      const e = await seedDistribuidora();
      const res = await http()
        .post('/gascylinder')
        .set(e.headers)
        .send({ type: '15kg', weight: 15, price: 1500, stock: 12 })
        .expect(201);
      const id = (res.body as { gas_cylinder_id: string }).gas_cylinder_id;
      // Inmediatamente después de la respuesta, sin dormir.
      expect(await saldo(e.locationId, id)).toBe(12);
      expect(
        cuerpo<Conciliacion>(
          await http().get('/stock/reconciliation').set(e.headers).expect(200),
        ).consistent,
      ).toBe(true);
    });

    it('editar un producto con stock es 400 con un mensaje claro; sin stock se edita', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId, '10kg', 5);
      const r = await http()
        .patch(`/gascylinder/${g.gasCylinderId}`)
        .set(e.headers)
        .send({ price: 2000, stock: 99 })
        .expect(400);
      expect(cuerpo<Mensaje>(r).message).toMatch(
        /El stock se cambia con un ajuste de stock/,
      );
      await http()
        .patch(`/gascylinder/${g.gasCylinderId}`)
        .set(e.headers)
        .send({ price: 2000 })
        .expect(200);
      expect(await vendible(g.gasCylinderId)).toBe(5);
    });

    it('PATCH de stock negativo con las llenas en un camión dice dónde están', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      const chofer = (await ds.getRepository(User).save({
        email: `chofer.${randomUUID().slice(0, 6)}@splg.local`,
        fullName: 'Chofer',
        phoneNumber: telefonoDePrueba(),
        roleId: (await rol('delivery')).roleId,
      } as Partial<User>)) as User;
      const auto = await seedAuto(e.distributorId, chofer.userId);
      await conteoInicial(e, g, 10).expect(201);
      await alCamion(e, auto.carId, g.gasCylinderId, 8);
      const r = await http()
        .patch(`/gascylinder/${g.gasCylinderId}/stock`)
        .set(e.headers)
        .send({ quantity: -5 })
        .expect(400);
      expect(cuerpo<Mensaje>(r).message).toMatch(
        /sólo tiene 2 llenas.*8 en camiones.*transferilas/,
      );
    });

    it('dos cambios simultáneos del predeterminado hacia depósitos distintos dejan uno solo y no tiran 500', async () => {
      const e = await seedDistribuidora();
      const a = cuerpo<Deposito>(
        await http()
          .post('/warehouses')
          .set(e.headers)
          .send({ name: 'A', code: 'A' })
          .expect(201),
      );
      const b = cuerpo<Deposito>(
        await http()
          .post('/warehouses')
          .set(e.headers)
          .send({ name: 'B', code: 'B' })
          .expect(201),
      );
      const r = await Promise.all([
        http()
          .patch(`/warehouses/${a.warehouseId}`)
          .set(e.headers)
          .send({ isDefault: true }),
        http()
          .patch(`/warehouses/${b.warehouseId}`)
          .set(e.headers)
          .send({ isDefault: true }),
      ]);
      expect(r.every((x) => x.status === 200 || x.status === 409)).toBe(true);
      const [{ n }] = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM warehouse WHERE distributor_id = $1 AND is_default AND "deletedAt" IS NULL`,
        [e.distributorId],
      );
      expect(Number(n)).toBe(1);
    });

    it('un depósito inactivo no recibe transferencias pero puede entregar', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);
      const suc = cuerpo<Deposito>(
        await http()
          .post('/warehouses')
          .set(e.headers)
          .send({ name: 'S', code: 'S' })
          .expect(201),
      );
      await http()
        .patch(`/warehouses/${suc.warehouseId}`)
        .set(e.headers)
        .send({ isActive: false })
        .expect(200);
      const hacia = await http()
        .post('/stock/transfers')
        .set(e.headers)
        .send({
          from: { warehouseId: e.warehouseId },
          to: { warehouseId: suc.warehouseId },
          items: [{ gasCylinderId: g.gasCylinderId, quantity: 1 }],
        })
        .expect(400);
      expect(cuerpo<Mensaje>(hacia).message).toMatch(
        /inactivo: no recibe stock/,
      );
    });
  });

  describe('concurrencia sobre el mismo saldo', () => {
    it('conteo inicial y ajuste simultáneos sobre el mismo depósito: sin deadlock ni reintentos', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      mockReintentos.n = 0;
      // Cada depósito admite un solo conteo inicial: una ronda por depósito.
      const rondas = await Promise.all(
        Array.from({ length: 12 }, async (_, i) => {
          const res = await http()
            .post('/warehouses')
            .set(e.headers)
            .send({ name: `Depósito ${i}`, code: `D${i}` })
            .expect(201);
          return cuerpo<Deposito>(res);
        }),
      );
      const respuestas = await Promise.all(
        rondas.flatMap((d) => [
          http()
            .post('/stock/initial-counts')
            .set(e.headers)
            .send({
              warehouseId: d.warehouseId,
              items: [{ gasCylinderId: g.gasCylinderId, full: 5, empty: 0 }],
            }),
          ajuste(e.headers, { warehouseId: d.warehouseId }, g, 'found', 1),
        ]),
      );
      expect(respuestas.map((r) => r.status)).toEqual(
        Array.from({ length: 24 }, () => 201),
      );
      expect(mockReintentos.n).toBe(0);
    }, 90000);

    it('dos ajustes simultáneos que juntos no entran: uno gana, el otro es 400, nunca negativo', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);

      const respuestas = await Promise.all([
        ajuste(e.headers, e, g, 'shrinkage', -7, 'primero'),
        ajuste(e.headers, e, g, 'shrinkage', -7, 'segundo'),
      ]);

      expect(respuestas.map((r) => r.status).sort()).toEqual([201, 400]);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(3);
      expect(await vendible(g.gasCylinderId)).toBe(3);
      const [{ n }] = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM stock_movement WHERE reason = 'shrinkage'`,
      );
      expect(Number(n)).toBe(1);
      // Los números de documento no tienen huecos ni repetidos.
      const numeros = await ds.query<Array<{ number: number }>>(
        `SELECT number FROM stock_adjustment ORDER BY number`,
      );
      expect(numeros.map((x) => x.number)).toEqual([1, 2]);
    }, 30000);

    it('dos mermas simultáneas de vacías (no toman el lock del vendible) no dejan el saldo negativo: la serializa el lock del saldo', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10, 10).expect(201);

      const respuestas = await Promise.all([
        ajuste(e.headers, e, g, 'shrinkage', -7, 'primera', 'empty'),
        ajuste(e.headers, e, g, 'shrinkage', -7, 'segunda', 'empty'),
      ]);

      expect(respuestas.map((r) => r.status).sort()).toEqual([201, 400]);
      expect(
        cuerpo<Mensaje>(respuestas.find((r) => r.status === 400)!).message,
      ).toMatch(/Stock insuficiente/);
      expect(await saldo(e.locationId, g.gasCylinderId, 'empty')).toBe(3);
      expect(await vendible(g.gasCylinderId)).toBe(10);
    }, 30000);

    it('cinco transferencias simultáneas de 3 desde el mismo origen con 10: exactamente tres entran', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);
      const suc = await http()
        .post('/warehouses')
        .set(e.headers)
        .send({ name: 'Sucursal', code: 'SUC' })
        .expect(201);

      const respuestas = await Promise.all(
        Array.from({ length: 5 }, () =>
          http()
            .post('/stock/transfers')
            .set(e.headers)
            .send({
              from: { warehouseId: e.warehouseId },
              to: { warehouseId: cuerpo<Deposito>(suc).warehouseId },
              items: [{ gasCylinderId: g.gasCylinderId, quantity: 3 }],
            }),
        ),
      );

      expect(respuestas.filter((r) => r.status === 201)).toHaveLength(3);
      expect(respuestas.filter((r) => r.status === 400)).toHaveLength(2);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(1);
      expect(
        await saldo(cuerpo<Deposito>(suc).locationId, g.gasCylinderId),
      ).toBe(9);
    }, 30000);

    it('diez ajustes simultáneos de 2 sobre 10 llenas: exactamente cinco entran', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);

      const respuestas = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          ajuste(e.headers, e, g, 'lost', -2, `pérdida ${i}`),
        ),
      );

      expect(respuestas.filter((r) => r.status === 201)).toHaveLength(5);
      expect(respuestas.filter((r) => r.status === 400)).toHaveLength(5);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(0);
      expect(await vendible(g.gasCylinderId)).toBe(0);
    }, 60000);

    it('transferencias cruzadas A→B y B→A al mismo tiempo no se traban (orden de locks)', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 50).expect(201);
      const suc = await http()
        .post('/warehouses')
        .set(e.headers)
        .send({ name: 'Sucursal', code: 'SUC' })
        .expect(201);
      await http()
        .post('/stock/transfers')
        .set(e.headers)
        .send({
          from: { warehouseId: e.warehouseId },
          to: { warehouseId: cuerpo<Deposito>(suc).warehouseId },
          items: [{ gasCylinderId: g.gasCylinderId, quantity: 25 }],
        })
        .expect(201);

      const ida = (n: number) =>
        http()
          .post('/stock/transfers')
          .set(e.headers)
          .send({
            from: { warehouseId: e.warehouseId },
            to: { warehouseId: cuerpo<Deposito>(suc).warehouseId },
            items: [{ gasCylinderId: g.gasCylinderId, quantity: n }],
          });
      const vuelta = (n: number) =>
        http()
          .post('/stock/transfers')
          .set(e.headers)
          .send({
            from: { warehouseId: cuerpo<Deposito>(suc).warehouseId },
            to: { warehouseId: e.warehouseId },
            items: [{ gasCylinderId: g.gasCylinderId, quantity: n }],
          });
      const respuestas = await Promise.all([
        ida(1),
        vuelta(1),
        ida(2),
        vuelta(2),
        ida(3),
        vuelta(3),
        ida(1),
        vuelta(1),
      ]);

      expect(respuestas.map((r) => r.status)).toEqual(Array(8).fill(201));
      expect(
        (await saldo(e.locationId, g.gasCylinderId)) +
          (await saldo(cuerpo<Deposito>(suc).locationId, g.gasCylinderId)),
      ).toBe(50);
      expect(await vendible(g.gasCylinderId)).toBe(50);
      const [{ idle }] = await ds.query<Array<{ idle: string }>>(
        `SELECT COUNT(*) AS idle FROM pg_stat_activity WHERE state = 'idle in transaction'`,
      );
      expect(Number(idle)).toBe(0);
    }, 60000);

    it('ajustes y pedidos que reservan el mismo producto a la vez no dejan el vendible negativo', async () => {
      const e = await seedDistribuidora();
      const g = await seedGarrafa(e.distributorId);
      await conteoInicial(e, g, 10).expect(201);
      const reservar = () =>
        ds.transaction(async (m) => {
          const [fila] = await m.query<Array<{ stock: number }>>(
            `SELECT stock FROM gas_cylinder WHERE gas_cylinder_id = $1 FOR UPDATE`,
            [g.gasCylinderId],
          );
          if (fila.stock < 1) return false;
          await m.query(
            `UPDATE gas_cylinder SET stock = stock - 1 WHERE gas_cylinder_id = $1`,
            [g.gasCylinderId],
          );
          return true;
        });
      const [r1, r2] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, reservar)),
        Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            ajuste(e.headers, e, g, 'lost', -1, `p${i}`),
          ),
        ),
      ]);
      const reservadas = r1.filter(Boolean).length;
      const perdidas = r2.filter((r) => r.status === 201).length;
      expect(await vendible(g.gasCylinderId)).toBe(10 - reservadas - perdidas);
      expect(await vendible(g.gasCylinderId)).toBeGreaterThanOrEqual(0);
      expect(await saldo(e.locationId, g.gasCylinderId)).toBe(10 - perdidas);
    }, 60000);
  });
});
