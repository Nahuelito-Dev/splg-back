/**
 * Integración (Postgres + Redis reales): editar un pedido con una oferta de
 * despacho viva. La oferta se retira (`superseded`) y el MISMO chofer, aunque
 * sea el único en rango, recibe la nueva; ediciones repetidas no lo agotan.
 * También corre y revierte la migración que agrega el estado.
 */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { TestEnv, createTestApp, telefonoDePrueba } from './setup/test-env';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../../src/order/entities/dispatch-offer.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Car } from '../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { DispatchOrchestratorService } from '../../src/order/application/dispatch-orchestrator.service';
import { UpdateOrderUseCase } from '../../src/order/application/update-order.use-case';
import { OrderItem } from '../../src/order/entities/order-item.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { OfertaDeDespachoReemplazada1791100500000 } from '../../src/migrations/1791100500000-OfertaDeDespachoReemplazada';
import { RealtimeDispatchPort } from '../../src/order/domain/ports/realtime-dispatch.port';
import { forzarEstado } from './setup/bypass';

const LAT = -34.6037;
const LNG = -58.3816;

describe('Despacho: editar un pedido con oferta viva (e2e, Postgres + Redis reales)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let orchestrator: DispatchOrchestratorService;
  let editar: UpdateOrderUseCase;
  let realtime: RealtimeDispatchPort;
  let notifyAdmins: jest.SpyInstance;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    orchestrator = env.app.get(DispatchOrchestratorService);
    editar = env.app.get(UpdateOrderUseCase);
    realtime = env.app.get(RealtimeDispatchPort);
    notifyAdmins = jest.spyOn(realtime, 'notifyAdmins');
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(() => notifyAdmins.mockClear());

  async function nuevoChofer(distributor: Distributor, lat: number) {
    const sufijo = randomUUID().slice(0, 8);
    const user = await ds.getRepository(User).save({
      email: `chofer-${sufijo}@splg.local`,
      fullName: `Chofer ${sufijo}`,
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>);
    const delivery = await ds.getRepository(Delivery).save({
      userId: user.userId,
      distributorId: distributor.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
    const auto = await ds.getRepository(Car).save({
      distributorId: distributor.distributorId,
      userId: user.userId,
      carPatent: `R${sufijo.toUpperCase()}`,
    } as Partial<Car>);
    await ds.getRepository(VehicleAssignment).save({
      distributorId: distributor.distributorId,
      carId: auto.carId,
      deliveryId: delivery.deliveryId,
      assignedAt: new Date(),
    } as Partial<VehicleAssignment>);
    await realtime.reportDriverLocation(user.userId, lat, LNG);
    return { userId: user.userId, deliveryId: delivery.deliveryId };
  }

  async function nuevoPedido() {
    const sufijo = randomUUID().slice(0, 8);
    const distributor = await ds.getRepository(Distributor).save({
      name: `Dist ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>);
    const cliente = await ds.getRepository(User).save({
      email: `cli-${sufijo}@splg.local`,
      fullName: 'Cliente',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>);
    await ds.getRepository(Customer).save({
      userId: cliente.userId,
      notificationToken: 'fake-fcm',
    } as Partial<Customer>);
    const address = await ds.getRepository(UserAddress).save({
      userId: cliente.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: String(LAT),
      longitude: String(LNG),
    } as Partial<UserAddress>);
    const order = await ds.getRepository(Order).save({
      customerId: cliente.userId,
      distributorId: distributor.distributorId,
      addressId: address.addressId,
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      totalAmount: 1000,
      subtotalItems: 1000,
      deliveryPoint: { type: 'Point', coordinates: [LNG, LAT] },
    } as unknown as Partial<Order>);
    return { distributor, order };
  }

  const ofertas = (orderId: string) =>
    ds
      .getRepository(DispatchOffer)
      .find({ where: { orderId }, order: { offeredAt: 'ASC' } });

  async function pedidoConRenglon(distributor: Distributor, order: Order) {
    const producto = await ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 50,
      weight: 10,
      isActive: true,
      distributorId: distributor.distributorId,
    } as Partial<GasCylinder>);
    await ds.getRepository(OrderItem).save({
      orderId: order.orderId,
      gasCylinderId: producto.gasCylinderId,
      quantity: 1,
      unitPrice: 1000,
      subtotal: 1000,
    } as Partial<OrderItem>);
    return producto;
  }

  it('R3-1: el único chofer recibe la oferta nueva tras cada edición, y 3+ ediciones no lo agotan', async () => {
    const { distributor, order } = await nuevoPedido();
    const chofer = (await nuevoChofer(distributor, LAT + 0.001)).userId;
    const producto = await pedidoConRenglon(distributor, order);
    const fresco = await ds
      .getRepository(Order)
      .findOneOrFail({ where: { orderId: order.orderId } });
    expect(await orchestrator.offerToNextDriver(fresco)).toBe(chofer);

    for (let i = 1; i <= 4; i++) {
      await editar.execute(
        order.orderId,
        { items: [{ gasCylinderId: producto.gasCylinderId, quantity: i + 1 }] },
        chofer,
        distributor.distributorId,
      );
      const filas = await ofertas(order.orderId);
      const vigentes = filas.filter(
        (o) => o.status === DispatchOfferStatus.OFFERED,
      );
      expect(vigentes).toHaveLength(1);
      expect(vigentes[0].driverId).toBe(chofer);
    }
    const filas = await ofertas(order.orderId);
    expect(
      filas.filter((o) => o.status === DispatchOfferStatus.SUPERSEDED),
    ).toHaveLength(4);
    expect(
      filas.filter((o) => o.status === DispatchOfferStatus.EXPIRED),
    ).toHaveLength(0);
    expect(notifyAdmins).not.toHaveBeenCalledWith(
      'order:no-drivers',
      expect.anything(),
      expect.anything(),
    );
  }, 60000);

  it('la migración agrega "superseded" y se revierte pasando las filas a "expired"', async () => {
    const { distributor, order } = await nuevoPedido();
    const chofer = (await nuevoChofer(distributor, LAT + 0.001)).userId;
    const migracion = new OfertaDeDespachoReemplazada1791100500000();
    const qr = ds.createQueryRunner();
    try {
      await ds.getRepository(DispatchOffer).save({
        orderId: order.orderId,
        driverId: chofer,
        distributorId: distributor.distributorId,
        status: DispatchOfferStatus.SUPERSEDED,
        expiresAt: new Date(),
      } as Partial<DispatchOffer>);
      await migracion.down(qr);
      const [fila] = (await qr.query(
        `SELECT status::text AS s FROM order_dispatch_offer WHERE order_id = $1`,
        [order.orderId],
      )) as { s: string }[];
      expect(fila.s).toBe('expired');
      await migracion.up(qr);
      await forzarEstado(
        qr,
        `UPDATE order_dispatch_offer SET status = 'superseded' WHERE order_id = $1`,
        [order.orderId],
      );
    } finally {
      await qr.release();
    }
  }, 60000);
});
