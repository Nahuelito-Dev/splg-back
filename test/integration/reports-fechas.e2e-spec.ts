/**
 * Tests de integración: reportes y estadísticas interpretan los días en hora
 * argentina y con `to` inclusivo, igual que el listado de pedidos.
 */
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  sembrarClienteAutenticado,
  truncateAllTables,
} from './setup/test-env';
import { ReportsController } from '../../src/reports/reports.controller';
import { OrderService } from '../../src/order/order.service';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../src/order/entities/order.entity';
import { OrderItem } from '../../src/order/entities/order-item.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Granularidad } from '../../src/reports/dto/report-range-query.dto';

describe('Reportes y estadísticas en hora argentina (e2e)', () => {
  let env: TestEnv;
  let dataSource: DataSource;
  let reports: ReportsController;
  let orders: OrderService;
  let distributorId: string;
  let sembrarPedido: (
    estado: OrderStatus,
    creado: string,
    entregado: string | null,
  ) => Promise<void>;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
    reports = env.app.get(ReportsController);
    orders = env.app.get(OrderService);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
    const { user, distributor } = await sembrarClienteAutenticado(env.app);
    distributorId = distributor.distributorId;
    const cylinder = (await dataSource.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 100,
      weight: 10,
      isActive: true,
      distributorId,
    } as Partial<GasCylinder>)) as GasCylinder;
    const address = (await dataSource.getRepository(UserAddress).save({
      userId: user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;

    sembrarPedido = async (estado, creado, entregado) => {
      const pedido = (await dataSource.getRepository(Order).save({
        distributorId,
        customerId: user.userId,
        addressId: address.addressId,
        status: estado,
        paymentMethod: PaymentMethod.CASH,
        // Las ventas cuentan lo cobrado: el efectivo entregado ya confirmado.
        paymentStatus: PaymentStatus.PAID,
        subtotalItems: 1000,
        totalAmount: 1100, // 1000 de renglón + 100 de recargo
        deliveredAt: entregado ? new Date(entregado) : null,
        createdAt: new Date(creado),
      } as Partial<Order>)) as Order;
      await dataSource.getRepository(OrderItem).save({
        orderId: pedido.orderId,
        gasCylinderId: cylinder.gasCylinderId,
        quantity: 1,
        unitPrice: 1000,
        subtotal: 1000,
      } as Partial<OrderItem>);
    };

    // Entregados (instantes UTC): 23:59 ART del 6/7, 00:00 ART del 7/7,
    // 23:59 ART del 7/7 y 00:00 ART del 8/7.
    for (const iso of [
      '2026-07-07T02:59:00Z',
      '2026-07-07T03:00:00Z',
      '2026-07-08T02:59:00Z',
      '2026-07-08T03:00:00Z',
    ]) {
      await sembrarPedido(OrderStatus.DELIVERED, iso, iso);
    }
  });

  it('from = to = un día trae las ventas de ese día en todos los /reports/*', async () => {
    const rango = { from: '2026-07-07', to: '2026-07-07' };

    const porPago = await reports.getSalesByPayment(rango, distributorId);
    expect(porPago).toHaveLength(1);
    expect(porPago[0].totalOrders).toBe(2);
    expect(porPago[0].totalSales).toBe(2200);

    const porProducto = await reports.getSalesByProduct(rango, distributorId);
    expect(porProducto).toHaveLength(1);
    expect(porProducto[0].totalSales).toBe(2000); // subtotales, sin recargos

    const evolucion = await reports.getSalesEvolution(
      { ...rango, granularity: Granularidad.DIA },
      distributorId,
    );
    expect(evolucion).toHaveLength(1);
    expect(evolucion[0].totalOrders).toBe(2);
    expect(new Date(evolucion[0].period).toISOString()).toBe(
      '2026-07-07T03:00:00.000Z',
    );
  });

  it('el reporte cuenta por fecha de entrega y el listado por fecha de creación', async () => {
    // Creado 23:50 ART del 6/7, entregado 00:30 ART del 7/7.
    await sembrarPedido(
      OrderStatus.DELIVERED,
      '2026-07-07T02:50:00Z',
      '2026-07-07T03:30:00Z',
    );
    // Pendiente, creado el 7/7: no es una venta.
    await sembrarPedido(OrderStatus.PENDING, '2026-07-07T15:00:00Z', null);
    const rango = { from: '2026-07-07', to: '2026-07-07' };

    // Reporte: los 2 entregados del 7/7 + el creado el 6/7 y entregado el 7/7.
    const porPago = await reports.getSalesByPayment(rango, distributorId);
    expect(porPago[0].totalOrders).toBe(3);

    // Listado (por createdAt): los 2 creados el 7/7 que ya existían + el
    // pendiente; el creado el 6/7 queda afuera.
    const listado = await orders.findAll(
      { ...rango, limit: 50 } as never,
      distributorId,
    );
    expect(listado.total).toBe(3);
    const entregadosEnListado = listado.orders.filter(
      (o) => o.status === OrderStatus.DELIVERED,
    );
    expect(entregadosEnListado).toHaveLength(2);
  });

  it('sales-evolution agrupa por semana y mes en hora argentina', async () => {
    const semana = await reports.getSalesEvolution(
      {
        from: '2026-07-06',
        to: '2026-07-12',
        granularity: Granularidad.SEMANA,
      },
      distributorId,
    );
    // Lunes 6/7 00:00 ART = 03:00 UTC.
    expect(semana).toHaveLength(1);
    expect(new Date(semana[0].period).toISOString()).toBe(
      '2026-07-06T03:00:00.000Z',
    );
    expect(semana[0].totalOrders).toBe(4);

    const mes = await reports.getSalesEvolution(
      { from: '2026-06-30', to: '2026-07-31', granularity: Granularidad.MES },
      distributorId,
    );
    expect(mes).toHaveLength(1);
    expect(new Date(mes[0].period).toISOString()).toBe(
      '2026-07-01T03:00:00.000Z',
    );
    expect(mes[0].totalOrders).toBe(4);
  });

  it('getOrderStats cuenta "hoy" en hora argentina', async () => {
    // 22:00 ART del 7/7 = 01:00 UTC del 8/7: hoy sigue siendo el 7/7.
    jest.useFakeTimers({
      now: new Date('2026-07-08T01:00:00Z'),
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    try {
      const stats = await orders.getOrderStats(distributorId);
      expect(stats.ordersSummary.deliveredToday).toBe(2);
      expect(stats.sales.today).toBe(2200);
      expect(stats.sales.month).toBe(4400);
    } finally {
      jest.useRealTimers();
    }
  });
});
