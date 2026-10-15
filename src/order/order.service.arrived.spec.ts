import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderService } from './order.service';
import { OrderStatus } from './entities/order.entity';
import { RoleType } from '../common/constants/role-type.enum';

/**
 * CU-011 (aviso de llegada). Fija dos reglas que la revisión del caso de uso
 * dejó anotadas como pendientes:
 *
 *  - un chofer solo puede avisar la llegada de un pedido asignado a ÉL;
 *  - el aviso sale por socket Y por push, y un fallo del push no rompe nada.
 *
 * Se arma el service a mano con dobles: acá solo interesa `notifyDriverArrived`,
 * y montar el módulo entero de Nest traería quince dependencias que no se usan.
 */
describe('OrderService · aviso de llegada', () => {
  const PEDIDO = 'f1f1f1f1-0000-4000-8000-000000000001';
  const CLIENTE = 'c1c1c1c1-0000-4000-8000-000000000002';
  const DELIVERY_ASIGNADO = 'd1d1d1d1-0000-4000-8000-000000000003';

  let dispatch: { notifyCustomer: jest.Mock };
  let notifications: { sendArrivalPushToCustomer: jest.Mock };
  let deliveries: {
    buscarPorIdOUsuario: jest.Mock;
    findById: jest.Mock;
    contarDisponibles: jest.Mock;
  };
  let service: OrderService;

  const pedidoEnCamino = () => ({
    orderId: PEDIDO,
    customerId: CLIENTE,
    deliveryId: DELIVERY_ASIGNADO,
    status: OrderStatus.ON_THE_WAY,
    delivery: { user: { fullName: 'Ana Gómez' } },
  });

  const armar = (
    pedido:
      | import('./entities/order.entity').Order
      | null = pedidoEnCamino() as unknown as import('./entities/order.entity').Order,
  ) => {
    dispatch = { notifyCustomer: jest.fn() };
    notifications = {
      sendArrivalPushToCustomer: jest.fn().mockResolvedValue(undefined),
    };
    deliveries = {
      buscarPorIdOUsuario: jest.fn(),
      findById: jest.fn(),
      contarDisponibles: jest.fn(),
    };

    service = new OrderService(
      {} as unknown as import('typeorm').Repository<
        import('./entities/order.entity').Order
      >,
      deliveries as unknown as import('../delivery/delivery.service').DeliveryService,
      dispatch as unknown as import('./domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      {} as unknown as import('./domain/ports/order.repository.port').OrderRepositoryPort,
      {} as unknown as import('./application/create-order.use-case').CreateOrderUseCase,
      {} as unknown as import('./application/update-order-status.use-case').UpdateOrderStatusUseCase,
      {} as unknown as import('./application/cancel-order.use-case').CancelOrderUseCase,
      {} as unknown as import('./application/confirm-delivery.use-case').ConfirmDeliveryUseCase,
      {} as unknown as import('./application/dispatch-orchestrator.service').DispatchOrchestratorService,
      {} as unknown as import('./domain/ports/dispatch-offer.repository.port').DispatchOfferRepositoryPort,
      notifications as unknown as import('./domain/ports/notification.port').NotificationPort,
      {} as unknown as import('typeorm').DataSource,
      {} as unknown as import('../fleet/fleet-dispatch-lock.service').FleetDispatchLockService,
      {
        assertPuedeAsignar: jest.fn().mockResolvedValue(undefined),
      } as unknown as import('./domain/ports/truck-load-gate.port').TruckLoadGatePort,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue(pedido!);
    return service;
  };

  it('rechaza al chofer que no tiene el pedido asignado', async () => {
    const s = armar();
    // El chofer existe, pero su delivery_id no es el del pedido.
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: 'otro-chofer',
    });

    await expect(
      s.notifyDriverArrived(PEDIDO, 'user-ajeno', RoleType.DELIVERY),
    ).rejects.toThrow(ForbiddenException);

    expect(dispatch.notifyCustomer).not.toHaveBeenCalled();
    expect(notifications.sendArrivalPushToCustomer).not.toHaveBeenCalled();
  });

  it('avisa por socket y por push cuando es el chofer asignado', async () => {
    const s = armar();
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: DELIVERY_ASIGNADO,
    });

    await expect(
      s.notifyDriverArrived(PEDIDO, 'user-asignado', RoleType.DELIVERY),
    ).resolves.toEqual({ message: 'Cliente notificado' });

    expect(dispatch.notifyCustomer).toHaveBeenCalledWith(
      CLIENTE,
      'order:arrived',
      expect.objectContaining({ orderId: PEDIDO, driverName: 'Ana Gómez' }),
    );
    expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledWith(
      CLIENTE,
      PEDIDO,
      'Ana Gómez',
    );
  });

  it('deja pasar al administrador sin mirar a qué chofer está asignado', async () => {
    const s = armar();

    await expect(
      s.notifyDriverArrived(PEDIDO, 'user-admin', RoleType.ADMIN),
    ).resolves.toEqual({ message: 'Cliente notificado' });

    expect(deliveries.buscarPorIdOUsuario).not.toHaveBeenCalled();
    expect(dispatch.notifyCustomer).toHaveBeenCalled();
  });

  it('no avisa si el pedido todavía no está en camino', async () => {
    const s = armar({
      ...pedidoEnCamino(),
      status: OrderStatus.ACCEPTED,
    } as unknown as import('./entities/order.entity').Order);
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: DELIVERY_ASIGNADO,
    });

    await expect(
      s.notifyDriverArrived(PEDIDO, 'user-asignado', RoleType.DELIVERY),
    ).rejects.toThrow(BadRequestException);

    expect(dispatch.notifyCustomer).not.toHaveBeenCalled();
  });

  it('usa un nombre genérico si el pedido no trae los datos del chofer', async () => {
    const s = armar({
      ...pedidoEnCamino(),
      delivery: null,
    } as unknown as import('./entities/order.entity').Order);

    await s.notifyDriverArrived(PEDIDO, 'user-admin', RoleType.ADMIN);

    expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledWith(
      CLIENTE,
      PEDIDO,
      'El repartidor',
    );
  });
});
