/**
 * Un pedido pendiente sin chofer vence solo, contra la app con Postgres y Redis
 * efímeros: la consulta de candidatos corre en la base real (agenda en hora
 * argentina, límite por tic), la cancelación pasa por `CancelOrderUseCase` con
 * el pedido bloqueado y el tic del despacho la dispara.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { TestEnv, createTestApp, telefonoDePrueba } from './setup/test-env';
import { Escenario, sembrarEscenario } from './matriz-http/matriz';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../../src/order/entities/dispatch-offer.entity';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from '../../src/order/entities/order.entity';
import { MOTIVO_VENCIMIENTO_SIN_CHOFER } from '../../src/order/domain/vencimiento-sin-chofer';
import {
  VENCIDOS_POR_TIC,
  VencimientoSinChoferService,
} from '../../src/order/application/vencimiento-sin-chofer.service';
import { DispatchService } from '../../src/order/dispatch.service';
import { ExpressDegradeService } from '../../src/order/application/express-degrade.service';
import { RealtimeDispatchPort } from '../../src/order/domain/ports/realtime-dispatch.port';
import { TimeSlot } from '../../src/time-slot/entities/time-slot.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { diaArgentino, sumarDias } from '../../src/common/utils/dias-argentina';

const MIN = 60_000;
const hace = (min: number) => new Date(Date.now() - min * MIN);

describe('Vencimiento de pedidos sin chofer (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let e: Escenario;
  let vencimientos: VencimientoSinChoferService;
  let realtime: RealtimeDispatchPort;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    e = await sembrarEscenario(env.app);
    vencimientos = env.app.get(VencimientoSinChoferService);
    realtime = env.app.get(RealtimeDispatchPort);
  }, 240000);

  afterAll(async () => {
    await env?.cleanup();
  });

  // Sólo los espías de cada caso: `restoreAllMocks` también deshace el bypass
  // de Firebase del entorno de prueba.
  const espias: jest.SpyInstance[] = [];
  const espiar = <T extends jest.SpyInstance>(espia: T): T => {
    espias.push(espia);
    return espia;
  };
  afterEach(() => {
    for (const espia of espias.splice(0)) espia.mockRestore();
  });

  const http = () => request(env.app.getHttpServer());

  /** Una distribuidora propia por caso, con un cliente y su dirección. */
  async function distribuidora() {
    const sufijo = randomUUID().slice(0, 8);
    const d = await ds.getRepository(Distributor).save({
      name: `Venc ${sufijo}`,
      slug: `venc-${sufijo}`,
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
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>);
    return {
      id: d.distributorId,
      slug: d.slug,
      clienteId: cliente.userId,
      addressId: address.addressId,
    };
  }
  type Dist = Awaited<ReturnType<typeof distribuidora>>;

  async function pedido(d: Dist, over: Partial<Order> = {}): Promise<Order> {
    return (await ds.getRepository(Order).save({
      customerId: d.clienteId,
      distributorId: d.id,
      addressId: d.addressId,
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      paymentType: PaymentType.CASH,
      totalAmount: 1000,
      subtotalItems: 1000,
      deliveryPoint: { type: 'Point', coordinates: [-58.3816, -34.6037] },
      ...over,
    } as unknown as Partial<Order>)) as Order;
  }

  async function franja(d: Dist, inicio: string, fin: string) {
    return ds.getRepository(TimeSlot).save({
      distributorId: d.id,
      name: `F ${inicio}`,
      startTime: inicio,
      endTime: fin,
    } as Partial<TimeSlot>);
  }

  async function chofer(d: Dist) {
    const user = await ds.getRepository(User).save({
      email: `chofer-${randomUUID().slice(0, 8)}@splg.local`,
      fullName: 'Chofer',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>);
    const delivery = await ds.getRepository(Delivery).save({
      userId: user.userId,
      distributorId: d.id,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
    return { userId: user.userId, deliveryId: delivery.deliveryId };
  }

  const estado = async (orderId: string) =>
    (await ds.getRepository(Order).findOneByOrFail({ orderId })).status;

  const ponerMinutos = (d: Dist, minutos: number) =>
    http()
      .put('/module-config/dispatch')
      .set({ ...e.actores.super, 'X-Distributor': d.slug })
      .send({ noDriverExpiryMinutes: minutos })
      .expect(200);

  it('cancela el vencido como sistema, con el motivo, y retira la oferta viva; el cliente lo ve cancelado por el sistema', async () => {
    const d = await distribuidora();
    const c = await chofer(d);
    const vencido = await pedido(d, { availableSince: hace(121) });
    await ds.getRepository(DispatchOffer).save({
      distributorId: d.id,
      orderId: vencido.orderId,
      driverId: c.userId,
      status: DispatchOfferStatus.OFFERED,
      offeredAt: new Date(),
      expiresAt: new Date(Date.now() + 30_000),
    } as Partial<DispatchOffer>);
    const avisos = espiar(jest.spyOn(realtime, 'notifyCustomer'));

    expect(await vencimientos.vencer([d.id])).toBe(1);

    const fila = await ds
      .getRepository(Order)
      .findOneByOrFail({ orderId: vencido.orderId });
    expect(fila.status).toBe(OrderStatus.CANCELLED);
    expect(fila.cancellationReason).toBe(MOTIVO_VENCIMIENTO_SIN_CHOFER);
    const [oferta] = await ds
      .getRepository(DispatchOffer)
      .find({ where: { orderId: vencido.orderId } });
    expect(oferta.status).toBe(DispatchOfferStatus.SUPERSEDED);
    expect(avisos).toHaveBeenCalledWith(
      d.clienteId,
      'order:cancelled',
      expect.objectContaining({
        cancelledBy: 'system',
        reason: MOTIVO_VENCIMIENTO_SIN_CHOFER,
      }),
    );
    const [historial] = await ds.query<
      Array<{ changed_by_user_id: string | null }>
    >(
      `SELECT changed_by_user_id FROM order_status_history WHERE order_id = $1 AND to_status = 'cancelled'`,
      [vencido.orderId],
    );
    expect(historial.changed_by_user_id).toBeNull();

    const res = await http()
      .get(`/orders/${vencido.orderId}`)
      .set({ ...e.actores.super, 'X-Distributor': d.slug })
      .expect(200);
    expect((res.body as { cancelledBy: string }).cancelledBy).toBe('system');
  });

  it('no toca los que no vencen: recién pedidos, Mercado Pago sin pagar, retenidos por fraude, express, con chofer y agendados para más adelante', async () => {
    const d = await distribuidora();
    const c = await chofer(d);
    const manana = sumarDias(diaArgentino(), 1);
    const tarde = await franja(d, '08:00', '10:00');
    const intactos = [
      await pedido(d, { availableSince: hace(119) }),
      await pedido(d, {
        availableSince: hace(500),
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentType: PaymentType.ONLINE,
        paymentStatus: PaymentStatus.PENDING,
      }),
      await pedido(d, {
        availableSince: hace(500),
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentType: PaymentType.ONLINE,
        paymentStatus: PaymentStatus.PAID,
        paymentFraudHold: true,
      }),
      await pedido(d, {
        availableSince: hace(500),
        deliveryMode: OrderDeliveryMode.EXPRESS,
      }),
      await pedido(d, {
        availableSince: hace(500),
        status: OrderStatus.ACCEPTED,
        deliveryId: c.deliveryId,
        acceptedAt: new Date(),
      }),
      await pedido(d, {
        availableSince: hace(5000),
        scheduledDate: manana,
        timeSlotId: tarde.timeSlotId,
      }),
      await pedido(d, { availableSince: hace(5000), scheduledDate: manana }),
    ];

    // Ni siquiera llegan a candidatos: la consulta ya filtra por vencimiento.
    expect(await vencimientos.candidatos(d.id, 120, new Date())).toEqual([]);
    expect(await vencimientos.vencer([d.id])).toBe(0);
    for (const o of intactos) {
      expect(await estado(o.orderId)).not.toBe(OrderStatus.CANCELLED);
    }
  });

  it('agendados en hora argentina: la franja de ayer y el día de ayer sin franja vencen; el de ayer liberado hace poco, no', async () => {
    const d = await distribuidora();
    const ayer = sumarDias(diaArgentino(), -1);
    const manana = await franja(d, '08:00', '10:00');
    const conFranja = await pedido(d, {
      availableSince: hace(5000),
      scheduledDate: ayer,
      timeSlotId: manana.timeSlotId,
    });
    const sinFranja = await pedido(d, {
      availableSince: hace(5000),
      scheduledDate: ayer,
    });
    const liberado = await pedido(d, {
      availableSince: hace(10),
      scheduledDate: ayer,
      timeSlotId: manana.timeSlotId,
    });

    expect(await vencimientos.vencer([d.id])).toBe(2);
    expect(await estado(conFranja.orderId)).toBe(OrderStatus.CANCELLED);
    expect(await estado(sinFranja.orderId)).toBe(OrderStatus.CANCELLED);
    expect(await estado(liberado.orderId)).toBe(OrderStatus.PENDING);
  });

  it('50 agendados para más adelante no tapan a un vencido', async () => {
    const d = await distribuidora();
    const pasado = sumarDias(diaArgentino(), 2);
    const viejo = hace(10_000);
    // Más viejos que el vencido: si la consulta no filtrara por vencimiento,
    // ocuparían los 50 lugares.
    for (let i = 0; i < VENCIDOS_POR_TIC; i += 1) {
      await pedido(d, { availableSince: viejo, scheduledDate: pasado });
    }
    const vencido = await pedido(d, { availableSince: hace(200) });

    expect(await vencimientos.vencer([d.id])).toBe(1);
    expect(await estado(vencido.orderId)).toBe(OrderStatus.CANCELLED);
  });

  it('el límite por tic: de 55 vencidos toma 50, los más viejos primero', async () => {
    const d = await distribuidora();
    const ids: string[] = [];
    for (let i = 0; i < 55; i += 1) {
      ids.push((await pedido(d, { availableSince: hace(1000 - i) })).orderId);
    }
    const candidatos = await vencimientos.candidatos(d.id, 120, new Date());
    expect(candidatos).toEqual(ids.slice(0, VENCIDOS_POR_TIC));
  });

  it('cada distribuidora con su plazo: a los 45 minutos vence con 30 y no con 120', async () => {
    const corta = await distribuidora();
    const larga = await distribuidora();
    await ponerMinutos(corta, 30);
    const res = await http()
      .get('/module-config/dispatch')
      .set({ ...e.actores.super, 'X-Distributor': corta.slug })
      .expect(200);
    expect(
      (res.body as { noDriverExpiryMinutes: number }).noDriverExpiryMinutes,
    ).toBe(30);
    const enCorta = await pedido(corta, { availableSince: hace(45) });
    const enLarga = await pedido(larga, { availableSince: hace(45) });

    expect(await vencimientos.vencer([corta.id, larga.id])).toBe(1);
    expect(await estado(enCorta.orderId)).toBe(OrderStatus.CANCELLED);
    expect(await estado(enLarga.orderId)).toBe(OrderStatus.PENDING);
  });

  it('un chofer lo acepta entre la consulta y el lock: no se cancela ni se avisa nada', async () => {
    const d = await distribuidora();
    const c = await chofer(d);
    const o = await pedido(d, { availableSince: hace(200) });
    const original = vencimientos.candidatos.bind(vencimientos);
    espiar(jest.spyOn(vencimientos, 'candidatos')).mockImplementationOnce(
      async (...args) => {
        const elegidos = await original(...args);
        expect(elegidos).toEqual([o.orderId]);
        await ds.getRepository(Order).update(o.orderId, {
          status: OrderStatus.ACCEPTED,
          deliveryId: c.deliveryId,
          acceptedAt: new Date(),
        });
        return elegidos;
      },
    );
    const avisos = espiar(jest.spyOn(realtime, 'notifyCustomer'));

    expect(await vencimientos.vencer([d.id])).toBe(0);
    const fila = await ds
      .getRepository(Order)
      .findOneByOrFail({ orderId: o.orderId });
    expect(fila.status).toBe(OrderStatus.ACCEPTED);
    expect(fila.cancellationReason).toBeNull();
    expect(avisos).not.toHaveBeenCalled();
  });

  it('lo liberan (available_since nuevo) entre la consulta y el lock: re-decide con la fila bloqueada y no se cancela', async () => {
    const d = await distribuidora();
    const o = await pedido(d, { availableSince: hace(200) });
    const original = vencimientos.candidatos.bind(vencimientos);
    espiar(jest.spyOn(vencimientos, 'candidatos')).mockImplementationOnce(
      async (...args) => {
        const elegidos = await original(...args);
        await ds
          .getRepository(Order)
          .update(o.orderId, { availableSince: new Date() });
        return elegidos;
      },
    );

    expect(await vencimientos.vencer([d.id])).toBe(0);
    expect(await estado(o.orderId)).toBe(OrderStatus.PENDING);
  });

  it('un pedido que falla no corta el tic: el siguiente vence igual', async () => {
    const d = await distribuidora();
    const roto = await pedido(d, { availableSince: hace(300) });
    const bueno = await pedido(d, { availableSince: hace(200) });
    const original = vencimientos.candidatos.bind(vencimientos);
    espiar(jest.spyOn(vencimientos, 'candidatos')).mockImplementationOnce(
      async (...args) => {
        await original(...args);
        // Un id que no existe en el medio: CancelOrderUseCase responde 404.
        return [roto.orderId, randomUUID(), bueno.orderId];
      },
    );

    expect(await vencimientos.vencer([d.id])).toBe(2);
    expect(await estado(roto.orderId)).toBe(OrderStatus.CANCELLED);
    expect(await estado(bueno.orderId)).toBe(OrderStatus.CANCELLED);
  });

  it('un express viejo que pasa al reparto común empieza a contar desde el pase: el barrido no lo cancela', async () => {
    const d = await distribuidora();
    const o = await pedido(d, {
      availableSince: hace(500),
      deliveryMode: OrderDeliveryMode.EXPRESS,
      expressSurchargeAmount: 100,
      subtotalItems: 900,
    });

    expect(
      await env.app.get(ExpressDegradeService).pasarAlRepartoComun(o.orderId),
    ).not.toBeNull();

    expect(await vencimientos.vencer([d.id])).toBe(0);
    const fila = await ds
      .getRepository(Order)
      .findOneByOrFail({ orderId: o.orderId });
    expect(fila.status).toBe(OrderStatus.PENDING);
    expect(fila.deliveryMode).toBe(OrderDeliveryMode.STANDARD);
    expect(fila.availableSince?.getTime()).toBeGreaterThan(hace(1).getTime());
  });

  it('el tic del despacho lo vence', async () => {
    const d = await distribuidora();
    const o = await pedido(d, { availableSince: hace(200) });

    await env.app.get(DispatchService).tick();

    expect(await estado(o.orderId)).toBe(OrderStatus.CANCELLED);
  });
});
