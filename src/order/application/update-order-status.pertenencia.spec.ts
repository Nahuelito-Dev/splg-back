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
 *
 * `execute()` para ACCEPTED/ON_THE_WAY/DELIVERED re-lee el pedido con lock
 * pesimista (segunda revisión, punto 2): el mock de `DataSource` imita ese
 * query builder, así que `armar()` devuelve el MISMO objeto que entrega el
 * lock (no hace falta duplicar `findByIdFull`/`save` del puerto para este
 * tramo).
 */
describe('UpdateOrderStatusUseCase · pertenencia del pedido', () => {
  const DELIVERY_ASIGNADO = 'd1d1d1d1-0000-4000-8000-000000000001';
  const DELIVERY_AJENO = 'd2d2d2d2-0000-4000-8000-000000000002';

  let deliveries: {
    buscarPorIdOUsuario: jest.Mock;
    assertElegibleParaAsignacion: jest.Mock;
  };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    isTransactionActive: boolean;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: {
      createQueryBuilder: jest.Mock;
      save: jest.Mock;
      query: jest.Mock;
    };
  };
  let queryBuilder: {
    setLock: jest.Mock;
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
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
    queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve({ ...order })),
    };
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: true,
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        // El lock del chofer (`bloquearChoferes`): todos los pedidos existen y están vigentes.
        query: jest.fn((_sql: string, [ids]: [string[]]) =>
          Promise.resolve(
            ids.map((id) => ({ delivery_id: id, deleted: false })),
          ),
        ),
        createQueryBuilder: jest.fn(() => queryBuilder),
        save: jest.fn((o: unknown) => Promise.resolve(o)),
      },
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };

    uc = new UpdateOrderStatusUseCase(
      dataSource as unknown as import('typeorm').DataSource,
      deliveries as unknown as import('../../delivery/delivery.service').DeliveryService,
      {
        notifyCustomer: jest.fn(),
        notifyAdmins: jest.fn(),
      } as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      {
        sendOrderConfirmation: jest.fn().mockResolvedValue({ success: true }),
      } as unknown as import('../domain/ports/notification.port').NotificationPort,
      {
        findByIdFull: jest.fn().mockResolvedValue(order),
      } as unknown as import('../domain/ports/order.repository.port').OrderRepositoryPort,
      {
        onDriverAccepted: jest.fn().mockResolvedValue(undefined),
      } as unknown as import('./dispatch-orchestrator.service').DispatchOrchestratorService,
      {
        onOrderDelivered: jest.fn().mockResolvedValue(undefined),
      } as unknown as import('../domain/ports/cylinder-lifecycle.port').CylinderLifecyclePort,
      {
        execute: jest.fn(),
      } as unknown as import('./cancel-order.use-case').CancelOrderUseCase,
      {
        execute: jest.fn(),
      } as unknown as import('./release-order.use-case').ReleaseOrderUseCase,
      {
        assertChoferHabilitado: jest.fn().mockResolvedValue(undefined),
        vehiculoEnUsoDelChofer: jest.fn().mockResolvedValue(null),
      } as unknown as import('../../fleet/fleet-dispatch-lock.service').FleetDispatchLockService,
      {
        onOrderDelivered: jest.fn().mockResolvedValue(undefined),
      } as unknown as import('../domain/ports/stock-delivery.port').StockDeliveryPort,
    );
    return { order, queryRunner, queryBuilder };
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
        OrderStatus.ON_THE_WAY,
        'user-ajeno',
        RoleType.DELIVERY,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
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

    expect(queryRunner.manager.save).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
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

  it('el chofer asignado NO puede marcar delivered: la entrega se confirma con el QR del cliente', async () => {
    armar(DELIVERY_ASIGNADO);
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: DELIVERY_ASIGNADO,
      userId: 'user-asignado',
    });

    await expect(
      uc.execute(
        'f1f1f1f1-0000-4000-8000-000000000003',
        OrderStatus.DELIVERED,
        'user-asignado',
        RoleType.DELIVERY,
      ),
    ).rejects.toThrow('La entrega se confirma con el QR del cliente');

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('la entrega sin rol (la que dispara confirm-delivery con el QR válido) sí avanza', async () => {
    armar(DELIVERY_ASIGNADO);

    await expect(
      uc.execute('f1f1f1f1-0000-4000-8000-000000000003', OrderStatus.DELIVERED),
    ).resolves.toBeDefined();

    expect(queryRunner.commitTransaction).toHaveBeenCalled();
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
    expect(queryRunner.manager.save).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });
});
