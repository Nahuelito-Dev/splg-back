/**
 * Carga y rendición del camión (M-C parte 3) contra la API con Postgres y Redis
 * reales: la jornada completa (abrir, cargar, salir, reponer, entregar, volver,
 * rendir con y sin diferencia), la conciliación del vendible en cada paso, los
 * únicos de carga abierta, el control D5 del despacho, el alcance por rol y por
 * distribuidora, y la concurrencia (aperturas simultáneas, entrega mientras se
 * rinde) sin deadlocks.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { codigoSqlDelError } from '../../src/common/errors/db-exceptions';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  truncateAllTables,
} from './setup/test-env';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Car } from '../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { RoleType } from '../../src/common/constants/role-type.enum';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { UpdateOrderStatusUseCase } from '../../src/order/application/update-order-status.use-case';
import { CashCollectionUseCase } from '../../src/order/application/cash-collection.use-case';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { OrderItem } from '../../src/order/entities/order-item.entity';
import { Role } from '../../src/role/entities/role.entity';
import { WarehouseService } from '../../src/stock/application/warehouse.service';
import { StockLocationService } from '../../src/stock/application/stock-location.service';
import { StockLedgerPort } from '../../src/stock/domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../src/stock/domain/stock.enums';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { User } from '../../src/users/entities/user.entity';

type Headers = Record<string, string>;

/** Cuenta los deadlocks que `withTransactionRetry` reintenta en silencio. */
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

interface Renglon {
  gasCylinderId: string;
  loadedFull: number;
  reloadedFull: number;
  loadedEmpty: number;
  deliveredFull: number;
  collectedEmpty: number;
  expectedFull: number;
  expectedEmpty: number;
  declaredReturnFull: number | null;
  declaredReturnEmpty: number | null;
  differenceFull: number | null;
  differenceEmpty: number | null;
  onTruckFull: number;
  onTruckEmpty: number;
}
interface Carga {
  loadId: string;
  number: number;
  status: string;
  carId: string;
  deliveryId: string;
  items: Renglon[];
  orders: Array<{ orderId: string }>;
  cash: {
    deliveredOrders: number;
    cashCollectedAmount: number;
    cashCollectedCount: number;
    unpaidAmount: number;
    unpaidCount: number;
    pendingConfirmationAmount: number;
    nonCashAmount: number;
  };
  movements: Array<{ reason: string; quantity: number }>;
  differenceNote: string | null;
}
interface Mensaje {
  message: string;
}

describe('Carga y rendición del camión (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let seq = 0;

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

  const http = () => request(env.app.getHttpServer());

  async function rol(type: string): Promise<Role> {
    const roles = ds.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function seedDistribuidora() {
    seq += 1;
    const sufijo = `${seq}-${randomUUID().slice(0, 6)}`;
    const dist = (await ds.getRepository(Distributor).save({
      name: `Dist ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
    const deposito = await env.app
      .get(WarehouseService)
      .asegurarPredeterminado(dist.distributorId);
    const email = `admin.${sufijo}@splg.local`;
    const admin = (await ds.getRepository(User).save({
      email,
      fullName: 'Admin Test',
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol('admin')).roleId,
    } as Partial<User>)) as User;
    await ds.getRepository(Admin).save({
      userId: admin.userId,
      distributorId: dist.distributorId,
    } as Partial<Admin>);
    const garrafa = (await ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      weight: 10,
      stock: 0,
      isActive: true,
      distributorId: dist.distributorId,
    } as Partial<GasCylinder>)) as GasCylinder;
    return {
      distributorId: dist.distributorId,
      warehouseId: deposito.warehouse.warehouseId,
      locationId: deposito.locationId,
      garrafa,
      adminUserId: admin.userId,
      headers: {
        Authorization: `Bearer ${email}`,
        'X-Client-Source': 'panel-app',
      } as Headers,
    };
  }
  type Entorno = Awaited<ReturnType<typeof seedDistribuidora>>;

  /** Un chofer con su vehículo en uso. */
  async function seedChofer(e: Entorno, ponerEnUso = true) {
    seq += 1;
    const sufijo = `${seq}-${randomUUID().slice(0, 6)}`;
    const email = `chofer.${sufijo}@splg.local`;
    const user = (await ds.getRepository(User).save({
      email,
      fullName: `Chofer ${seq}`,
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol('delivery')).roleId,
    } as Partial<User>)) as User;
    const delivery = (await ds.getRepository(Delivery).save({
      userId: user.userId,
      distributorId: e.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>)) as Delivery;
    const auto = (await ds.getRepository(Car).save({
      distributorId: e.distributorId,
      userId: user.userId,
      carPatent: `C${seq}${randomUUID().slice(0, 4).toUpperCase()}`,
    } as Partial<Car>)) as Car;
    if (ponerEnUso) {
      await ds.getRepository(VehicleAssignment).save({
        distributorId: e.distributorId,
        carId: auto.carId,
        deliveryId: delivery.deliveryId,
        assignedAt: new Date(),
      } as Partial<VehicleAssignment>);
    }
    return {
      userId: user.userId,
      deliveryId: delivery.deliveryId,
      carId: auto.carId,
      headers: {
        Authorization: `Bearer ${email}`,
        'X-Client-Source': 'driver-app',
      } as Headers,
    };
  }
  type Chofer = Awaited<ReturnType<typeof seedChofer>>;

  /** Deja físico en el depósito por el libro; las llenas suben el vendible. */
  const stockInicial = (e: Entorno, llenas: number, vacias = 0) =>
    ds.transaction(async (manager) => {
      const ledger = env.app.get(StockLedgerPort);
      const base = {
        distributorId: e.distributorId,
        referenceType: StockReferenceType.INITIAL,
        referenceId: null,
        actorUserId: null,
      };
      await ledger.aplicar(manager, {
        ...base,
        movimientos: [
          {
            gasCylinderId: e.garrafa.gasCylinderId,
            quantity: llenas,
            from: null,
            to: { locationId: e.locationId, condition: StockCondition.FULL },
            reason: StockMovementReason.INITIAL_COUNT,
          },
        ],
      });
      if (vacias > 0) {
        await ledger.aplicar(manager, {
          ...base,
          vendible: 'sin-cambio',
          movimientos: [
            {
              gasCylinderId: e.garrafa.gasCylinderId,
              quantity: vacias,
              from: null,
              to: { locationId: e.locationId, condition: StockCondition.EMPTY },
              reason: StockMovementReason.INITIAL_COUNT,
            },
          ],
        });
      }
    });

  /** Un pedido en camino del chofer, ya reservado (baja el vendible). */
  async function pedido(
    e: Entorno,
    c: Chofer,
    cantidad: number,
    metodo = PaymentMethod.CASH,
  ) {
    seq += 1;
    const sufijo = `${seq}-${randomUUID().slice(0, 6)}`;
    const cliente = (await ds.getRepository(User).save({
      email: `cliente-${sufijo}@splg.local`,
      fullName: 'Cliente',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    await ds.getRepository(Customer).save({
      userId: cliente.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    const dir = (await ds.getRepository(UserAddress).save({
      userId: cliente.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;
    const o = (await ds.getRepository(Order).save({
      customerId: cliente.userId,
      distributorId: e.distributorId,
      addressId: dir.addressId,
      status: OrderStatus.ON_THE_WAY,
      paymentMethod: metodo,
      totalAmount: 1000 * cantidad,
      subtotalItems: 1000 * cantidad,
      deliveryId: c.deliveryId,
      vehicleCarId: c.carId,
      acceptedAt: new Date(),
      onTheWayAt: new Date(),
    } as Partial<Order>)) as Order;
    await ds.getRepository(OrderItem).save({
      orderId: o.orderId,
      gasCylinderId: e.garrafa.gasCylinderId,
      quantity: cantidad,
      unitPrice: 1000,
      subtotal: 1000 * cantidad,
    } as Partial<OrderItem>);
    await ds.query(
      `UPDATE gas_cylinder SET stock = stock - $1 WHERE gas_cylinder_id = $2`,
      [cantidad, e.garrafa.gasCylinderId],
    );
    return o;
  }

  const entregar = (orderId: string) =>
    env.app
      .get(UpdateOrderStatusUseCase)
      .execute(
        orderId,
        OrderStatus.DELIVERED,
        undefined,
        RoleType.ADMIN,
        'admin-1',
      );

  const saldo = async (locationId: string, g: string, condition: string) => {
    const [f] = await ds.query<Array<{ quantity: number }>>(
      `SELECT quantity FROM stock_balance WHERE location_id = $1 AND gas_cylinder_id = $2 AND condition = $3`,
      [locationId, g, condition],
    );
    return f?.quantity ?? 0;
  };
  const ubicacionDelCamion = async (carId: string) => {
    const [f] = await ds.query<Array<{ location_id: string }>>(
      `SELECT location_id FROM stock_location WHERE car_id = $1`,
      [carId],
    );
    return f?.location_id ?? null;
  };
  const enElCamion = async (carId: string, g: string, condition: string) => {
    const loc = await ubicacionDelCamion(carId);
    return loc ? saldo(loc, g, condition) : 0;
  };
  const vendible = async (id: string) =>
    (await ds.getRepository(GasCylinder).findOneByOrFail({ gasCylinderId: id }))
      .stock;
  /**
   * Sesiones `idle in transaction`. La auditoría corre después de la respuesta
   * y abre su propia transacción un instante, así que se espera a que se
   * calmen: una fuga de verdad no se va sola y el conteo no baja de cero.
   */
  const colgadas = async () => {
    let n = 0;
    for (let intento = 0; intento < 20; intento += 1) {
      const [{ cuenta }] = await ds.query<Array<{ cuenta: string }>>(
        `SELECT COUNT(*) AS cuenta FROM pg_stat_activity WHERE state = 'idle in transaction'`,
      );
      n = Number(cuenta);
      if (n === 0) return 0;
      await new Promise((r) => setTimeout(r, 150));
    }
    return n;
  };
  const conciliado = async (e: Entorno) => {
    const res = await http()
      .get('/stock/reconciliation')
      .set(e.headers)
      .expect(200);
    const r = cuerpo<{ consistent: boolean }>(res);
    expect(r.consistent).toBe(true);
  };

  const abrir = (
    e: Entorno,
    c: Chofer,
    items: Array<{ loadedFull: number; loadedEmpty?: number }>,
    extra: Record<string, unknown> = {},
  ) =>
    http()
      .post('/truck-loads')
      .set(e.headers)
      .send({
        carId: c.carId,
        deliveryId: c.deliveryId,
        items: items.map((i) => ({
          gasCylinderId: e.garrafa.gasCylinderId,
          ...i,
        })),
        ...extra,
      });
  const abrirOk = async (
    e: Entorno,
    c: Chofer,
    items: Array<{ loadedFull: number; loadedEmpty?: number }>,
  ) => cuerpo<Carga>(await abrir(e, c, items).expect(201));
  const accion = (
    e: Entorno,
    id: string,
    nombre: string,
    body: Record<string, unknown> = {},
    headers: Headers = e.headers,
  ) => {
    const req = http().patch(`/truck-loads/${id}/${nombre}`).set(headers);
    // La reposición exige la clave: sumar dos veces no es idempotente.
    if (nombre === 'reload') req.set('Idempotency-Key', randomUUID());
    return req.send(body);
  };
  const detalle = async (e: Entorno, id: string) =>
    cuerpo<Carga>(
      await http().get(`/truck-loads/${id}`).set(e.headers).expect(200),
    );
  const declarar = (full: number, empty: number, e: Entorno) => ({
    items: [
      {
        gasCylinderId: e.garrafa.gasCylinderId,
        declaredFull: full,
        declaredEmpty: empty,
      },
    ],
  });

  describe('jornada completa sin diferencia', () => {
    it('abrir -> cargar -> salir -> reponer -> entregar 2 pedidos -> volver -> rendir, conciliado en cada paso', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 100, 20);
      const p1 = await pedido(e, c, 3);
      const p2 = await pedido(e, c, 2);
      await conciliado(e);
      expect(await vendible(g)).toBe(95);

      // abrir: numerada, en carga, sin mover stock
      const abierta = await abrirOk(e, c, [
        { loadedFull: 40, loadedEmpty: 10 },
      ]);
      expect(abierta).toMatchObject({ number: 1, status: 'loading' });
      expect(await saldo(e.locationId, g, 'full')).toBe(100);
      expect(await enElCamion(c.carId, g, 'full')).toBe(0);
      await conciliado(e);

      // salir: depósito -> camión; el vendible no cambia
      const enRuta = cuerpo<Carga>(
        await accion(e, abierta.loadId, 'depart').expect(200),
      );
      expect(enRuta.status).toBe('on_route');
      expect(await saldo(e.locationId, g, 'full')).toBe(60);
      expect(await saldo(e.locationId, g, 'empty')).toBe(10);
      expect(await enElCamion(c.carId, g, 'full')).toBe(40);
      expect(await enElCamion(c.carId, g, 'empty')).toBe(10);
      expect(await vendible(g)).toBe(95);
      await conciliado(e);

      // reposición en ruta
      const repuesta = cuerpo<Carga>(
        await accion(e, abierta.loadId, 'reload', {
          items: [{ gasCylinderId: g, quantity: 10 }],
        }).expect(200),
      );
      expect(repuesta.items[0]).toMatchObject({
        loadedFull: 40,
        reloadedFull: 10,
        onTruckFull: 50,
      });
      expect(await saldo(e.locationId, g, 'full')).toBe(50);
      await conciliado(e);

      // dos entregas: salen del camión y entran las vacías de canje
      await entregar(p1.orderId);
      await entregar(p2.orderId);
      expect(await enElCamion(c.carId, g, 'full')).toBe(45);
      expect(await enElCamion(c.carId, g, 'empty')).toBe(15);
      const durante = await detalle(e, abierta.loadId);
      expect(durante.items[0]).toMatchObject({
        deliveredFull: 5,
        collectedEmpty: 5,
        expectedFull: 45,
        expectedEmpty: 15,
        declaredReturnFull: null,
        differenceFull: null,
      });
      expect(durante.orders.map((o) => o.orderId).sort()).toEqual(
        [p1.orderId, p2.orderId].sort(),
      );
      await conciliado(e);

      // el chofer confirma el cobro de uno; el otro queda sin confirmar
      await env.app
        .get(CashCollectionUseCase)
        .confirmReceived(p1.orderId, c.userId);
      const conCobro = await detalle(e, abierta.loadId);
      expect(conCobro.cash).toMatchObject({
        deliveredOrders: 2,
        cashCollectedAmount: 3000,
        cashCollectedCount: 1,
        pendingConfirmationAmount: 2000,
        unpaidAmount: 0,
      });

      // vuelta: declara lo esperado; la diferencia es cero y todavía no se movió nada
      const devuelta = cuerpo<Carga>(
        await accion(
          e,
          abierta.loadId,
          'return',
          declarar(45, 15, e),
          c.headers,
        ).expect(200),
      );
      expect(devuelta.status).toBe('returned');
      expect(devuelta.items[0]).toMatchObject({
        differenceFull: 0,
        differenceEmpty: 0,
      });
      expect(await enElCamion(c.carId, g, 'full')).toBe(45);

      // rendición
      const cerrada = cuerpo<Carga>(
        await accion(e, abierta.loadId, 'close').expect(200),
      );
      expect(cerrada.status).toBe('closed');
      expect(cerrada.differenceNote).toBeNull();
      expect(cerrada.items[0]).toMatchObject({
        deliveredFull: 5,
        collectedEmpty: 5,
        expectedFull: 45,
        expectedEmpty: 15,
        declaredReturnFull: 45,
        differenceFull: 0,
        onTruckFull: 0,
        onTruckEmpty: 0,
      });
      expect(await enElCamion(c.carId, g, 'full')).toBe(0);
      expect(await enElCamion(c.carId, g, 'empty')).toBe(0);
      expect(await saldo(e.locationId, g, 'full')).toBe(95);
      expect(await saldo(e.locationId, g, 'empty')).toBe(25);
      expect(await vendible(g)).toBe(95);
      expect(cerrada.movements.map((m) => m.reason)).toEqual(
        expect.arrayContaining(['truck_load', 'truck_return']),
      );
      expect(cerrada.movements.some((m) => m.reason === 'shrinkage')).toBe(
        false,
      );
      await conciliado(e);

      // libera al camión y al chofer: se puede abrir otra carga
      await abrir(e, c, [{ loadedFull: 1 }]).expect(201);
      expect(mockReintentos.n).toBe(0);
      expect(await colgadas()).toBe(0);
    }, 60000);
  });

  describe('lo cobrado de la jornada', () => {
    it('cuenta sólo lo `paid`, sea cual sea el medio: una transferencia pendiente no es cobrada', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      await stockInicial(e, 50, 10);
      const o = await pedido(e, c, 1, PaymentMethod.TRANSFER);
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);
      await accion(e, carga.loadId, 'depart').expect(200);
      await entregar(o.orderId);

      const pendiente = await detalle(e, carga.loadId);
      expect(pendiente.cash).toMatchObject({
        deliveredOrders: 1,
        nonCashAmount: 0,
        cashCollectedAmount: 0,
      });

      await ds.query(
        `UPDATE "order" SET "paymentStatus" = 'paid' WHERE order_id = $1`,
        [o.orderId],
      );
      expect((await detalle(e, carga.loadId)).cash.nonCashAmount).toBe(1000);
    }, 60000);
  });

  describe('rendición con diferencia', () => {
    async function jornada(e: Entorno, c: Chofer, entregadas: number) {
      await stockInicial(e, 50, 10);
      const o = await pedido(e, c, entregadas);
      const carga = await abrirOk(e, c, [{ loadedFull: 20, loadedEmpty: 4 }]);
      await accion(e, carga.loadId, 'depart').expect(200);
      await entregar(o.orderId);
      return carga;
    }

    it('faltan garrafas: sin nota es 400 y no mueve nada; con nota queda closed_with_difference y baja el vendible', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      const carga = await jornada(e, c, 5);
      // esperado: llenas 20-5=15, vacías 4+5=9. Vuelven 12 llenas y 8 vacías.
      await accion(e, carga.loadId, 'return', declarar(12, 8, e)).expect(200);
      const previo = await detalle(e, carga.loadId);
      expect(previo.items[0]).toMatchObject({
        differenceFull: -3,
        differenceEmpty: -1,
      });
      const vendibleAntes = await vendible(g);

      const sinNota = await accion(e, carga.loadId, 'close').expect(400);
      expect(cuerpo<Mensaje>(sinNota).message).toMatch(/nota de la diferencia/);
      expect(await enElCamion(c.carId, g, 'full')).toBe(15);
      expect(await vendible(g)).toBe(vendibleAntes);
      expect((await detalle(e, carga.loadId)).status).toBe('returned');

      const cerrada = cuerpo<Carga>(
        await accion(e, carga.loadId, 'close', {
          differenceNote: 'Se rompieron 3 y se perdió 1 vacía',
        }).expect(200),
      );
      expect(cerrada.status).toBe('closed_with_difference');
      expect(cerrada.differenceNote).toBe('Se rompieron 3 y se perdió 1 vacía');
      expect(cerrada.items[0]).toMatchObject({
        differenceFull: -3,
        differenceEmpty: -1,
      });
      expect(await enElCamion(c.carId, g, 'full')).toBe(0);
      expect(await enElCamion(c.carId, g, 'empty')).toBe(0);
      // depósito: 50-20 = 30 + 12 vuelven; vacías 10-4 = 6 + 8
      expect(await saldo(e.locationId, g, 'full')).toBe(42);
      expect(await saldo(e.locationId, g, 'empty')).toBe(14);
      expect(await vendible(g)).toBe(vendibleAntes - 3);
      const merma = cerrada.movements.filter((m) => m.reason === 'shrinkage');
      expect(merma.map((m) => m.quantity).sort()).toEqual([1, 3]);
      await conciliado(e);
    }, 60000);

    it('sobran garrafas: entra como ajuste, sube el vendible y también exige nota', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      const carga = await jornada(e, c, 5);
      const vendibleAntes = await vendible(g);
      await accion(e, carga.loadId, 'return', declarar(17, 9, e)).expect(200);

      await accion(e, carga.loadId, 'close').expect(400);
      const cerrada = cuerpo<Carga>(
        await accion(e, carga.loadId, 'close', {
          differenceNote: 'Una devolución de otro cliente',
        }).expect(200),
      );

      expect(cerrada.status).toBe('closed_with_difference');
      expect(cerrada.items[0]).toMatchObject({
        differenceFull: 2,
        differenceEmpty: 0,
      });
      expect(await saldo(e.locationId, g, 'full')).toBe(30 + 17);
      expect(await vendible(g)).toBe(vendibleAntes + 2);
      expect(
        cerrada.movements.some(
          (m) => m.reason === 'adjustment' && m.quantity === 2,
        ),
      ).toBe(true);
      await conciliado(e);
    }, 60000);

    it('con pedidos en curso no se declara la vuelta (409); entregados, sí', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      await stockInicial(e, 50, 10);
      const o = await pedido(e, c, 2);
      const carga = await abrirOk(e, c, [{ loadedFull: 20 }]);
      await accion(e, carga.loadId, 'depart').expect(200);

      const res = await accion(
        e,
        carga.loadId,
        'return',
        declarar(20, 0, e),
        c.headers,
      ).expect(409);
      expect(cuerpo<Mensaje>(res).message).toBe(
        'Tenés 1 pedido en curso: entregalos o liberalos antes de volver',
      );
      expect((await detalle(e, carga.loadId)).status).toBe('on_route');

      await entregar(o.orderId);
      await accion(
        e,
        carga.loadId,
        'return',
        declarar(18, 2, e),
        c.headers,
      ).expect(200);
    }, 60000);

    it('declarar de nuevo corrige la vuelta mientras no se cerró; una carga cerrada no se declara', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const carga = await jornada(e, c, 5);
      await accion(e, carga.loadId, 'return', declarar(10, 9, e)).expect(200);
      await accion(e, carga.loadId, 'return', declarar(15, 9, e)).expect(200);
      await accion(e, carga.loadId, 'close').expect(200);

      await accion(e, carga.loadId, 'return', declarar(15, 9, e)).expect(400);
      await accion(e, carga.loadId, 'close').expect(400);
    }, 60000);

    it('la declaración tiene que cubrir todas las garrafas de la carga', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const carga = await jornada(e, c, 1);
      const otra = await ds.getRepository(GasCylinder).save({
        type: '45kg',
        price: 5000,
        weight: 45,
        stock: 0,
        isActive: true,
        distributorId: e.distributorId,
      } as Partial<GasCylinder>);

      const ajena = await accion(e, carga.loadId, 'return', {
        items: [
          {
            gasCylinderId: otra.gasCylinderId,
            declaredFull: 1,
            declaredEmpty: 0,
          },
        ],
      }).expect(400);
      expect(cuerpo<Mensaje>(ajena).message).toMatch(/no es de esta carga/);
      await accion(e, carga.loadId, 'return', { items: [] }).expect(400);
    }, 60000);
  });

  describe('abrir, editar y cancelar', () => {
    it('un camión y un chofer tienen una sola carga abierta; cancelar la libera', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      await stockInicial(e, 50);
      const primera = await abrirOk(e, c, [{ loadedFull: 10 }]);

      const repetida = await abrir(e, c, [{ loadedFull: 5 }]).expect(409);
      expect(cuerpo<Mensaje>(repetida).message).toMatch(
        /ya tiene abierta la carga N° 1/,
      );

      await accion(e, primera.loadId, 'cancel', { reason: 'No salió' }).expect(
        200,
      );
      const nueva = await abrirOk(e, c, [{ loadedFull: 5 }]);
      expect(nueva.number).toBe(2);
      expect(await saldo(e.locationId, e.garrafa.gasCylinderId, 'full')).toBe(
        50,
      );
    }, 60000);

    it('un camión que no está en uso por el chofer no abre carga', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e, false);
      const res = await abrir(e, c, [{ loadedFull: 5 }]).expect(400);
      expect(cuerpo<Mensaje>(res).message).toMatch(
        /no está en uso por ese chofer/,
      );
    });

    it('los renglones se editan sólo antes de salir; sin motivo no se cancela; en ruta no se cancela', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 50);
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);

      const editada = cuerpo<Carga>(
        await http()
          .put(`/truck-loads/${carga.loadId}/items`)
          .set(e.headers)
          .send({ items: [{ gasCylinderId: g, loadedFull: 25 }] })
          .expect(200),
      );
      expect(editada.items[0].loadedFull).toBe(25);
      await accion(e, carga.loadId, 'cancel', {}).expect(400);

      await accion(e, carga.loadId, 'depart').expect(200);
      expect(await saldo(e.locationId, g, 'full')).toBe(25);
      await http()
        .put(`/truck-loads/${carga.loadId}/items`)
        .set(e.headers)
        .send({ items: [{ gasCylinderId: g, loadedFull: 1 }] })
        .expect(400);
      await accion(e, carga.loadId, 'cancel', { reason: 'tarde' }).expect(400);
      await accion(e, carga.loadId, 'depart').expect(400);
    }, 60000);

    it('sin llenas suficientes en el depósito no sale y no se escribe nada', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 5);
      const carga = await abrirOk(e, c, [{ loadedFull: 30 }]);

      const res = await accion(e, carga.loadId, 'depart').expect(400);

      expect(cuerpo<Mensaje>(res).message).toMatch(/Stock insuficiente/);
      expect((await detalle(e, carga.loadId)).status).toBe('loading');
      expect(await saldo(e.locationId, g, 'full')).toBe(5);
      expect(await enElCamion(c.carId, g, 'full')).toBe(0);
    }, 60000);

    it('el camión se carga sólo desde la carga: no se transfiere a un vehículo, y lo suelto se regulariza sin carga abierta y con nota', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 50);
      const transferir = (from: object, to: object, notes?: string) =>
        http()
          .post('/stock/transfers')
          .set(e.headers)
          .send({
            from,
            to,
            items: [{ gasCylinderId: g, quantity: 3 }],
            notes,
          });

      // a mano, al camión: no
      const aMano = await transferir(
        { warehouseId: e.warehouseId },
        { carId: c.carId },
      ).expect(400);
      expect(cuerpo<Mensaje>(aMano).message).toMatch(
        /El camión se carga y se rinde desde la carga del día/,
      );

      // stock suelto que quedó de antes (caso AB102CH)
      await ds.transaction(async (manager) => {
        const camion = await env.app
          .get(StockLocationService)
          .ubicacionDeVehiculo(manager, e.distributorId, c.carId);
        await env.app.get(StockLedgerPort).aplicar(manager, {
          distributorId: e.distributorId,
          referenceType: StockReferenceType.TRANSFER,
          referenceId: null,
          actorUserId: null,
          movimientos: [
            {
              gasCylinderId: g,
              quantity: 3,
              from: {
                locationId: e.locationId,
                condition: StockCondition.FULL,
              },
              to: {
                locationId: camion.locationId,
                condition: StockCondition.FULL,
              },
              reason: StockMovementReason.TRANSFER,
            },
          ],
        });
      });
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);
      const res = await accion(e, carga.loadId, 'depart').expect(400);
      expect(cuerpo<Mensaje>(res).message).toMatch(/todavía tiene garrafas/);

      // con una carga abierta, regularizar es 409: se rinde desde la carga
      const abierta = await transferir(
        { carId: c.carId },
        { warehouseId: e.warehouseId },
        'Regularización',
      ).expect(409);
      expect(cuerpo<Mensaje>(abierta).message).toMatch(/carga N° 1/);

      await accion(e, carga.loadId, 'cancel', {
        reason: 'Primero se regulariza',
      }).expect(200);
      await transferir(
        { carId: c.carId },
        { warehouseId: e.warehouseId },
      ).expect(400);
      await transferir(
        { carId: c.carId },
        { warehouseId: e.warehouseId },
        'Regularización del stock suelto del camión',
      ).expect(201);
      expect(await enElCamion(c.carId, g, 'full')).toBe(0);
      expect(await saldo(e.locationId, g, 'full')).toBe(50);

      const nueva = await abrirOk(e, c, [{ loadedFull: 10 }]);
      await accion(e, nueva.loadId, 'depart').expect(200);
      expect(await enElCamion(c.carId, g, 'full')).toBe(10);
    }, 60000);

    it('la reposición sólo vale en ruta y no pasa del stock del depósito', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 20);
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);

      await accion(e, carga.loadId, 'reload', {
        items: [{ gasCylinderId: g, quantity: 1 }],
      }).expect(400);
      await accion(e, carga.loadId, 'depart').expect(200);
      await accion(e, carga.loadId, 'reload', {
        items: [{ gasCylinderId: g, quantity: 50 }],
      }).expect(400);
      await accion(e, carga.loadId, 'reload', {
        items: [
          { gasCylinderId: g, quantity: 1 },
          { gasCylinderId: g, quantity: 2 },
        ],
      }).expect(400);
      expect(await saldo(e.locationId, g, 'full')).toBe(10);
    }, 60000);

    it('depart y close aceptan Idempotency-Key: la segunda llamada no vuelve a mover stock', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 30);
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);
      const key = randomUUID();

      await accion(e, carga.loadId, 'depart')
        .set('Idempotency-Key', key)
        .expect(200);
      await accion(e, carga.loadId, 'depart')
        .set('Idempotency-Key', key)
        .expect(200);

      expect(await saldo(e.locationId, g, 'full')).toBe(20);
      expect(await enElCamion(c.carId, g, 'full')).toBe(10);
    }, 60000);
  });

  describe('alcance por rol y por distribuidora', () => {
    it('el chofer sólo ve y confirma lo suyo; no abre, repone ni cierra; otra distribuidora no ve nada', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const otroChofer = await seedChofer(e);
      const ajena = await seedDistribuidora();
      await stockInicial(e, 50);
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);

      // lo ajeno es 404, lo prohibido por rol es 403
      await http()
        .get(`/truck-loads/${carga.loadId}`)
        .set(otroChofer.headers)
        .expect(404);
      await accion(e, carga.loadId, 'depart', {}, otroChofer.headers).expect(
        404,
      );
      await http()
        .get(`/truck-loads/${carga.loadId}`)
        .set(ajena.headers)
        .expect(404);
      await accion(ajena, carga.loadId, 'depart').expect(404);
      await accion(ajena, carga.loadId, 'close').expect(404);
      await http().post('/truck-loads').set(c.headers).send({}).expect(403);
      await http().get('/truck-loads').set(c.headers).expect(403);
      await accion(e, carga.loadId, 'close', {}, c.headers).expect(403);
      await accion(e, carga.loadId, 'reload', {}, c.headers).expect(403);

      // el chofer propio sí confirma la salida y ve su carga
      await accion(e, carga.loadId, 'depart', {}, c.headers).expect(200);
      await http()
        .get(`/truck-loads/${carga.loadId}`)
        .set(c.headers)
        .expect(200);

      // no se abre una carga con el camión de otra distribuidora
      const choferAjeno = await seedChofer(ajena);
      await http()
        .post('/truck-loads')
        .set(e.headers)
        .send({
          carId: choferAjeno.carId,
          deliveryId: choferAjeno.deliveryId,
          items: [{ gasCylinderId: e.garrafa.gasCylinderId, loadedFull: 1 }],
        })
        .expect(404);
    }, 60000);

    it('"mi carga" devuelve sólo la del chofer que pregunta y la política de la distribuidora', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const otro = await seedChofer(e);
      await stockInicial(e, 50);
      const sin = cuerpo<{ load: unknown; requireOpenTruckLoad: boolean }>(
        await http().get('/truck-loads/mine').set(c.headers).expect(200),
      );
      expect(sin).toEqual({ load: null, requireOpenTruckLoad: false });

      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);
      const mia = cuerpo<{ load: Carga }>(
        await http().get('/truck-loads/mine').set(c.headers).expect(200),
      );
      expect(mia.load.loadId).toBe(carga.loadId);
      const deOtro = cuerpo<{ load: unknown }>(
        await http().get('/truck-loads/mine').set(otro.headers).expect(200),
      );
      expect(deOtro.load).toBeNull();
      await http().get('/truck-loads/mine').set(e.headers).expect(403);
    }, 60000);

    it('consultas: listado por estado, fecha, camión y chofer; stock del camión', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const otro = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 80);
      const a = await abrirOk(e, c, [{ loadedFull: 10 }]);
      await accion(e, a.loadId, 'depart').expect(200);
      const b = cuerpo<Carga>(
        await abrir(e, otro, [{ loadedFull: 5 }], {
          businessDate: '2026-01-15',
        }).expect(201),
      );

      const lista = async (q: string) =>
        cuerpo<{ total: number; data: Array<{ loadId: string }> }>(
          await http().get(`/truck-loads${q}`).set(e.headers).expect(200),
        );
      expect((await lista('')).total).toBe(2);
      expect(
        (await lista('?status=on_route')).data.map((x) => x.loadId),
      ).toEqual([a.loadId]);
      expect(
        (await lista('?date=2026-01-15')).data.map((x) => x.loadId),
      ).toEqual([b.loadId]);
      expect((await lista(`?carId=${c.carId}`)).total).toBe(1);
      expect(
        (await lista(`?deliveryId=${otro.deliveryId}`)).data[0].loadId,
      ).toBe(b.loadId);
      expect((await lista('?from=2026-01-01&to=2026-01-31')).total).toBe(1);
      await http()
        .get('/truck-loads?status=cualquiera')
        .set(e.headers)
        .expect(400);
      await http()
        .get('/truck-loads?date=2026-13-45')
        .set(e.headers)
        .expect(400);

      const stock = cuerpo<{
        openLoadId: string;
        items: Array<{ gasCylinderId: string; full: number; empty: number }>;
      }>(
        await http()
          .get(`/truck-loads/cars/${c.carId}/stock`)
          .set(e.headers)
          .expect(200),
      );
      expect(stock.openLoadId).toBe(a.loadId);
      expect(stock.items).toEqual([
        expect.objectContaining({ gasCylinderId: g, full: 10, empty: 0 }),
      ]);
      await http()
        .get(`/truck-loads/cars/${randomUUID()}/stock`)
        .set(e.headers)
        .expect(404);
    }, 60000);
  });

  describe('D5: despacho sin carga', () => {
    it('por defecto el chofer sin carga acepta; con requireOpenTruckLoad=true no, y con carga abierta sí', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      await stockInicial(e, 50);
      const pendiente = async () => {
        const o = await pedido(e, c, 1);
        await ds.query(
          `UPDATE "order" SET status = 'pending', delivery_id = NULL, vehicle_car_id = NULL WHERE order_id = $1`,
          [o.orderId],
        );
        return o.orderId;
      };
      const aceptar = (orderId: string) =>
        env.app
          .get(UpdateOrderStatusUseCase)
          .execute(
            orderId,
            OrderStatus.ACCEPTED,
            c.deliveryId,
            RoleType.ADMIN,
            'admin-1',
          );

      // por defecto: acepta sin carga
      const defecto = await http()
        .get('/truck-loads/settings')
        .set(e.headers)
        .expect(200);
      expect(
        cuerpo<{ requireOpenTruckLoad: boolean }>(defecto).requireOpenTruckLoad,
      ).toBe(false);
      expect((await aceptar(await pendiente())).status).toBe(
        OrderStatus.ACCEPTED,
      );

      // exigida: sin carga abierta, no
      const activa = await http()
        .put('/truck-loads/settings')
        .set(e.headers)
        .send({ requireOpenTruckLoad: true })
        .expect(200);
      expect(
        cuerpo<{ requireOpenTruckLoad: boolean }>(activa).requireOpenTruckLoad,
      ).toBe(true);
      await expect(aceptar(await pendiente())).rejects.toThrow(
        /exige una carga de camión abierta/,
      );

      // la asignación manual del admin tampoco
      const manual = await pendiente();
      const rechazo = await http()
        .patch(`/orders/${manual}/assign/${c.deliveryId}`)
        .set(e.headers)
        .expect(400);
      expect(cuerpo<Mensaje>(rechazo).message).toBe(
        'El chofer no tiene la carga del día abierta',
      );

      // y el pool le llega vacío con el aviso para la app
      const pool = cuerpo<{
        orders: unknown[];
        openLoadRequired: boolean;
        message: string | null;
      }>(await http().get('/orders/available').set(c.headers).expect(200));
      expect(pool).toMatchObject({
        orders: [],
        openLoadRequired: true,
        message: 'Abrí tu carga para recibir pedidos',
      });

      // con la carga abierta pero sin salir, todavía no (en carga)
      const cargaD5 = await abrirOk(e, c, [{ loadedFull: 5 }]);
      await expect(aceptar(await pendiente())).rejects.toThrow(
        /todavía no salió/,
      );

      // con la carga en ruta, sí
      await accion(e, cargaD5.loadId, 'depart').expect(200);
      expect((await aceptar(await pendiente())).status).toBe(
        OrderStatus.ACCEPTED,
      );
      await http()
        .patch(`/orders/${manual}/assign/${c.deliveryId}`)
        .set(e.headers)
        .expect(200);
      const conCarga = cuerpo<{ orders: unknown[]; openLoadRequired: boolean }>(
        await http().get('/orders/available').set(c.headers).expect(200),
      );
      expect(conCarga.openLoadRequired).toBe(false);
      const mia = cuerpo<{ requireOpenTruckLoad: boolean }>(
        await http().get('/truck-loads/mine').set(c.headers).expect(200),
      );
      expect(mia.requireOpenTruckLoad).toBe(true);

      // desactivada de nuevo: otro chofer sin carga acepta
      await http()
        .put('/truck-loads/settings')
        .set(e.headers)
        .send({ requireOpenTruckLoad: false })
        .expect(200);
      await http()
        .put('/truck-loads/settings')
        .set(e.headers)
        .send({ requireOpenTruckLoad: 'si' })
        .expect(400);
      await http().get('/truck-loads/settings').set(c.headers).expect(403);
    }, 60000);

    it('el parámetro es de cada distribuidora', async () => {
      const a = await seedDistribuidora();
      const b = await seedDistribuidora();
      await http()
        .put('/truck-loads/settings')
        .set(a.headers)
        .send({ requireOpenTruckLoad: true })
        .expect(200);

      const deB = await http()
        .get('/truck-loads/settings')
        .set(b.headers)
        .expect(200);
      expect(
        cuerpo<{ requireOpenTruckLoad: boolean }>(deB).requireOpenTruckLoad,
      ).toBe(false);
    });
  });

  describe('entregas después de declarar la vuelta, cambio de vehículo y pedidos según el estado', () => {
    it('una entrega del camión después de declarar la vuelta no se cierra: 409, sin stock fantasma; se re-declara y cierra', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 50, 10);
      const carga = await abrirOk(e, c, [{ loadedFull: 20, loadedEmpty: 2 }]);
      await accion(e, carga.loadId, 'depart').expect(200);
      await accion(e, carga.loadId, 'return', declarar(20, 2, e)).expect(200);
      // se asienta una entrega que ya estaba en camino cuando declaró
      const tarde = await pedido(e, c, 2);
      await entregar(tarde.orderId);
      const vendibleAntes = await vendible(g);
      const fisicoAntes = await saldo(e.locationId, g, 'full');

      const res = await accion(e, carga.loadId, 'close', {
        differenceNote: 'x',
      }).expect(409);
      expect(cuerpo<Mensaje>(res).message).toMatch(
        /Se entregaron 2 garrafas del camión después de declarar la vuelta/,
      );
      expect((await detalle(e, carga.loadId)).status).toBe('returned');
      expect(await enElCamion(c.carId, g, 'full')).toBe(18);
      expect(await vendible(g)).toBe(vendibleAntes);
      expect(await saldo(e.locationId, g, 'full')).toBe(fisicoAntes);

      await accion(e, carga.loadId, 'return', declarar(18, 4, e)).expect(200);
      const cerrada = cuerpo<Carga>(
        await accion(e, carga.loadId, 'close').expect(200),
      );
      expect(cerrada.status).toBe('closed');
      expect(await enElCamion(c.carId, g, 'full')).toBe(0);
      // 50 llenas - 2 entregadas; el vendible no se infló
      expect(await saldo(e.locationId, g, 'full')).toBe(48);
      expect(await vendible(g)).toBe(vendibleAntes);
      await conciliado(e);
    }, 60000);

    it('con la carga devuelta o sin salir el chofer no recibe ni acepta pedidos, aunque D5 esté en false', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      await stockInicial(e, 50, 10);
      const pendiente = async () => {
        const o = await pedido(e, c, 1);
        await ds.query(
          `UPDATE "order" SET status = 'pending', delivery_id = NULL, vehicle_car_id = NULL WHERE order_id = $1`,
          [o.orderId],
        );
        return o.orderId;
      };
      const aceptar = (orderId: string) =>
        env.app
          .get(UpdateOrderStatusUseCase)
          .execute(
            orderId,
            OrderStatus.ACCEPTED,
            c.deliveryId,
            RoleType.ADMIN,
            'admin-1',
          );
      const pool = async () =>
        cuerpo<{ openLoadRequired: boolean; message: string | null }>(
          await http().get('/orders/available').set(c.headers).expect(200),
        );

      expect((await pool()).openLoadRequired).toBe(false); // sin carga y sin D5: como hoy
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);
      await expect(aceptar(await pendiente())).rejects.toThrow(
        /todavía no salió/,
      );
      expect(await pool()).toMatchObject({ openLoadRequired: true });

      await accion(e, carga.loadId, 'depart').expect(200);
      expect((await pool()).openLoadRequired).toBe(false);
      expect((await aceptar(await pendiente())).status).toBe(
        OrderStatus.ACCEPTED,
      );
      // (se lo da por entregado para poder volver)
      await ds.query(
        `UPDATE "order" SET status = 'delivered' WHERE delivery_id = $1`,
        [c.deliveryId],
      );

      await accion(
        e,
        carga.loadId,
        'return',
        declarar(10, 0, e),
        c.headers,
      ).expect(200);
      await expect(aceptar(await pendiente())).rejects.toThrow(/ya volvió/);
      const devuelta = await pool();
      expect(devuelta.openLoadRequired).toBe(true);
      expect(devuelta.message).toMatch(/ya volvió/);
    }, 60000);

    it('no se cambia ni se libera el vehículo del chofer mientras haya una carga abierta (409); cerrada, sí', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const otro = await seedChofer(e, false);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 50, 10);
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);
      await accion(e, carga.loadId, 'depart').expect(200);

      const cambiar = () =>
        http()
          .put(`/delivery/${c.deliveryId}/vehicle`)
          .set(e.headers)
          .send({ carId: otro.carId });
      const r1 = await cambiar().expect(409);
      expect(cuerpo<Mensaje>(r1).message).toMatch(
        /carga de camión abierta \(carga N° 1\)/,
      );
      await http()
        .delete(`/delivery/${c.deliveryId}/vehicle`)
        .set(e.headers)
        .expect(409);
      // tampoco se le saca el camión de la carga a otro chofer
      await http()
        .put(`/delivery/${otro.deliveryId}/vehicle`)
        .set(e.headers)
        .send({ carId: c.carId })
        .expect(409);
      expect(await enElCamion(c.carId, g, 'full')).toBe(10);

      await accion(e, carga.loadId, 'return', declarar(10, 0, e)).expect(200);
      await cambiar().expect(409); // devuelta también es abierta
      await accion(e, carga.loadId, 'close').expect(200);
      await cambiar().expect(200);
    }, 60000);

    it('las defectuosas del camión vuelven al depósito y el camión queda en cero en todas las condiciones', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 50, 10);
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);
      await accion(e, carga.loadId, 'depart').expect(200);
      // una se rompe en ruta: llena -> defectuosa en el camión
      await http()
        .post('/stock/adjustments')
        .set(e.headers)
        .send({
          location: { carId: c.carId },
          reason: 'damaged',
          notes: 'Se golpeó una en la ruta',
          items: [{ gasCylinderId: g, condition: 'full', quantityDelta: -1 }],
        })
        .expect(201);
      await accion(e, carga.loadId, 'return', declarar(9, 0, e)).expect(200);

      const cerrada = cuerpo<Carga>(
        await accion(e, carga.loadId, 'close', {
          differenceNote: 'Una llena se rompió en ruta',
        }).expect(200),
      );

      expect(cerrada.status).toBe('closed_with_difference');
      for (const condicion of ['full', 'empty', 'defective']) {
        expect(await enElCamion(c.carId, g, condicion)).toBe(0);
      }
      expect(await saldo(e.locationId, g, 'defective')).toBe(1);
      expect(await saldo(e.locationId, g, 'full')).toBe(49);
      await conciliado(e);
    }, 60000);

    it('la reposición exige Idempotency-Key (400 sin ella) y con la misma clave suma una sola vez', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 50);
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);
      await accion(e, carga.loadId, 'depart').expect(200);
      const cuerpoReload = { items: [{ gasCylinderId: g, quantity: 5 }] };

      const sin = await http()
        .patch(`/truck-loads/${carga.loadId}/reload`)
        .set(e.headers)
        .send(cuerpoReload)
        .expect(400);
      expect(cuerpo<Mensaje>(sin).message).toMatch(
        /exige el header Idempotency-Key/,
      );
      expect(await enElCamion(c.carId, g, 'full')).toBe(10);

      const clave = randomUUID();
      for (let i = 0; i < 2; i += 1) {
        await http()
          .patch(`/truck-loads/${carga.loadId}/reload`)
          .set(e.headers)
          .set('Idempotency-Key', clave)
          .send(cuerpoReload)
          .expect(200);
      }
      expect(await enElCamion(c.carId, g, 'full')).toBe(15);
    }, 60000);

    it('las entregas y el efectivo de la carga salen del mismo criterio: chofer + camión + ventana; otro vehículo no cuenta', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      await stockInicial(e, 50, 10);
      const propio = await pedido(e, c, 1);
      const ajeno = await pedido(e, c, 1);
      await ds.query(
        `UPDATE "order" SET vehicle_car_id = NULL WHERE order_id = $1`,
        [ajeno.orderId],
      );
      const carga = await abrirOk(e, c, [{ loadedFull: 10 }]);
      await accion(e, carga.loadId, 'depart').expect(200);
      await entregar(propio.orderId);
      await entregar(ajeno.orderId);

      const d = await detalle(e, carga.loadId);
      expect(d.orders.map((o) => o.orderId)).toEqual([propio.orderId]);
      expect(d.items[0].deliveredFull).toBe(1);
      expect(d.cash.deliveredOrders).toBe(1);
    }, 60000);
  });

  describe('concurrencia', () => {
    it('dos aperturas simultáneas del mismo camión: una sola, la otra 409, sin deadlocks', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      await stockInicial(e, 50);

      const resultados = await Promise.all(
        Array.from({ length: 6 }, () => abrir(e, c, [{ loadedFull: 5 }])),
      );

      const estados = resultados.map((r) => r.status).sort();
      expect(estados.filter((s) => s === 201)).toHaveLength(1);
      expect(estados.filter((s) => s === 409)).toHaveLength(5);
      const [{ n }] = await ds.query<Array<{ n: string }>>(
        `SELECT COUNT(*) AS n FROM truck_load WHERE car_id = $1`,
        [c.carId],
      );
      expect(Number(n)).toBe(1);
      expect(mockReintentos.n).toBe(0);
      expect(await colgadas()).toBe(0);
    }, 60000);

    it('aperturas simultáneas de choferes distintos reciben números distintos y correlativos', async () => {
      const e = await seedDistribuidora();
      const choferes: Chofer[] = [];
      for (let i = 0; i < 5; i += 1) choferes.push(await seedChofer(e));
      await stockInicial(e, 100);

      const res = await Promise.all(
        choferes.map((c) => abrir(e, c, [{ loadedFull: 5 }])),
      );

      expect(res.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const numeros = res
        .map((r) => cuerpo<Carga>(r).number)
        .sort((a, b) => a - b);
      expect(numeros).toEqual([1, 2, 3, 4, 5]);
      expect(mockReintentos.n).toBe(0);
    }, 60000);

    it('entregas mientras se rinde: el camión queda en cero, el libro cuadra y no hay deadlocks', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 200, 40);
      const pedidos = [];
      for (let i = 0; i < 2; i += 1) pedidos.push(await pedido(e, c, 2));
      const carga = await abrirOk(e, c, [{ loadedFull: 60, loadedEmpty: 8 }]);
      await accion(e, carga.loadId, 'depart').expect(200);
      // se entregan 2 antes de volver
      await entregar(pedidos[0].orderId);
      await entregar(pedidos[1].orderId);
      // declara lo esperado hasta acá: 60 - 4 = 56 llenas, 8 + 4 = 12 vacías
      await accion(e, carga.loadId, 'return', declarar(56, 12, e)).expect(200);

      // le entran 6 pedidos más justo después de declarar: el cierre corre a la
      // vez que sus entregas
      for (let i = 0; i < 6; i += 1) pedidos.push(await pedido(e, c, 2));
      const [cierre] = await Promise.all([
        accion(e, carga.loadId, 'close', {
          differenceNote: 'Entregas durante la rendición',
        }),
        ...pedidos.slice(2).map((p) => entregar(p.orderId)),
      ]);

      // Si alguna entrega ganó la carrera, el cierre se rechaza (409) y el
      // chofer vuelve a declarar; si no, cierra y las entregas salen del depósito.
      expect([200, 409]).toContain(cierre.status);
      expect(mockReintentos.n).toBe(0);
      if (cierre.status === 409) {
        expect(cuerpo<Mensaje>(cierre).message).toMatch(
          /después de declarar la vuelta/,
        );
        const actual = await enElCamion(c.carId, g, 'full');
        await accion(
          e,
          carga.loadId,
          'return',
          declarar(actual, await enElCamion(c.carId, g, 'empty'), e),
        ).expect(200);
        await accion(e, carga.loadId, 'close', {
          differenceNote: 'Entregas durante la rendición',
        }).expect(200);
      }
      const final = await detalle(e, carga.loadId);
      expect(['closed', 'closed_with_difference']).toContain(final.status);
      // el camión quedó en cero pase lo que pase con el orden de las entregas
      expect(await enElCamion(c.carId, g, 'full')).toBe(0);
      expect(await enElCamion(c.carId, g, 'empty')).toBe(0);
      // las llenas de todo el sistema + lo entregado = lo que había
      const [{ llenas }] = await ds.query<Array<{ llenas: string }>>(
        `SELECT COALESCE(SUM(quantity), 0) AS llenas FROM stock_balance
         WHERE gas_cylinder_id = $1 AND condition = 'full'`,
        [g],
      );
      const [{ entregadas }] = await ds.query<Array<{ entregadas: string }>>(
        `SELECT COALESCE(SUM(quantity), 0) AS entregadas FROM stock_movement
         WHERE gas_cylinder_id = $1 AND reason = 'delivery'`,
        [g],
      );
      const [{ mermas }] = await ds.query<Array<{ mermas: string }>>(
        `SELECT COALESCE(SUM(quantity), 0) AS mermas FROM stock_movement
         WHERE gas_cylinder_id = $1 AND reason = 'shrinkage' AND from_condition = 'full'`,
        [g],
      );
      const [{ hallazgos }] = await ds.query<Array<{ hallazgos: string }>>(
        `SELECT COALESCE(SUM(quantity), 0) AS hallazgos FROM stock_movement
         WHERE gas_cylinder_id = $1 AND reason = 'adjustment' AND to_condition = 'full'`,
        [g],
      );
      expect(
        Number(llenas) +
          Number(entregadas) +
          Number(mermas) -
          Number(hallazgos),
      ).toBe(200);
      await conciliado(e);
      expect(await colgadas()).toBe(0);
    }, 90000);

    it('dos cierres a la vez: uno cierra y el otro responde 400 sin mover stock de nuevo', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 40, 0);
      const carga = await abrirOk(e, c, [{ loadedFull: 20 }]);
      await accion(e, carga.loadId, 'depart').expect(200);
      await accion(e, carga.loadId, 'return', declarar(20, 0, e)).expect(200);

      const res = await Promise.all([
        accion(e, carga.loadId, 'close'),
        accion(e, carga.loadId, 'close'),
      ]);

      expect(res.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(await saldo(e.locationId, g, 'full')).toBe(40);
      expect(mockReintentos.n).toBe(0);
    }, 60000);

    it('reponer y entregar a la vez conservan el libro', async () => {
      const e = await seedDistribuidora();
      const c = await seedChofer(e);
      const g = e.garrafa.gasCylinderId;
      await stockInicial(e, 100, 0);
      const pedidos = [];
      for (let i = 0; i < 6; i += 1) pedidos.push(await pedido(e, c, 1));
      const carga = await abrirOk(e, c, [{ loadedFull: 20 }]);
      await accion(e, carga.loadId, 'depart').expect(200);

      await Promise.all([
        ...pedidos.map((p) => entregar(p.orderId)),
        accion(e, carga.loadId, 'reload', {
          items: [{ gasCylinderId: g, quantity: 10 }],
        }).expect(200),
      ]);

      const d = await detalle(e, carga.loadId);
      expect(d.items[0]).toMatchObject({
        reloadedFull: 10,
        deliveredFull: 6,
        expectedFull: 24,
        onTruckFull: 24,
      });
      expect(mockReintentos.n).toBe(0);
      await conciliado(e);
    }, 60000);
  });
});
