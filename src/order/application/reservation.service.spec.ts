import { ReservationService } from './reservation.service';
import { Order, OrderStatus, PaymentMethod } from '../entities/order.entity';

/**
 * Foco: `expireUnpaidMercadoPagoOrders` (C4 — hardening). Pedidos NORMALES
 * (no reserva) con `paymentMethod=mercadopago` cuyo checkout nunca se pagó
 * quedan PENDING con stock reservado para siempre si nadie los expira (ver
 * `CreateOrderUseCase`, que reserva stock ANTES de que el cliente pague).
 * Este cron los cancela pasado el TTL y libera el stock — con especial
 * atención a la carrera pago-vs-expiración (idempotencia).
 */
describe('ReservationService.expireUnpaidMercadoPagoOrders', () => {
  let service: ReservationService;

  let orderRepository: { find: jest.Mock };
  let dataSource: any;
  let queryRunner: any;
  let queryBuilder: any;
  let lockedOrder: Partial<Order> | null;
  let stock: { restore: jest.Mock };
  let orders: { findByIdFull: jest.Mock };
  let dispatchOrchestrator: { offerToNextDriver: jest.Mock };

  const staleOrder = {
    order_id: 'ord-mp-1',
    status: OrderStatus.PENDING,
    paymentMethod: PaymentMethod.MERCADOPAGO,
    gatewayPaymentId: null,
    items: [{ gas_cylinder_id: 'gc-1', quantity: 2 }],
  } as unknown as Order;

  beforeEach(() => {
    lockedOrder = {
      order_id: 'ord-mp-1',
      status: OrderStatus.PENDING,
      gatewayPaymentId: null,
    };

    queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(lockedOrder)),
    };

    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        createQueryBuilder: jest.fn(() => queryBuilder),
        save: jest.fn(async (o: any) => o),
      },
    };
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

    orderRepository = { find: jest.fn().mockResolvedValue([]) };
    stock = { restore: jest.fn().mockResolvedValue(undefined) };
    orders = { findByIdFull: jest.fn() };
    dispatchOrchestrator = { offerToNextDriver: jest.fn() };

    service = new ReservationService(
      orderRepository as any,
      dataSource,
      orders as any,
      stock as any,
      dispatchOrchestrator as any,
    );
  });

  it('sin pedidos vencidos: no abre transacción', async () => {
    await service.expireUnpaidMercadoPagoOrders();

    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('busca PENDING + mercadopago + sin gatewayPaymentId, vencidos por TTL', async () => {
    orderRepository.find.mockResolvedValue([]);

    await service.expireUnpaidMercadoPagoOrders();

    expect(orderRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: OrderStatus.PENDING,
          paymentMethod: PaymentMethod.MERCADOPAGO,
        }),
      }),
    );
  });

  it('pedido vencido y sigue impago: cancela + restituye stock', async () => {
    orderRepository.find.mockResolvedValue([staleOrder]);

    await service.expireUnpaidMercadoPagoOrders();

    expect(queryRunner.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: OrderStatus.CANCELLED,
        order_id: 'ord-mp-1',
      }),
    );
    expect(stock.restore).toHaveBeenCalledWith(queryRunner.manager, [
      { gas_cylinder_id: 'gc-1', quantity: 2 },
    ]);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('carrera pago-vs-expiración: el webhook confirmó el pago justo antes → NO cancela ni toca stock', async () => {
    orderRepository.find.mockResolvedValue([staleOrder]);
    lockedOrder!.gatewayPaymentId = 'pay-ganó-la-carrera';

    await service.expireUnpaidMercadoPagoOrders();

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(stock.restore).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('el pedido ya no está PENDING (cancelado/despachado por otro flujo): no lo toca', async () => {
    orderRepository.find.mockResolvedValue([staleOrder]);
    lockedOrder!.status = OrderStatus.CANCELLED;

    await service.expireUnpaidMercadoPagoOrders();

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(stock.restore).not.toHaveBeenCalled();
  });

  it('el pedido desapareció entre la lectura y el lock: no revienta', async () => {
    orderRepository.find.mockResolvedValue([staleOrder]);
    lockedOrder = null;

    await expect(
      service.expireUnpaidMercadoPagoOrders(),
    ).resolves.not.toThrow();

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
  });

  it('error al guardar: hace rollback y no revienta el cron (sigue con el resto)', async () => {
    orderRepository.find.mockResolvedValue([staleOrder]);
    queryRunner.manager.save.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.expireUnpaidMercadoPagoOrders(),
    ).resolves.not.toThrow();

    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });
});
