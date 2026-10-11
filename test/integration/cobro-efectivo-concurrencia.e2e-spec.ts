/**
 * Tests de integración (Postgres real): el cobro en efectivo bajo concurrencia.
 *
 * Varios "el cliente no pagó" simultáneos para el mismo pedido (reintentos con
 * claves de idempotencia distintas, doble toque, dos dispositivos) tienen que
 * dejar UNA sola incidencia y UN solo aviso a los admins: la incidencia se
 * crea en la misma transacción que bloquea el pedido, y un índice único
 * parcial lo respalda.
 */
import { DataSource } from 'typeorm';
import { TestEnv, createTestApp, telefonoDePrueba } from './setup/test-env';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../src/order/entities/order.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import {
  Incident,
  IncidentStatus,
  IncidentType,
} from '../../src/incident/entities/incident.entity';
import { UnpaidCashService } from '../../src/incident/unpaid-cash.service';
import { CashCollectionUseCase } from '../../src/order/application/cash-collection.use-case';
import { ReportsService } from '../../src/reports/reports.service';
import { OrderService } from '../../src/order/order.service';
import { AdminGateway } from '../../src/gateways/admin.gateway';

describe('Cobro en efectivo: concurrencia (e2e, Postgres real)', () => {
  let env: TestEnv;
  let dataSource: DataSource;
  let unpaid: UnpaidCashService;
  let cash: CashCollectionUseCase;
  let reports: ReportsService;
  let orders: OrderService;
  let notify: jest.SpyInstance;
  let seq = 0;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
    unpaid = env.app.get(UnpaidCashService);
    cash = env.app.get(CashCollectionUseCase);
    reports = env.app.get(ReportsService);
    orders = env.app.get(OrderService);
    notify = jest
      .spyOn(env.app.get(AdminGateway), 'notifyAdmins')
      .mockImplementation(() => undefined);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(() => notify.mockClear());

  /** Pedido en efectivo ya entregado, con el pago pendiente, del chofer devuelto. */
  async function pedidoEntregado() {
    seq += 1;
    const sufijo = `${seq}-${Date.now()}`;
    const distributor = (await dataSource.getRepository(Distributor).save({
      name: `Distribuidora Cobro ${sufijo}`,
      slug: `dist-cobro-${sufijo}`,
      legalName: 'Test SRL',
      taxId: `30-${seq}${Date.now()}`,
      email: `dist-cobro${sufijo}@test.local`,
      phone: '+540000000000',
    } as Partial<Distributor>)) as Distributor;
    const chofer = (await dataSource.getRepository(User).save({
      email: `chofer-cobro-${sufijo}@splg.local`,
      fullName: 'Chofer Cobro',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    const delivery = (await dataSource.getRepository(Delivery).save({
      userId: chofer.userId,
      distributorId: distributor.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>)) as Delivery;
    const cliente = (await dataSource.getRepository(User).save({
      email: `cliente-cobro-${sufijo}@splg.local`,
      fullName: 'Cliente Cobro',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    await dataSource.getRepository(Customer).save({
      userId: cliente.userId,
      notificationToken: 'fake-fcm',
    } as Partial<Customer>);
    const address = (await dataSource.getRepository(UserAddress).save({
      userId: cliente.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;
    const order = (await dataSource.getRepository(Order).save({
      customerId: cliente.userId,
      distributorId: distributor.distributorId,
      addressId: address.addressId,
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      totalAmount: 1000,
      subtotalItems: 1000,
      deliveryId: delivery.deliveryId,
      acceptedAt: new Date(),
      deliveredAt: new Date(),
    } as Partial<Order>)) as Order;
    return { order, chofer, distributor };
  }

  const incidenciasDe = (orderId: string) =>
    dataSource.getRepository(Incident).find({ where: { orderId } });

  it('N "no pagó" simultáneos dejan UNA incidencia, UN aviso y el pago impago', async () => {
    const { order, chofer, distributor } = await pedidoEntregado();

    const resultados = await Promise.all(
      Array.from({ length: 10 }, () =>
        unpaid.report(
          order.orderId,
          { note: 'no pagó' },
          chofer.userId,
          distributor.distributorId,
        ),
      ),
    );

    const incidencias = await incidenciasDe(order.orderId);
    expect(incidencias).toHaveLength(1);
    expect(incidencias[0].type).toBe(IncidentType.UNPAID_COLLECTION);
    expect(new Set(resultados.map((r) => r.incident.incidentId)).size).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const guardado = await dataSource
      .getRepository(Order)
      .findOneOrFail({ where: { orderId: order.orderId } });
    expect(guardado.paymentStatus).toBe(PaymentStatus.UNPAID);
  }, 60000);

  it('N reintentos sobre un pedido ya impago y sin incidencia (sin nada que el UPDATE serialice) dejan UNA incidencia y UN aviso', async () => {
    const { order, chofer, distributor } = await pedidoEntregado();
    await dataSource
      .getRepository(Order)
      .update(
        { orderId: order.orderId },
        { paymentStatus: PaymentStatus.UNPAID },
      );

    await Promise.all(
      Array.from({ length: 10 }, () =>
        unpaid.report(
          order.orderId,
          {},
          chofer.userId,
          distributor.distributorId,
        ),
      ),
    );

    expect(await incidenciasDe(order.orderId)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  }, 60000);

  it('el índice único parcial respalda: una segunda incidencia viva del mismo pedido no entra, pero sí tras descartar la primera', async () => {
    const { order, chofer, distributor } = await pedidoEntregado();
    await unpaid.report(
      order.orderId,
      {},
      chofer.userId,
      distributor.distributorId,
    );
    const repo = dataSource.getRepository(Incident);
    const nueva = () =>
      repo.save(
        repo.create({
          orderId: order.orderId,
          distributorId: distributor.distributorId,
          reportedBy: chofer.userId,
          type: IncidentType.UNPAID_COLLECTION,
          description: 'duplicada',
          status: IncidentStatus.OPEN,
        }),
      );
    await expect(nueva()).rejects.toThrow(/UQ_incident_cobro_impago/);

    await repo.update(
      { orderId: order.orderId },
      { status: IncidentStatus.DISCARDED },
    );
    await expect(nueva()).resolves.toBeDefined();
  }, 60000);

  it('cobrado y "no pagó" a la vez: gana uno solo y el resultado es coherente', async () => {
    const { order, chofer, distributor } = await pedidoEntregado();

    const intentos = await Promise.allSettled([
      ...Array.from({ length: 4 }, () =>
        cash.confirmReceived(order.orderId, chofer.userId),
      ),
      ...Array.from({ length: 4 }, () =>
        unpaid.report(
          order.orderId,
          {},
          chofer.userId,
          distributor.distributorId,
        ),
      ),
    ]);

    const guardado = await dataSource
      .getRepository(Order)
      .findOneOrFail({ where: { orderId: order.orderId } });
    const incidencias = await incidenciasDe(order.orderId);
    if (guardado.paymentStatus === PaymentStatus.PAID) {
      expect(incidencias).toHaveLength(0);
      expect(guardado.paymentConfirmedBy).toBe(chofer.userId);
    } else {
      expect(guardado.paymentStatus).toBe(PaymentStatus.UNPAID);
      expect(incidencias).toHaveLength(1);
    }
    // Lo que perdió la carrera fue un 409 limpio, nunca un error de base.
    for (const i of intentos) {
      if (i.status === 'rejected') {
        expect((i.reason as { status?: number }).status).toBe(409);
      }
    }
  }, 60000);

  it('los reportes y las estadísticas cuentan lo cobrado; el resto va aparte', async () => {
    const { order, distributor } = await pedidoEntregado();
    const repo = dataSource.getRepository(Order);
    const copia = (
      paymentMethod: PaymentMethod,
      paymentStatus: PaymentStatus,
      totalAmount: number,
    ) =>
      repo.save({
        ...order,
        orderId: undefined,
        paymentMethod,
        paymentStatus,
        totalAmount,
        deliveredAt: new Date(),
      } as Partial<Order>);
    await copia(PaymentMethod.CASH, PaymentStatus.PAID, 100);
    await copia(PaymentMethod.TRANSFER, PaymentStatus.PENDING, 10);
    await copia(PaymentMethod.CASH, PaymentStatus.PENDING, 1000);
    await copia(PaymentMethod.CASH, PaymentStatus.UNPAID, 2000);
    await copia(PaymentMethod.CASH, PaymentStatus.WRITTEN_OFF, 4000);
    // El pedido base (efectivo, pendiente, 1000) también es "pendiente de confirmar".

    const desde = new Date(Date.now() - 24 * 3600 * 1000);
    const hasta = new Date(Date.now() + 24 * 3600 * 1000);
    const d = distributor.distributorId;

    const porMedio = await reports.getSalesByPaymentMethod(desde, hasta, d);
    const total = porMedio.reduce((a, f) => a + f.totalSales, 0);
    expect(total).toBe(110);

    const evolucion = await reports.getSalesEvolution(desde, hasta, 'day', d);
    expect(evolucion.reduce((a, f) => a + f.totalSales, 0)).toBe(110);

    const cobros = await reports.getCollections(desde, hasta, d);
    expect(cobros.pendingCash).toEqual({ totalOrders: 2, totalAmount: 2000 });
    expect(cobros.unpaid).toEqual({ totalOrders: 1, totalAmount: 2000 });
    expect(cobros.writtenOff).toEqual({ totalOrders: 1, totalAmount: 4000 });

    const stats = await orders.getOrderStats(d);
    expect(stats.sales.total).toBe(110);
    expect(stats.sales.month).toBe(110);
    const grafico = await orders.getSalesChartData(d);
    expect(grafico.reduce((a, p) => a + p.sales, 0)).toBe(110);

    const impagos = await orders.findAll(
      { paymentStatus: PaymentStatus.UNPAID } as never,
      d,
    );
    expect(impagos.total).toBe(1);
    const otraDistribuidora = await orders.findAll(
      { paymentStatus: PaymentStatus.UNPAID } as never,
      '00000000-0000-4000-8000-000000000000',
    );
    expect(otraDistribuidora.total).toBe(0);
  }, 60000);
});
