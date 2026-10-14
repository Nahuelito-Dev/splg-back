/**
 * La entrega de un pedido descuenta el stock físico (D5 y D6) por el MISMO
 * manager de la transacción del pedido, sin bloquear la entrega y sin dejar
 * sesiones colgadas. Corre `UpdateOrderStatusUseCase` real contra Postgres.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { TestEnv, createTestApp, telefonoDePrueba } from './setup/test-env';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { OrderItem } from '../../src/order/entities/order-item.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { User } from '../../src/users/entities/user.entity';
import { Role } from '../../src/role/entities/role.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Car } from '../../src/car/entities/car.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { entregarComoAdmin } from './setup/entrega-admin';
import { StockLedgerPort } from '../../src/stock/domain/ports/stock-ledger.port';
import { WarehouseService } from '../../src/stock/application/warehouse.service';
import { StockLocationService } from '../../src/stock/application/stock-location.service';
import {
  StockAdjustmentReason,
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../src/stock/domain/stock.enums';
import { StockAdjustmentUseCase } from '../../src/stock/application/stock-adjustment.use-case';

describe('Entrega de un pedido y stock físico (e2e, Postgres real)', () => {
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

  async function rol(type: string): Promise<Role> {
    const roles = ds.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  /**
   * Distribuidora con depósito central, un producto, un chofer con su camión,
   * un cliente y un pedido EN CAMINO de `cantidad` garrafas (ya reservadas:
   * el vendible parte de `vendible`).
   */
  async function escenario(opciones: { cantidad: number; vendible: number }) {
    seq += 1;
    const sufijo = `${seq}-${randomUUID().slice(0, 6)}`;
    const distributor = (await ds.getRepository(Distributor).save({
      name: `Dist ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
    const deposito = await env.app
      .get(WarehouseService)
      .asegurarPredeterminado(distributor.distributorId);

    const chofer = (await ds.getRepository(User).save({
      email: `chofer-${sufijo}@splg.local`,
      fullName: 'Chofer',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    const delivery = (await ds.getRepository(Delivery).save({
      userId: chofer.userId,
      distributorId: distributor.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>)) as Delivery;
    const auto = (await ds.getRepository(Car).save({
      distributorId: distributor.distributorId,
      userId: chofer.userId,
      carPatent: `E${seq}${randomUUID().slice(0, 4).toUpperCase()}`,
    } as Partial<Car>)) as Car;

    const clienteUser = (await ds.getRepository(User).save({
      email: `cliente-${sufijo}@splg.local`,
      fullName: 'Cliente',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
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

    const garrafa = (await ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      weight: 10,
      stock: opciones.vendible,
      isActive: true,
      distributorId: distributor.distributorId,
    } as Partial<GasCylinder>)) as GasCylinder;

    const pedido = (await ds.getRepository(Order).save({
      customerId: clienteUser.userId,
      distributorId: distributor.distributorId,
      addressId: direccion.addressId,
      status: OrderStatus.ON_THE_WAY,
      paymentMethod: PaymentMethod.CASH,
      totalAmount: 1000 * opciones.cantidad,
      subtotalItems: 1000 * opciones.cantidad,
      deliveryId: delivery.deliveryId,
      vehicleCarId: auto.carId,
      acceptedAt: new Date(),
      onTheWayAt: new Date(),
    } as Partial<Order>)) as Order;
    await ds.getRepository(OrderItem).save({
      orderId: pedido.orderId,
      gasCylinderId: garrafa.gasCylinderId,
      quantity: opciones.cantidad,
      unitPrice: 1000,
      subtotal: 1000 * opciones.cantidad,
    } as Partial<OrderItem>);

    return {
      distributor,
      deposito,
      auto,
      chofer,
      garrafa,
      pedido,
      delivery,
    };
  }

  /** Mete físico en una ubicación por el libro, como lo haría un ajuste. */
  async function poner(
    distributorId: string,
    locationId: string,
    gasCylinderId: string,
    quantity: number,
    vendible: 'sigue-al-fisico' | 'sin-cambio' = 'sin-cambio',
  ) {
    await ds.transaction((manager) =>
      env.app.get(StockLedgerPort).aplicar(manager, {
        distributorId,
        referenceType: StockReferenceType.INITIAL,
        referenceId: null,
        actorUserId: null,
        vendible,
        movimientos: [
          {
            gasCylinderId,
            quantity,
            from: null,
            to: { locationId, condition: StockCondition.FULL },
            reason: StockMovementReason.INITIAL_COUNT,
          },
        ],
      }),
    );
  }

  const saldo = async (
    locationId: string,
    gasCylinderId: string,
    condition: string,
  ) => {
    const [f] = await ds.query<Array<{ quantity: number }>>(
      `SELECT quantity FROM stock_balance WHERE location_id = $1 AND gas_cylinder_id = $2 AND condition = $3`,
      [locationId, gasCylinderId, condition],
    );
    return f?.quantity ?? 0;
  };
  const vendible = async (id: string) =>
    (await ds.getRepository(GasCylinder).findOneByOrFail({ gasCylinderId: id }))
      .stock;
  const movimientosDelPedido = (orderId: string) =>
    ds.query<
      Array<{
        reason: string;
        quantity: number;
        from_location_id: string | null;
        to_location_id: string | null;
      }>
    >(
      `SELECT reason, quantity, from_location_id, to_location_id FROM stock_movement
       WHERE reference_type = 'order' AND reference_id = $1 ORDER BY reason`,
      [orderId],
    );
  const colgadas = async () => {
    const [{ n }] = await ds.query<Array<{ n: string }>>(
      `SELECT COUNT(*) AS n FROM pg_stat_activity WHERE state = 'idle in transaction'`,
    );
    return Number(n);
  };
  const entregar = (id: string) => entregarComoAdmin(env, id);

  it('si falla el asiento del historial de la entrega manual, se deshace TODO: pedido, stock y libro', async () => {
    const e = await escenario({ cantidad: 3, vendible: 7 });
    const camion = await env.app
      .get(StockLocationService)
      .ubicacionDeVehiculo(
        ds.manager,
        e.distributor.distributorId,
        e.auto.carId,
      );
    await poner(
      e.distributor.distributorId,
      camion.locationId,
      e.garrafa.gasCylinderId,
      10,
    );
    await ds.query(`
      CREATE FUNCTION falla_historial() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'historial caído'; END;
      $$ LANGUAGE plpgsql`);
    await ds.query(`
      CREATE TRIGGER falla_historial BEFORE INSERT ON order_status_history
      FOR EACH ROW EXECUTE FUNCTION falla_historial()`);
    try {
      await expect(entregar(e.pedido.orderId)).rejects.toBeDefined();
    } finally {
      await ds.query(`DROP TRIGGER falla_historial ON order_status_history`);
      await ds.query(`DROP FUNCTION falla_historial()`);
    }

    const [pedido] = await ds.query<Array<{ status: string }>>(
      `SELECT status FROM "order" WHERE order_id = $1`,
      [e.pedido.orderId],
    );
    expect(pedido.status).toBe(OrderStatus.ON_THE_WAY);
    expect(
      await saldo(camion.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(10);
    expect(await movimientosDelPedido(e.pedido.orderId)).toEqual([]);
    expect(
      await ds.query(
        `SELECT 1 FROM order_status_history WHERE order_id = $1 AND to_status = 'delivered'`,
        [e.pedido.orderId],
      ),
    ).toEqual([]);
    expect(await colgadas()).toBe(0);
  }, 60000);

  it('con saldo en el camión: sale la llena del camión, entra la vacía de canje y el vendible no se toca', async () => {
    const e = await escenario({ cantidad: 3, vendible: 7 });
    const camion = await env.app
      .get(StockLocationService)
      .ubicacionDeVehiculo(
        ds.manager,
        e.distributor.distributorId,
        e.auto.carId,
      );
    await poner(
      e.distributor.distributorId,
      e.deposito.locationId,
      e.garrafa.gasCylinderId,
      20,
    );
    await poner(
      e.distributor.distributorId,
      camion.locationId,
      e.garrafa.gasCylinderId,
      10,
    );

    const entregado = await entregar(e.pedido.orderId);

    expect(entregado.status).toBe(OrderStatus.DELIVERED);
    expect(
      await saldo(camion.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(7);
    expect(
      await saldo(camion.locationId, e.garrafa.gasCylinderId, 'empty'),
    ).toBe(3);
    expect(
      await saldo(e.deposito.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(20);
    expect(await vendible(e.garrafa.gasCylinderId)).toBe(7);
    expect(await movimientosDelPedido(e.pedido.orderId)).toEqual([
      {
        reason: 'delivery',
        quantity: 3,
        from_location_id: camion.locationId,
        to_location_id: null,
      },
      {
        reason: 'empty_collected',
        quantity: 3,
        from_location_id: null,
        to_location_id: camion.locationId,
      },
    ]);
    expect(await colgadas()).toBe(0);
  }, 30000);

  it('sin ubicación de camión cae al depósito predeterminado (D5)', async () => {
    const e = await escenario({ cantidad: 2, vendible: 8 });
    await poner(
      e.distributor.distributorId,
      e.deposito.locationId,
      e.garrafa.gasCylinderId,
      10,
    );

    await entregar(e.pedido.orderId);

    expect(
      await saldo(e.deposito.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(8);
    expect(
      await saldo(e.deposito.locationId, e.garrafa.gasCylinderId, 'empty'),
    ).toBe(2);
    expect(await colgadas()).toBe(0);
  }, 30000);

  it('un camión sin llenas suficientes tampoco bloquea: sale del depósito', async () => {
    const e = await escenario({ cantidad: 4, vendible: 6 });
    const camion = await env.app
      .get(StockLocationService)
      .ubicacionDeVehiculo(
        ds.manager,
        e.distributor.distributorId,
        e.auto.carId,
      );
    await poner(
      e.distributor.distributorId,
      camion.locationId,
      e.garrafa.gasCylinderId,
      1,
    );
    await poner(
      e.distributor.distributorId,
      e.deposito.locationId,
      e.garrafa.gasCylinderId,
      9,
    );

    await entregar(e.pedido.orderId);

    expect(
      await saldo(camion.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(1);
    expect(
      await saldo(e.deposito.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(5);
  }, 30000);

  it('sin llenas en ningún lado la entrega se hace igual y queda para la conciliación', async () => {
    const e = await escenario({ cantidad: 2, vendible: 0 });
    await poner(
      e.distributor.distributorId,
      e.deposito.locationId,
      e.garrafa.gasCylinderId,
      1,
    );

    const entregado = await entregar(e.pedido.orderId);

    expect(entregado.status).toBe(OrderStatus.DELIVERED);
    expect(await movimientosDelPedido(e.pedido.orderId)).toEqual([]);
    expect(
      await saldo(e.deposito.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(1);
    expect(await colgadas()).toBe(0);

    // La conciliación lo informa (no lo corrige)...
    const admin = (await ds.getRepository(User).save({
      email: `admin-${seq}-${randomUUID().slice(0, 6)}@splg.local`,
      fullName: 'Admin',
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol('admin')).roleId,
    } as Partial<User>)) as User;
    await ds.getRepository(Admin).save({
      userId: admin.userId,
      distributorId: e.distributor.distributorId,
    } as Partial<Admin>);
    const headers = {
      Authorization: `Bearer ${admin.email}`,
      'X-Client-Source': 'panel-app',
    };
    const concil = await request(env.app.getHttpServer())
      .get('/stock/reconciliation')
      .set(headers)
      .expect(200);
    const cuerpo = concil.body as {
      consistent: boolean;
      deliveriesWithoutMovement: Array<{ orderId: string; quantity: number }>;
    };
    expect(cuerpo.consistent).toBe(false);
    expect(cuerpo.deliveriesWithoutMovement).toEqual([
      expect.objectContaining({ orderId: e.pedido.orderId, quantity: 2 }),
    ]);

    // ...y una vez que hay llenas, el administrador lo reaplica (idempotente).
    await poner(
      e.distributor.distributorId,
      e.deposito.locationId,
      e.garrafa.gasCylinderId,
      5,
    );
    const r1 = await request(env.app.getHttpServer())
      .post('/stock/reconciliation/reapply-deliveries')
      .set(headers)
      .expect(201);
    expect(r1.body).toEqual({ revisados: 1, reaplicados: 1, pendientes: 0 });
    expect(
      await saldo(e.deposito.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(4);
    const r2 = await request(env.app.getHttpServer())
      .post('/stock/reconciliation/reapply-deliveries')
      .set(headers)
      .expect(201);
    expect(r2.body).toEqual({ revisados: 0, reaplicados: 0, pendientes: 0 });
    expect(
      await saldo(e.deposito.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(4);
    expect(await movimientosDelPedido(e.pedido.orderId)).toHaveLength(2);
  }, 30000);

  it('es idempotente por pedido: reintentar la entrega no descuenta dos veces', async () => {
    const e = await escenario({ cantidad: 2, vendible: 8 });
    await poner(
      e.distributor.distributorId,
      e.deposito.locationId,
      e.garrafa.gasCylinderId,
      10,
    );

    await entregar(e.pedido.orderId);
    // La máquina de estados deja repetir DELIVERED: el stock no se descuenta de nuevo.
    await entregar(e.pedido.orderId);

    expect(
      await saldo(e.deposito.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(8);
    expect(await movimientosDelPedido(e.pedido.orderId)).toHaveLength(2);
  }, 30000);

  it('dos entregas simultáneas del mismo pedido descuentan el físico una sola vez y no cuelgan sesiones', async () => {
    const e = await escenario({ cantidad: 2, vendible: 8 });
    await poner(
      e.distributor.distributorId,
      e.deposito.locationId,
      e.garrafa.gasCylinderId,
      10,
    );

    const r = await Promise.allSettled([
      entregar(e.pedido.orderId),
      entregar(e.pedido.orderId),
    ]);

    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
    expect(
      await saldo(e.deposito.locationId, e.garrafa.gasCylinderId, 'full'),
    ).toBe(8);
    expect(await movimientosDelPedido(e.pedido.orderId)).toHaveLength(2);
    expect(await colgadas()).toBe(0);
  }, 30000);

  it('entregas en paralelo de pedidos distintos sobre el mismo saldo no se traban ni dejan negativo', async () => {
    const base = await escenario({ cantidad: 1, vendible: 0 });
    await poner(
      base.distributor.distributorId,
      base.deposito.locationId,
      base.garrafa.gasCylinderId,
      6,
    );
    // Cinco pedidos más de la misma distribuidora, todos de 2 (suman 12 > 6).
    const pedidos = [base.pedido];
    for (let i = 0; i < 5; i++) {
      const p = (await ds.getRepository(Order).save({
        customerId: base.pedido.customerId,
        distributorId: base.distributor.distributorId,
        addressId: base.pedido.addressId,
        status: OrderStatus.ON_THE_WAY,
        paymentMethod: PaymentMethod.CASH,
        totalAmount: 2000,
        subtotalItems: 2000,
        deliveryId: base.delivery.deliveryId,
        vehicleCarId: base.auto.carId,
        acceptedAt: new Date(),
        onTheWayAt: new Date(),
      } as Partial<Order>)) as Order;
      await ds.getRepository(OrderItem).save({
        orderId: p.orderId,
        gasCylinderId: base.garrafa.gasCylinderId,
        quantity: 2,
        unitPrice: 1000,
        subtotal: 2000,
      } as Partial<OrderItem>);
      pedidos.push(p);
    }
    await ds.query(`UPDATE order_item SET quantity = 2 WHERE order_id = $1`, [
      base.pedido.orderId,
    ]);

    const r = await Promise.allSettled(pedidos.map((p) => entregar(p.orderId)));

    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
    const llenas = await saldo(
      base.deposito.locationId,
      base.garrafa.gasCylinderId,
      'full',
    );
    const vacias = await saldo(
      base.deposito.locationId,
      base.garrafa.gasCylinderId,
      'empty',
    );
    expect(llenas).toBeGreaterThanOrEqual(0);
    expect(6 - llenas).toBe(vacias); // canje 1 a 1
    expect(llenas).toBe(0); // 3 pedidos de 2 entran; los otros 3 quedan sin descontar
    expect(vacias).toBe(6);
    expect(await colgadas()).toBe(0);
  }, 60000);

  it('entregas contra ajustes de llenas simultáneos sobre la misma garrafa y el mismo depósito: ninguna se pierde por deadlock', async () => {
    const base = await escenario({ cantidad: 1, vendible: 0 });
    const dist = base.distributor.distributorId;
    await poner(
      dist,
      base.deposito.locationId,
      base.garrafa.gasCylinderId,
      200,
    );
    const pedidos: Order[] = [];
    for (let i = 0; i < 16; i++) {
      const p = (await ds.getRepository(Order).save({
        customerId: base.pedido.customerId,
        distributorId: dist,
        addressId: base.pedido.addressId,
        status: OrderStatus.ON_THE_WAY,
        paymentMethod: PaymentMethod.CASH,
        totalAmount: 1000,
        subtotalItems: 1000,
        deliveryId: base.delivery.deliveryId,
        acceptedAt: new Date(),
        onTheWayAt: new Date(),
      } as Partial<Order>)) as Order;
      await ds.getRepository(OrderItem).save({
        orderId: p.orderId,
        gasCylinderId: base.garrafa.gasCylinderId,
        quantity: 1,
        unitPrice: 1000,
        subtotal: 1000,
      } as Partial<OrderItem>);
      pedidos.push(p);
    }
    const ajustar = () =>
      env.app.get(StockAdjustmentUseCase).execute(
        {
          location: { warehouseId: base.deposito.warehouse.warehouseId },
          reason: StockAdjustmentReason.FOUND,
          notes: 'hallazgo',
          items: [
            {
              gasCylinderId: base.garrafa.gasCylinderId,
              condition: StockCondition.FULL,
              quantityDelta: 1,
            },
          ],
        },
        dist,
        base.chofer.userId,
      );

    const r = await Promise.allSettled([
      ...pedidos.map((p) => entregar(p.orderId)),
      ...Array.from({ length: 16 }, ajustar),
    ]);

    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
    // Todas las entregas descontaron: 2 movimientos por pedido, ninguna omitida.
    const [{ n }] = await ds.query<Array<{ n: string }>>(
      `SELECT COUNT(*) AS n FROM stock_movement WHERE reference_type = 'order' AND distributor_id = $1`,
      [dist],
    );
    expect(Number(n)).toBe(32);
    expect(
      await saldo(base.deposito.locationId, base.garrafa.gasCylinderId, 'full'),
    ).toBe(200 - 16 + 16);
    expect(await colgadas()).toBe(0);
  }, 90000);
});
