/**
 * Integración (Postgres + Redis reales): ciclo del despacho ofrecer → expirar →
 * esperar el cooldown → re-ofrecer, con un chofer que rechaza que nunca vuelve
 * a recibir el pedido y el aviso `order:no-drivers` una sola vez.
 */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  patenteDePrueba,
} from './setup/test-env';
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
import { UpdateOrderStatusUseCase } from '../../src/order/application/update-order-status.use-case';
import { ReleaseOrderUseCase } from '../../src/order/application/release-order.use-case';
import { RoleType } from '../../src/common/constants/role-type.enum';
import { RealtimeDispatchPort } from '../../src/order/domain/ports/realtime-dispatch.port';

const LAT = -34.6037;
const LNG = -58.3816;

describe('Despacho: re-oferta de ofertas vencidas (e2e, Postgres + Redis reales)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let orchestrator: DispatchOrchestratorService;
  let realtime: RealtimeDispatchPort;
  let notifyAdmins: jest.SpyInstance;
  let notifyDriverCancelled: jest.SpyInstance;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    orchestrator = env.app.get(DispatchOrchestratorService);
    realtime = env.app.get(RealtimeDispatchPort);
    notifyAdmins = jest.spyOn(realtime, 'notifyAdmins');
    notifyDriverCancelled = jest.spyOn(realtime, 'notifyDriverOrderCancelled');
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(() => {
    notifyAdmins.mockClear();
    notifyDriverCancelled.mockClear();
  });

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
      carPatent: patenteDePrueba(),
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

  /** Simula que la oferta vigente venció hace `minutos` y corre el cron. */
  async function vencerOfertaVigente(orderId: string, minutos: number) {
    await ds.query(
      `UPDATE order_dispatch_offer SET "expiresAt" = now() - ($2 || ' minutes')::interval,
           "offeredAt" = now() - ($2 || ' minutes')::interval - ("expiresAt" - "offeredAt")
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
      `UPDATE order_dispatch_offer SET "expiresAt" = now() - interval '4 minutes',
           "offeredAt" = now() - interval '4 minutes' - ("expiresAt" - "offeredAt")
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
      `UPDATE order_dispatch_offer SET "expiresAt" = now() - interval '10 minutes',
           "offeredAt" = now() - interval '10 minutes' - ("expiresAt" - "offeredAt")
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

  const ofertarA = (orderId: string, distributorId: string, driverId: string) =>
    ds.getRepository(DispatchOffer).save({
      orderId,
      distributorId,
      driverId,
      status: DispatchOfferStatus.OFFERED,
      expiresAt: new Date(Date.now() + 60_000),
    } as Partial<DispatchOffer>);

  const estados = async (orderId: string) =>
    new Map((await ofertas(orderId)).map((o) => [o.driverId, o.status]));

  it('el admin asigna a mano con ofertas abiertas a otros choferes: se retiran y se les avisa', async () => {
    const { distributor, order } = await nuevoPedido();
    const otro1 = await nuevoChofer(distributor, LAT + 0.001);
    const otro2 = await nuevoChofer(distributor, LAT + 0.002);
    const asignado = await nuevoChofer(distributor, LAT + 0.003);
    await ofertarA(order.orderId, distributor.distributorId, otro1.userId);
    await ofertarA(order.orderId, distributor.distributorId, otro2.userId);
    await ofertarA(order.orderId, distributor.distributorId, asignado.userId);

    await env.app
      .get(OrderService)
      .assignDelivery(order.orderId, asignado.deliveryId);

    const final = await estados(order.orderId);
    expect(final.get(otro1.userId)).toBe(DispatchOfferStatus.SUPERSEDED);
    expect(final.get(otro2.userId)).toBe(DispatchOfferStatus.SUPERSEDED);
    expect(final.get(asignado.userId)).toBe(DispatchOfferStatus.ACCEPTED);
    const avisados = notifyDriverCancelled.mock.calls.map(
      ([driverId]: [string]) => driverId,
    );
    expect(avisados).toEqual(
      expect.arrayContaining([otro1.userId, otro2.userId]),
    );
    expect(avisados).not.toContain(asignado.userId);
    // el pedido no vuelve a ofrecerse a los retirados como si hubieran vencido
    expect(await ofertas(order.orderId)).toHaveLength(3);
  }, 60000);

  it('un chofer toma el pedido del pool con ofertas abiertas a otros: se retiran y se les avisa', async () => {
    const { distributor, order } = await nuevoPedido();
    const otro = await nuevoChofer(distributor, LAT + 0.001);
    const quien = await nuevoChofer(distributor, LAT + 0.002);
    await ofertarA(order.orderId, distributor.distributorId, otro.userId);

    const tomado = await env.app
      .get(UpdateOrderStatusUseCase)
      .execute(
        order.orderId,
        OrderStatus.ACCEPTED,
        quien.userId,
        RoleType.DELIVERY,
        quien.userId,
      );

    expect(tomado.status).toBe(OrderStatus.ACCEPTED);
    const final = await estados(order.orderId);
    expect(final.get(otro.userId)).toBe(DispatchOfferStatus.SUPERSEDED);
    expect(final.get(quien.userId)).toBe(DispatchOfferStatus.ACCEPTED);
    expect(notifyDriverCancelled).toHaveBeenCalledWith(
      otro.userId,
      expect.objectContaining({ orderId: order.orderId }),
    );
  }, 60000);

  it('tope de re-ofertas: tras 3 vencidas el único chofer queda agotado, avisa una vez y un chofer nuevo sí recibe', async () => {
    const { distributor, order } = await nuevoPedido();
    const mudo = (await nuevoChofer(distributor, LAT + 0.001)).userId;
    const fullOrder = await ds
      .getRepository(Order)
      .findOneOrFail({ where: { orderId: order.orderId } });
    const max = DispatchOrchestratorService.MAX_REOFERTAS_POR_CHOFER;

    expect(await orchestrator.offerToNextDriver(fullOrder)).toBe(mudo);
    for (let i = 1; i < max; i++) {
      // Vence hace más del cooldown: el cron lo re-ofrece al mismo chofer.
      await vencerOfertaVigente(order.orderId, 10);
      expect(await ofertas(order.orderId)).toHaveLength(i + 1);
    }
    expect(notifyAdmins).not.toHaveBeenCalled();

    // La última vence: llegó al tope, no se crea otra oferta y se avisa.
    await vencerOfertaVigente(order.orderId, 10);
    let lista = await ofertas(order.orderId);
    expect(lista).toHaveLength(max);
    expect(lista.every((o) => o.driverId === mudo)).toBe(true);
    expect(lista.every((o) => o.status === DispatchOfferStatus.EXPIRED)).toBe(
      true,
    );
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifyAdmins).toHaveBeenCalledWith(
      'order:no-drivers',
      expect.objectContaining({
        orderId: order.orderId,
        reason: 'all_drivers_exhausted',
      }),
      distributor.distributorId,
    );

    // Los ticks siguientes no ofrecen ni repiten el aviso.
    await orchestrator.ensureOffered(fullOrder);
    await orchestrator.ensureOffered(fullOrder);
    expect(await ofertas(order.orderId)).toHaveLength(max);
    expect(notifyAdmins).toHaveBeenCalledTimes(1);

    // Un chofer nuevo recibe la oferta con normalidad.
    const nuevo = (await nuevoChofer(distributor, LAT + 0.002)).userId;
    await orchestrator.ensureOffered(fullOrder);
    lista = await ofertas(order.orderId);
    expect(lista).toHaveLength(max + 1);
    expect(lista[max].driverId).toBe(nuevo);
    expect(lista[max].status).toBe(DispatchOfferStatus.OFFERED);
  }, 60000);
});
