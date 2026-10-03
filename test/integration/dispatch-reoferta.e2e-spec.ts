/**
 * Integración (Postgres + Redis reales): ciclo del despacho ofrecer → expirar →
 * esperar el cooldown → re-ofrecer, con un chofer que rechaza que nunca vuelve
 * a recibir el pedido y el aviso `order:no-drivers` una sola vez.
 */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { TestEnv, createTestApp } from './setup/test-env';
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
import { OrderService } from '../../src/order/order.service';
import { ReleaseOrderUseCase } from '../../src/order/application/release-order.use-case';
import { RealtimeDispatchPort } from '../../src/order/domain/ports/realtime-dispatch.port';

const LAT = -34.6037;
const LNG = -58.3816;

describe('Despacho: re-oferta de ofertas vencidas (e2e, Postgres + Redis reales)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let orchestrator: DispatchOrchestratorService;
  let realtime: RealtimeDispatchPort;
  let notifyAdmins: jest.SpyInstance;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    orchestrator = env.app.get(DispatchOrchestratorService);
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
      phoneNumber: `+5411${sufijo.replace(/\D/g, '').padEnd(8, '7').slice(0, 8)}`,
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
      phoneNumber: `+5411${sufijo.replace(/\D/g, '').padEnd(8, '3').slice(0, 8)}`,
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

  /** Simula que la oferta vigente venció hace `minutos` y corre el cron. */
  async function vencerOfertaVigente(orderId: string, minutos: number) {
    await ds.query(
      `UPDATE order_dispatch_offer SET "expiresAt" = now() - ($2 || ' minutes')::interval
       WHERE order_id = $1 AND status = 'offered'`,
      [orderId, String(minutos)],
    );
    await orchestrator.handleExpiredOffers();
  }

  it('ofrecer → expirar → esperar cooldown → re-ofrecer; el que rechazó no vuelve; avisa sin choferes una vez', async () => {
    const { distributor, order } = await nuevoPedido();
    const lento = (await nuevoChofer(distributor, LAT + 0.001)).userId;
    const rechaza = (await nuevoChofer(distributor, LAT + 0.002)).userId;
    const fullOrder = await ds
      .getRepository(Order)
      .findOneOrFail({ where: { orderId: order.orderId } });

    // 1. Se ofrece al más cercano.
    expect(await orchestrator.offerToNextDriver(fullOrder)).toBe(lento);

    // 2. Vence: pasa al nunca contactado.
    await vencerOfertaVigente(order.orderId, 1);
    let lista = await ofertas(order.orderId);
    expect(lista.map((o) => [o.driverId, o.status])).toEqual([
      [lento, DispatchOfferStatus.EXPIRED],
      [rechaza, DispatchOfferStatus.OFFERED],
    ]);

    // 3. El segundo rechaza: nadie elegible (el primero está en cooldown).
    await orchestrator.onDriverRejected(fullOrder, rechaza);
    expect(await ofertas(order.orderId)).toHaveLength(2);
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifyAdmins).toHaveBeenCalledWith(
      'order:no-drivers',
      expect.objectContaining({
        orderId: order.orderId,
        reason: 'all_drivers_exhausted',
      }),
      distributor.distributorId,
    );

    // 4. Los ticks del cron no repiten el aviso ni crean ofertas.
    await orchestrator.ensureOffered(fullOrder);
    await orchestrator.ensureOffered(fullOrder);
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(await ofertas(order.orderId)).toHaveLength(2);

    // 5. Pasado el cooldown (3 min desde el vencimiento) se re-ofrece al lento
    //    y jamás al que rechazó.
    await ds.query(
      `UPDATE order_dispatch_offer SET "expiresAt" = now() - interval '4 minutes'
       WHERE order_id = $1 AND status = 'expired'`,
      [order.orderId],
    );
    await orchestrator.ensureOffered(fullOrder);
    lista = await ofertas(order.orderId);
    expect(lista).toHaveLength(3);
    expect(lista[2].driverId).toBe(lento);
    expect(lista[2].status).toBe(DispatchOfferStatus.OFFERED);

    // 6. Un tick en paralelo no genera una segunda oferta vigente.
    await Promise.all([
      orchestrator.ensureOffered(fullOrder),
      orchestrator.ensureOffered(fullOrder),
    ]);
    const vigentes = (await ofertas(order.orderId)).filter(
      (o) => o.status === DispatchOfferStatus.OFFERED,
    );
    expect(vigentes).toHaveLength(1);
  }, 60000);

  it('asignado a mano y liberado: el chofer NO vuelve a recibir el pedido, y se avisa que no hay choferes', async () => {
    const { distributor, order } = await nuevoPedido();
    const unico = await nuevoChofer(distributor, LAT + 0.001);

    await env.app
      .get(OrderService)
      .assignDelivery(order.orderId, unico.deliveryId);
    await env.app.get(ReleaseOrderUseCase).execute(order.orderId);

    const pendiente = await ds
      .getRepository(Order)
      .findOneOrFail({ where: { orderId: order.orderId } });
    expect(pendiente.status).toBe(OrderStatus.PENDING);
    const antes = await ofertas(order.orderId);
    expect(antes.map((o) => [o.driverId, o.status])).toEqual([
      [unico.userId, DispatchOfferStatus.ACCEPTED],
    ]);

    // Aunque pase el cooldown, el único chofer no vuelve a ser candidato.
    await ds.query(
      `UPDATE order_dispatch_offer SET "expiresAt" = now() - interval '10 minutes'
       WHERE order_id = $1`,
      [order.orderId],
    );
    await orchestrator.ensureOffered(pendiente);
    expect(await ofertas(order.orderId)).toHaveLength(1);
    expect(notifyAdmins).toHaveBeenCalledWith(
      'order:no-drivers',
      expect.objectContaining({
        orderId: order.orderId,
        reason: 'all_drivers_exhausted',
      }),
      distributor.distributorId,
    );
  }, 60000);
});
