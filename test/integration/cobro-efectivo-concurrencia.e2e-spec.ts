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
import { IncidentService } from '../../src/incident/incident.service';
import { UnpaidCashService } from '../../src/incident/unpaid-cash.service';
import { CashCollectionUseCase } from '../../src/order/application/cash-collection.use-case';
import { ReportsService } from '../../src/reports/reports.service';
import { OrderService } from '../../src/order/order.service';
import { AdminGateway } from '../../src/gateways/admin.gateway';
import { fechasDeEntrega } from './setup/pedido-valido';

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
      ...fechasDeEntrega(),
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
    // Gane quien gane la carrera, el pedido queda en uno de los dos finales coherentes.
    const pagado = guardado.paymentStatus === PaymentStatus.PAID;
    expect({
      estado: guardado.paymentStatus,
      incidencias: incidencias.length,
      confirmadoPor: pagado ? guardado.paymentConfirmedBy : null,
    }).toEqual(
      pagado
        ? {
            estado: PaymentStatus.PAID,
            incidencias: 0,
            confirmadoPor: chofer.userId,
          }
        : { estado: PaymentStatus.UNPAID, incidencias: 1, confirmadoPor: null },
    );
    // Lo que perdió la carrera fue un 409 limpio, nunca un error de base.
    const rechazos = intentos
      .filter((i): i is PromiseRejectedResult => i.status === 'rejected')
      .map((i) => (i.reason as { status?: number }).status);
    expect(rechazos).toEqual(rechazos.map(() => 409));
  }, 60000);

  it('los reportes y las estadísticas cuentan sólo lo pagado (la transferencia pendiente no); el resto va aparte', async () => {
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
    expect(total).toBe(100);

    const evolucion = await reports.getSalesEvolution(desde, hasta, 'day', d);
    expect(evolucion.reduce((a, f) => a + f.totalSales, 0)).toBe(100);

    const cobros = await reports.getCollections(desde, hasta, d);
    expect(cobros.pendingCash).toEqual({ totalOrders: 2, totalAmount: 2000 });
    expect(cobros.unpaid).toEqual({ totalOrders: 1, totalAmount: 2000 });
    expect(cobros.writtenOff).toEqual({ totalOrders: 1, totalAmount: 4000 });

    const stats = await orders.getOrderStats(d);
    expect(stats.sales.total).toBe(100);
    expect(stats.sales.month).toBe(100);
    const grafico = await orders.getSalesChartData(d);
    expect(grafico.reduce((a, p) => a + p.sales, 0)).toBe(100);

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

  /** Pedido impago con su incidencia abierta, listo para que un admin lo resuelva. */
  async function pedidoImpago() {
    const base = await pedidoEntregado();
    await unpaid.report(
      base.order.orderId,
      { note: 'no pagó' },
      base.chofer.userId,
      base.distributor.distributorId,
    );
    const admin = (await dataSource.getRepository(User).save({
      email: `admin-cobro-${Date.now()}-${seq}@splg.local`,
      fullName: 'Admin Cobro',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    const admin2 = (await dataSource.getRepository(User).save({
      email: `admin2-cobro-${Date.now()}-${seq}@splg.local`,
      fullName: 'Admin Dos',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    return { ...base, admin, admin2 };
  }

  const pedidoGuardado = (orderId: string) =>
    dataSource.getRepository(Order).findOneOrFail({ where: { orderId } });

  it('dos admins resuelven a la vez: una sola resolución y la incidencia queda coherente con el pedido', async () => {
    const { order, admin, admin2 } = await pedidoImpago();

    const [a, b] = await Promise.all([
      cash.resolveUnpaid(order.orderId, admin.userId, 'written_off', 'nota A'),
      cash.resolveUnpaid(order.orderId, admin2.userId, 'written_off', 'nota B'),
    ]);

    expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1);
    const guardado = await pedidoGuardado(order.orderId);
    const [inc] = await incidenciasDe(order.orderId);
    expect(guardado.paymentStatus).toBe(PaymentStatus.WRITTEN_OFF);
    expect(inc.status).toBe(IncidentStatus.RESOLVED);
    expect(inc.resolutionNote).toBe(guardado.paymentResolutionNote);
    expect(inc.resolvedAt).toBeInstanceOf(Date);
    expect(guardado.paymentResolvedBy).toBe(
      a.changed ? admin.userId : admin2.userId,
    );
    // Una pérdida no es un cobro.
    expect(guardado.paymentConfirmedAt).toBeNull();
    expect(guardado.paymentConfirmedBy).toBeNull();
  }, 60000);

  it('repetir la resolución no pisa ni la nota del pedido ni la de la incidencia', async () => {
    const { order, admin, admin2 } = await pedidoImpago();
    await cash.resolveUnpaid(order.orderId, admin.userId, 'paid', 'primera');
    const antes = await pedidoGuardado(order.orderId);
    const [incAntes] = await incidenciasDe(order.orderId);

    const r = await cash.resolveUnpaid(
      order.orderId,
      admin2.userId,
      'paid',
      'segunda',
    );

    expect(r.changed).toBe(false);
    const despues = await pedidoGuardado(order.orderId);
    const [incDespues] = await incidenciasDe(order.orderId);
    expect(despues.paymentResolutionNote).toBe('primera');
    expect(despues.paymentResolvedBy).toBe(antes.paymentResolvedBy);
    expect(despues.paymentConfirmedBy).toBe(admin.userId);
    expect(incDespues.resolutionNote).toBe('primera');
    expect(incDespues.resolvedAt?.getTime()).toBe(
      incAntes.resolvedAt?.getTime(),
    );
  }, 60000);

  it('la puerta genérica de incidencias da 409 mientras el pedido siga impago, y no pisa la ya resuelta', async () => {
    const { order, admin } = await pedidoImpago();
    const incidents = env.app.get(IncidentService);
    const [inc] = await incidenciasDe(order.orderId);

    await expect(
      incidents.resolve(inc.incidentId, { resolutionNote: 'por la puerta' }),
    ).rejects.toThrow(/resolve-unpaid/);
    expect((await incidenciasDe(order.orderId))[0].status).toBe(
      IncidentStatus.OPEN,
    );

    await cash.resolveUnpaid(order.orderId, admin.userId, 'paid', 'cobrado');
    await expect(
      incidents.resolve(inc.incidentId, { resolutionNote: 'pisa' }),
    ).rejects.toThrow(/ya está resuelta/);
    expect((await incidenciasDe(order.orderId))[0].resolutionNote).toBe(
      'cobrado',
    );
  }, 60000);
});
