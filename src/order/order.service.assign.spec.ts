import { OrderService } from './order.service';
import { Order, OrderStatus } from './entities/order.entity';
import type { Repository } from 'typeorm';
import type { DeliveryService } from '../delivery/delivery.service';
import type { RealtimeDispatchPort } from './domain/ports/realtime-dispatch.port';
import type { OrderRepositoryPort } from './domain/ports/order.repository.port';
import type { CreateOrderUseCase } from './application/create-order.use-case';
import type { UpdateOrderStatusUseCase } from './application/update-order-status.use-case';
import type { CancelOrderUseCase } from './application/cancel-order.use-case';
import type { ConfirmDeliveryUseCase } from './application/confirm-delivery.use-case';
import type { DispatchOrchestratorService } from './application/dispatch-orchestrator.service';
import type { NotificationPort } from './domain/ports/notification.port';

/**
 * Asignación manual desde el panel (`PATCH /orders/:id/assign/:deliveryId`).
 * Tiene que dejar el pedido igual que cuando el chofer acepta la oferta: con
 * código de entrega para el QR y avisando al panel en vivo.
 */
describe('OrderService · asignación manual', () => {
  const PEDIDO = 'f1f1f1f1-0000-4000-8000-000000000002';
  const CHOFER = 'd1d1d1d1-0000-4000-8000-000000000004';

  let pedido: Order;
  let dispatch: { notifyAdmins: jest.Mock };
  let repo: { save: jest.Mock };
  let service: OrderService;

  beforeEach(() => {
    pedido = {
      orderId: PEDIDO,
      distributorId: 'dist',
      status: OrderStatus.PENDING,
      totalAmount: 9900,
      deliveryCode: null,
    } as unknown as Order;
    dispatch = { notifyAdmins: jest.fn() };
    repo = { save: jest.fn() };
    const deliveries = {
      findById: jest
        .fn()
        .mockResolvedValue({ deliveryId: CHOFER, distributorId: 'dist' }),
      assertElegibleParaAsignacion: jest.fn(),
    };
    service = new OrderService(
      repo as unknown as Repository<Order>,
      deliveries as unknown as DeliveryService,
      dispatch as unknown as RealtimeDispatchPort,
      {} as unknown as OrderRepositoryPort,
      {} as unknown as CreateOrderUseCase,
      {} as unknown as UpdateOrderStatusUseCase,
      {} as unknown as CancelOrderUseCase,
      {} as unknown as ConfirmDeliveryUseCase,
      {} as unknown as DispatchOrchestratorService,
      {} as unknown as NotificationPort,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue(pedido);
  });

  it('genera el código de entrega para el QR', async () => {
    await service.assignDelivery(PEDIDO, CHOFER);
    expect(pedido.status).toBe(OrderStatus.ACCEPTED);
    expect(pedido.deliveryCode).toMatch(/\S{4,}/);
    expect(repo.save).toHaveBeenCalledWith(pedido);
  });

  it('reasignar genera un código nuevo: el del chofer anterior deja de servir', async () => {
    await service.assignDelivery(PEDIDO, CHOFER);
    const primero = pedido.deliveryCode;
    await service.assignDelivery(PEDIDO, CHOFER);
    expect(pedido.deliveryCode).not.toBe(primero);
  });

  it('avisa al panel en vivo', async () => {
    await service.assignDelivery(PEDIDO, CHOFER);
    expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
      'order:accepted',
      expect.objectContaining({ orderId: PEDIDO }),
    );
  });
});
