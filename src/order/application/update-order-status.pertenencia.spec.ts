import { ForbiddenException } from '@nestjs/common';
import { UpdateOrderStatusUseCase } from './update-order-status.use-case';
import { OrderStatus } from '../entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';

/**
 * Un chofer solo puede mover pedidos que ya son suyos.
 *
 * Sin esta regla, cualquier chofer autenticado podía cerrar la entrega de un
 * pedido ajeno —y, si el pago era en efectivo, darlo por cobrado— o quedarse
 * con uno que el despacho ya le había ofrecido a otro.
 */
describe('UpdateOrderStatusUseCase · pertenencia del pedido', () => {
  const DELIVERY_ASIGNADO = 'd1d1d1d1-0000-4000-8000-000000000001';
  const DELIVERY_AJENO = 'd2d2d2d2-0000-4000-8000-000000000002';

  let deliveries: {
    buscarPorIdOUsuario: jest.Mock;
    assertElegibleParaAsignacion: jest.Mock;
  };
  let orders: { findByIdFull: jest.Mock; save: jest.Mock };
  let uc: UpdateOrderStatusUseCase;

  const armar = (
    deliveryId: string | null,
    status = OrderStatus.ON_THE_WAY,
  ) => {
    const order = {
      orderId: 'f1f1f1f1-0000-4000-8000-000000000003',
      customerId: 'c1c1c1c1-0000-4000-8000-000000000004',
      deliveryId,
      status,
      items: [],
    };
    deliveries = {
      buscarPorIdOUsuario: jest.fn(),
      assertElegibleParaAsignacion: jest.fn(),
    };
    orders = {
      findByIdFull: jest.fn().mockResolvedValue(order),
      save: jest.fn((o: unknown) => Promise.resolve(o)),
    };

    uc = new UpdateOrderStatusUseCase(
      deliveries as unknown as import('../../delivery/delivery.service').DeliveryService,
      {
        notifyCustomer: jest.fn(),
        notifyAdmins: jest.fn(),
      } as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      {
        sendOrderConfirmation: jest.fn().mockResolvedValue({ success: true }),
      } as unknown as import('../domain/ports/notification.port').NotificationPort,
      orders as unknown as import('../domain/ports/order.repository.port').OrderRepositoryPort,
      {
        onDriverAccepted: jest.fn().mockResolvedValue(undefined),
      } as unknown as import('./dispatch-orchestrator.service').DispatchOrchestratorService,
      {
        onOrderDelivered: jest.fn().mockResolvedValue(undefined),
      } as unknown as import('../domain/ports/cylinder-lifecycle.port').CylinderLifecyclePort,
    );
    return order;
  };

  it('rechaza al chofer que no tiene el pedido asignado', async () => {
    armar(DELIVERY_ASIGNADO);
    // El que llama existe como chofer, pero es otro.
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: DELIVERY_AJENO,
      userId: 'user-ajeno',
    });

    await expect(
      uc.execute(
        'f1f1f1f1-0000-4000-8000-000000000003',
        OrderStatus.DELIVERED,
        'user-ajeno',
        RoleType.DELIVERY,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(orders.save).not.toHaveBeenCalled();
  });

  it('no verifica nada si el pedido todavía no tiene chofer: aceptarlo es cómo se asigna', async () => {
    armar(null, OrderStatus.PENDING);
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: DELIVERY_ASIGNADO,
      userId: 'user-nuevo',
      isEnabled: true,
      validated: true,
      user: { fullName: 'Chofer' },
    });

    await expect(
      uc.execute(
        'f1f1f1f1-0000-4000-8000-000000000003',
        OrderStatus.ACCEPTED,
        'user-nuevo',
        RoleType.DELIVERY,
      ),
    ).resolves.toBeDefined();

    expect(orders.save).toHaveBeenCalled();
  });

  it('impide que un chofer se quede con un pedido ya asignado a otro', async () => {
    armar(DELIVERY_ASIGNADO, OrderStatus.PENDING);
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: DELIVERY_AJENO,
      userId: 'user-ajeno',
      isEnabled: true,
      validated: true,
    });

    await expect(
      uc.execute(
        'f1f1f1f1-0000-4000-8000-000000000003',
        OrderStatus.ACCEPTED,
        'user-ajeno',
        RoleType.DELIVERY,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('deja pasar al administrador sin mirar a qué chofer está asignado', async () => {
    armar(DELIVERY_ASIGNADO);

    await expect(
      uc.execute(
        'f1f1f1f1-0000-4000-8000-000000000003',
        OrderStatus.DELIVERED,
        undefined,
        RoleType.ADMIN,
      ),
    ).resolves.toBeDefined();

    // El pedido avanza: al administrador la verificación no lo frena. (El
    // repositorio de choferes sí se consulta, pero para armar el aviso de
    // tiempo real, no para decidir el permiso.)
    expect(orders.save).toHaveBeenCalled();
  });
});
