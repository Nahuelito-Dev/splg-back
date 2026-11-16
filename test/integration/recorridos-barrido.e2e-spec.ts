/**
 * Integración (Postgres real): los pedidos que M4 retiene (programados dentro
 * del margen de espera) o que están en un lote vivo no llenan el barrido de M1
 * (que toma de a 50) ni el pool de pedidos disponibles; con M4 apagado el
 * resultado es el de siempre.
 */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { TestEnv, createTestApp, telefonoDePrueba } from './setup/test-env';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { TimeSlot } from '../../src/time-slot/entities/time-slot.entity';
import {
  ConfigurableProcess,
  ModuleConfig,
} from '../../src/distributor/entities/module-config.entity';
import {
  RouteBatch,
  RouteBatchStatus,
} from '../../src/order/entities/route-batch.entity';
import { RouteBatchStop } from '../../src/order/entities/route-batch-stop.entity';
import { RouteBatchCloseReason } from '../../src/order/entities/route-batch.entity';
import { RouteBatchService } from '../../src/route-batch/route-batch.service';
import { OrderService } from '../../src/order/order.service';
import { DispatchOfferRepositoryPort } from '../../src/order/domain/ports/dispatch-offer.repository.port';

const LAT = -27.38;
const LNG = -55.93;

describe('Recorridos: el barrido y el pool no cuentan lo retenido ni lo que está en un lote (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let orders: OrderService;
  let offers: DispatchOfferRepositoryPort;
  let recorridos: RouteBatchService;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    orders = env.app.get(OrderService);
    offers = env.app.get(DispatchOfferRepositoryPort);
    recorridos = env.app.get(RouteBatchService);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  async function escenario(m4: Record<string, number> | null) {
    const sufijo = randomUUID().slice(0, 8);
    const distributor = await ds.getRepository(Distributor).save({
      name: `Dist ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>);
    if (m4) {
      await ds.getRepository(ModuleConfig).save({
        distributorId: distributor.distributorId,
        module: ConfigurableProcess.ROUTE_BATCHING,
        params: m4,
      } as Partial<ModuleConfig>);
    }
    const slot = await ds.getRepository(TimeSlot).save({
      distributorId: distributor.distributorId,
      name: 'Mañana',
      startTime: '08:00',
      endTime: '12:00',
      capacity: 500,
    } as Partial<TimeSlot>);
    const cliente = await ds.getRepository(User).save({
      email: `cli-${sufijo}@splg.local`,
      fullName: 'Cliente',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>);
    const address = await ds.getRepository(UserAddress).save({
      userId: cliente.userId,
      street: 'Av. Test 123',
      city: 'Posadas',
      latitude: String(LAT),
      longitude: String(LNG),
    } as Partial<UserAddress>);
    const base = {
      customerId: cliente.userId,
      distributorId: distributor.distributorId,
      addressId: address.addressId,
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      totalAmount: 1000,
      subtotalItems: 1000,
      deliveryPoint: { type: 'Point', coordinates: [LNG, LAT] },
    };
    const dentroDeUnaSemana = new Date(Date.now() + 7 * 24 * 3600_000)
      .toISOString()
      .slice(0, 10);
    const orderRepo = ds.getRepository(Order);
    const programados: Order[] = [];
    for (let i = 0; i < 55; i++) {
      programados.push(
        await orderRepo.save({
          ...base,
          scheduledDate: dentroDeUnaSemana,
          timeSlotId: slot.timeSlotId,
        } as unknown as Partial<Order> as Order),
      );
    }
    // El inmediato es el más NUEVO: el barrido ordena por antigüedad y toma 50.
    const inmediato = await orderRepo.save({ ...base } as unknown as Order);
    return { distributor, programados, inmediato };
  }

  const barrido = (distributorId: string) =>
    orders.findAvailableOrders({ limit: 50, offset: 0 }, distributorId, true);

  it('con M4 encendido, 55 programados retenidos no tapan al pedido inmediato', async () => {
    const { distributor, inmediato } = await escenario({
      enabled: 1,
      batchingHoldMinutes: 60,
    });

    const { orders: lista, total } = await barrido(distributor.distributorId);

    expect(lista.map((o) => o.orderId)).toEqual([inmediato.orderId]);
    expect(total).toBe(1);
  }, 120000);

  it('pasado el margen M1 los toma como siempre (margen 0)', async () => {
    const { distributor } = await escenario({
      enabled: 1,
      batchingHoldMinutes: 0,
    });

    const { orders: lista, total } = await barrido(distributor.distributorId);

    expect(total).toBe(56);
    expect(lista).toHaveLength(50);
  }, 120000);

  it('con M4 apagado el barrido es el de siempre: los primeros 50 por antigüedad', async () => {
    const { distributor, programados } = await escenario(null);

    const { orders: lista, total } = await barrido(distributor.distributorId);

    expect(total).toBe(56);
    expect(lista.map((o) => o.orderId)).toEqual(
      programados.slice(0, 50).map((o) => o.orderId),
    );
  }, 120000);

  it('los pedidos de un lote vivo no están disponibles ni se dejan retener', async () => {
    const { distributor, programados } = await escenario(null);
    const lote = await ds.getRepository(RouteBatch).save({
      distributorId: distributor.distributorId,
      status: RouteBatchStatus.OFFERED,
      totalWeightKg: 20,
    } as Partial<RouteBatch>);
    await ds.getRepository(RouteBatchStop).save(
      programados.slice(0, 2).map((o, i) => ({
        batchId: lote.batchId,
        orderId: o.orderId,
        sequence: i + 1,
      })) as Array<Partial<RouteBatchStop>>,
    );

    const { orders: lista, total } = await barrido(distributor.distributorId);

    expect(total).toBe(54);
    expect(lista.map((o) => o.orderId)).not.toContain(programados[0].orderId);
    expect(await offers.isInLiveBatch(programados[0].orderId)).toBe(true);
    expect(await offers.isInLiveBatch(programados[2].orderId)).toBe(false);
  }, 120000);

  it('isHeldForBatching: encendido y lejos de la franja sí; apagado, no', async () => {
    const encendido = await escenario({ enabled: 1, batchingHoldMinutes: 60 });
    const apagado = await escenario(null);

    expect(
      await offers.isHeldForBatching(encendido.programados[0].orderId),
    ).toBe(true);
    expect(await offers.isHeldForBatching(encendido.inmediato.orderId)).toBe(
      false,
    );
    expect(await offers.isHeldForBatching(apagado.programados[0].orderId)).toBe(
      false,
    );
  }, 120000);

  it('M4 no vuelve a armar con un pedido de un lote agotado o deshecho por un administrador (consulta real)', async () => {
    const { distributor, programados } = await escenario({
      enabled: 1,
      batchingHoldMinutes: 60,
    });
    const cerrar = async (
      ids: string[],
      motivo: RouteBatchCloseReason,
    ): Promise<void> => {
      const lote = await ds.getRepository(RouteBatch).save({
        distributorId: distributor.distributorId,
        status: RouteBatchStatus.DISSOLVED,
        totalWeightKg: 10,
        closedAt: new Date(),
        closeReason: motivo,
      } as Partial<RouteBatch>);
      await ds.getRepository(RouteBatchStop).save(
        ids.map((orderId, i) => ({
          batchId: lote.batchId,
          orderId,
          sequence: i + 1,
          active: false,
        })) as Array<Partial<RouteBatchStop>>,
      );
    };
    await cerrar([programados[0].orderId], RouteBatchCloseReason.EXHAUSTED);
    await cerrar([programados[1].orderId], RouteBatchCloseReason.ADMIN);
    await cerrar(
      [programados[2].orderId],
      RouteBatchCloseReason.ORDERS_UNAVAILABLE,
    );

    const candidatos = await (
      recorridos as unknown as {
        candidatos(d: string, ahora: Date): Promise<Array<{ orderId: string }>>;
      }
    ).candidatos(distributor.distributorId, new Date());
    const ids = candidatos.map((c) => c.orderId);

    expect(ids).not.toContain(programados[0].orderId);
    expect(ids).not.toContain(programados[1].orderId);
    expect(ids).toContain(programados[2].orderId);
  }, 120000);
});
