/**
 * Tests de integración contra Postgres REAL (testcontainers): bugs que los
 * tests unitarios (mocks) no pueden detectar, porque dependen del
 * comportamiento real de TypeORM/Postgres al guardar, lockear y bloquear
 * transacciones concurrentes.
 *
 * 1. `Order.delivery` es una relación `@ManyToOne` con `@JoinColumn({ name:
 *    'delivery_id' })` sobre la MISMA columna que `Order.deliveryId`
 *    (`@Column`). Si un caso de uso pisa sólo `deliveryId` sin tocar la
 *    relación `delivery`, TypeORM prioriza el valor de la relación —la que
 *    el query ya había cargado— al guardar, y la columna real NO cambia.
 * 2. `FOR UPDATE` sobre un `SELECT` con `LEFT JOIN` falla en Postgres
 *    ("FOR UPDATE cannot be applied to the nullable side of an outer join")
 *    salvo que se acote con `FOR UPDATE OF <tabla>`. Y ese `<tabla>` no
 *    puede llamarse `order` sin comillas (palabra reservada) → alias `ord`.
 * 3. Segunda revisión, punto 2: cancelar vs. aceptar/avanzar SON transacciones
 *    DISTINTAS que compiten por el MISMO lock de fila. Un test con mocks no
 *    puede demostrar que el lock realmente bloquea a la segunda transacción
 *    hasta que la primera hace commit — hace falta Postgres real y dos
 *    conexiones concurrentes de verdad.
 *
 * No usa `truncateAllTables` de `./setup/test-env` (bug propio, preexistente:
 * `app.get('DataSource' as any)` no resuelve el provider — afecta a TODA la
 * suite de integración existente, no es de este trabajo). Cada test arma sus
 * propios datos con ids únicos.
 */
import { DataSource } from 'typeorm';
import { TestEnv, createTestApp } from './setup/test-env';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { OrderItem } from '../../src/order/entities/order-item.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Car } from '../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { OrderService } from '../../src/order/order.service';
import { ReleaseOrderUseCase } from '../../src/order/application/release-order.use-case';
import { RoleType } from '../../src/common/constants/role-type.enum';

describe('Order.delivery vs Order.deliveryId + lock pesimista (e2e, Postgres real)', () => {
  let env: TestEnv;
  let dataSource: DataSource;
  let orderService: OrderService;
  let releaseOrderUseCase: ReleaseOrderUseCase;
  let seq = 0;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
    orderService = env.app.get(OrderService);
    releaseOrderUseCase = env.app.get(ReleaseOrderUseCase);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  /** Arma distribuidora + 2 choferes + cliente + dirección + garrafa + pedido ACCEPTED (chofer A). */
  async function seedOrderAssignedToDriverA() {
    seq += 1;
    const distributorRepo = dataSource.getRepository(Distributor);
    const userRepo = dataSource.getRepository(User);
    const deliveryRepo = dataSource.getRepository(Delivery);
    const customerRepo = dataSource.getRepository(Customer);
    const cylinderRepo = dataSource.getRepository(GasCylinder);
    const addressRepo = dataSource.getRepository(UserAddress);
    const orderRepo = dataSource.getRepository(Order);
    const itemRepo = dataSource.getRepository(OrderItem);

    const distributor = (await distributorRepo.save({
      name: `Distribuidora Test ${seq}`,
      slug: `dist-test-${seq}-${Date.now()}`,
      legalName: 'Test SRL',
      taxId: `30-${seq}${Date.now()}`,
      email: `dist${seq}@test.local`,
      phone: '+540000000000',
    } as Partial<Distributor>)) as Distributor;

    const userA = (await userRepo.save({
      email: `chofer-a-${seq}-${Date.now()}@splg.local`,
      fullName: 'Chofer A',
      phoneNumber: `+5400001${seq}${Date.now() % 10000}`,
    } as Partial<User>)) as User;
    const driverA = (await deliveryRepo.save({
      userId: userA.userId,
      distributorId: distributor.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>)) as Delivery;

    const userB = (await userRepo.save({
      email: `chofer-b-${seq}-${Date.now()}@splg.local`,
      fullName: 'Chofer B',
      phoneNumber: `+5400002${seq}${Date.now() % 10000}`,
    } as Partial<User>)) as User;
    const driverB = (await deliveryRepo.save({
      userId: userB.userId,
      distributorId: distributor.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>)) as Delivery;

    // El gate de flota exige un vehículo en uso para poder asignar.
    for (const [chofer, usuario] of [
      [driverA, userA],
      [driverB, userB],
    ] as const) {
      const auto = (await dataSource.getRepository(Car).save({
        distributorId: distributor.distributorId,
        userId: usuario.userId,
        carPatent: `T${seq}${chofer.deliveryId.slice(0, 5).toUpperCase()}`,
      } as Partial<Car>)) as Car;
      await dataSource.getRepository(VehicleAssignment).save({
        distributorId: distributor.distributorId,
        carId: auto.carId,
        deliveryId: chofer.deliveryId,
        assignedAt: new Date(),
      } as Partial<VehicleAssignment>);
    }

    const customerUser = (await userRepo.save({
      email: `cliente-${seq}-${Date.now()}@splg.local`,
      fullName: 'Cliente Test',
      phoneNumber: `+5400003${seq}${Date.now() % 10000}`,
    } as Partial<User>)) as User;
    await customerRepo.save({
      userId: customerUser.userId,
      notificationToken: 'fake-fcm',
    } as Partial<Customer>);

    const cylinder = (await cylinderRepo.save({
      type: '10kg',
      price: 1000,
      stock: 10,
      weight: 10,
      isActive: true,
      distributorId: distributor.distributorId,
    } as Partial<GasCylinder>)) as GasCylinder;

    const address = (await addressRepo.save({
      userId: customerUser.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;

    const order = (await orderRepo.save({
      customerId: customerUser.userId,
      distributorId: distributor.distributorId,
      addressId: address.addressId,
      status: OrderStatus.ACCEPTED,
      paymentMethod: PaymentMethod.CASH,
      totalAmount: 1000,
      subtotalItems: 1000,
      deliveryId: driverA.deliveryId,
      acceptedAt: new Date(),
    } as Partial<Order>)) as Order;

    await itemRepo.save({
      orderId: order.orderId,
      gasCylinderId: cylinder.gasCylinderId,
      quantity: 1,
      unitPrice: 1000,
      subtotal: 1000,
    } as Partial<OrderItem>);

    return { distributor, driverA, driverB, order, cylinder };
  }

  it('punto 8: reasignar A→B con OrderService.assignDelivery persiste B en la base (no se queda con A)', async () => {
    const { driverB, order } = await seedOrderAssignedToDriverA();

    await orderService.assignDelivery(order.orderId, driverB.deliveryId);

    const reloaded = await dataSource
      .getRepository(Order)
      .findOneOrFail({ where: { orderId: order.orderId } });

    expect(reloaded.deliveryId).toBe(driverB.deliveryId);
  }, 30000);

  it('punto 1: ReleaseOrderUseCase.execute libera de verdad (deliveryId null en la base, sin QueryFailedError)', async () => {
    const { order } = await seedOrderAssignedToDriverA();

    // Antes del fix de `FOR UPDATE OF "ord"`, esto tiraba QueryFailedError
    // ("FOR UPDATE cannot be applied to the nullable side of an outer
    // join", y después "syntax error at or near order" con el alias mal
    // puesto) — verificado contra la base real. Si vuelve a pasar, el
    // `await` de acá rechaza y el test falla.
    const released = await releaseOrderUseCase.execute(order.orderId);
    expect(released.status).toBe(OrderStatus.PENDING);
    expect(released.deliveryId).toBeNull();

    const reloaded = await dataSource
      .getRepository(Order)
      .findOneOrFail({ where: { orderId: order.orderId } });

    expect(reloaded.status).toBe(OrderStatus.PENDING);
    expect(reloaded.deliveryId).toBeNull();
  }, 30000);

  it('punto 3: dos cancelaciones concurrentes del mismo pedido → sólo 1 cancela y devuelve stock', async () => {
    const { order, cylinder } = await seedOrderAssignedToDriverA();

    const results = await Promise.allSettled([
      orderService.cancelOrder(order.orderId, 'admin-1', 'admin'),
      orderService.cancelOrder(order.orderId, 'admin-1', 'admin'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // El estado final es CANCELLED (una sola vez).
    const reloadedOrder = await dataSource
      .getRepository(Order)
      .findOneOrFail({ where: { orderId: order.orderId } });
    expect(reloadedOrder.status).toBe(OrderStatus.CANCELLED);

    // El seed pone stock=10 directo (no pasa por CreateOrderUseCase, que
    // hubiera restado 1 al crear). `restituirStock` SUMA +1 sin chequear
    // si antes se restó: una sola cancelación → 11. Si el lock no hubiera
    // funcionado, la carrera habría sumado dos veces → 12.
    const reloadedCylinder = await dataSource
      .getRepository(GasCylinder)
      .findOneOrFail({ where: { gasCylinderId: cylinder.gasCylinderId } });
    expect(reloadedCylinder.stock).toBe(11);
  }, 30000);

  it('punto 2 (segunda revisión): si otra transacción tiene el lock de fila (una cancelación en curso, sin commitear), avanzar a ON_THE_WAY ESPERA y ve el estado FRESCO al conseguirlo (no lo pisa)', async () => {
    const { order } = await seedOrderAssignedToDriverA();

    // Mantiene el lock de fila A MANO, por afuera de cualquier caso de uso,
    // simulando una cancelación que ya tomó el lock pero todavía no hizo
    // commit. Determinístico (no depende de qué tan rápido cada I/O
    // encaja): el holder arranca y pide el lock ANTES de que la otra
    // operación exista.
    const holder = dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.manager
      .createQueryBuilder(Order, 'ord')
      .setLock('pessimistic_write', undefined, ['ord'])
      .where('ord.orderId = :id', { id: order.orderId })
      .getOne();

    // Dispara la operación que TIENE que esperar ese lock: avanzar a
    // ON_THE_WAY. Sin el lock pesimista (la mutación que motivó este
    // test), esto NO espera nada: lee el estado viejo (ACCEPTED) de
    // inmediato, sin enterarse de que alguien más está por cancelar el
    // pedido.
    const avance = orderService.updateStatus(
      order.orderId,
      OrderStatus.ON_THE_WAY,
      undefined,
      RoleType.ADMIN,
    );

    // Mientras el holder sigue adentro (lock todavía tomado), deja el
    // pedido CANCELLED y recién ahí libera el lock. Si `avance` no
    // esperaba el lock, para este punto ya leyó ACCEPTED y decidió avanzar
    // con ese dato viejo.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await holder.manager.update(
      Order,
      { orderId: order.orderId },
      { status: OrderStatus.CANCELLED },
    );
    await holder.commitTransaction();
    await holder.release();

    // Con el lock real: `avance` recién pudo leer el pedido DESPUÉS de
    // este commit, lo ve CANCELLED, y `transitionOrder` lo rechaza con
    // 400 — nunca llega a pisarlo. Sin el lock (mutación), `avance` ya
    // había decidido con el dato viejo y su `UPDATE` sólo queda bloqueado
    // por el lock de fila (no por lógica de aplicación): al liberarse,
    // escribe `on_the_way` IGUAL, sin chequear nada — lost update.
    await expect(avance).rejects.toThrow(/Transición de pedido inválida/);

    const reloaded = await dataSource
      .getRepository(Order)
      .findOneOrFail({ where: { orderId: order.orderId } });
    expect(reloaded.status).toBe(OrderStatus.CANCELLED);
  }, 30000);
});
