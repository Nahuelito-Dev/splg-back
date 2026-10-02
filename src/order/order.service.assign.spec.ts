import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderService } from './order.service';
import { Order, OrderStatus } from './entities/order.entity';
import { DispatchOfferStatus } from './entities/dispatch-offer.entity';
import type { Repository, DataSource } from 'typeorm';
import type { DeliveryService } from '../delivery/delivery.service';
import type { RealtimeDispatchPort } from './domain/ports/realtime-dispatch.port';
import type { OrderRepositoryPort } from './domain/ports/order.repository.port';
import type { CreateOrderUseCase } from './application/create-order.use-case';
import type { UpdateOrderStatusUseCase } from './application/update-order-status.use-case';
import type { CancelOrderUseCase } from './application/cancel-order.use-case';
import type { ConfirmDeliveryUseCase } from './application/confirm-delivery.use-case';
import type { DispatchOrchestratorService } from './application/dispatch-orchestrator.service';
import type { DispatchOfferRepositoryPort } from './domain/ports/dispatch-offer.repository.port';
import type { NotificationPort } from './domain/ports/notification.port';
import type { FleetDispatchLockService } from '../fleet/fleet-dispatch-lock.service';

/**
 * Asignación manual desde el panel (`PATCH /orders/:id/assign/:deliveryId`).
 * Tiene que dejar el pedido igual que cuando el chofer acepta la oferta: con
 * código de entrega para el QR y avisando al panel en vivo. Segunda revisión:
 * lock pesimista (punto 2), cierra ofertas en curso del pedido (punto 5) y
 * avisa al chofer anterior si reasigna (punto 7).
 */
describe('OrderService · asignación manual', () => {
  const PEDIDO = 'f1f1f1f1-0000-4000-8000-000000000002';
  const CHOFER = 'd1d1d1d1-0000-4000-8000-000000000004';
  const CHOFER_B = 'd2d2d2d2-0000-4000-8000-000000000006';

  const CHOFER_USER_ID = 'u1u1u1u1-0000-4000-8000-000000000005';
  const CHOFER_B_USER_ID = 'u2u2u2u2-0000-4000-8000-000000000007';

  let dispatch: {
    notifyAdmins: jest.Mock;
    notifyDriverNewOrder: jest.Mock;
    notifyDriverOrderCancelled: jest.Mock;
    stopTracking: jest.Mock;
  };
  let dispatchOffers: { closeAllActiveOffers: jest.Mock };
  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: {
      createQueryBuilder: jest.Mock;
      save: jest.Mock<Promise<Order>, [Order]>;
      query: jest.Mock;
    };
  };
  let queryBuilder: {
    setLock: jest.Mock;
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
  let fleetGate: {
    assertChoferHabilitado: jest.Mock;
    vehiculoEnUsoDelChofer: jest.Mock;
  };
  let service: OrderService;

  const CHOFERES: Record<
    string,
    { deliveryId: string; distributorId: string; userId: string }
  > = {
    [CHOFER]: {
      deliveryId: CHOFER,
      distributorId: 'dist',
      userId: CHOFER_USER_ID,
    },
    [CHOFER_B]: {
      deliveryId: CHOFER_B,
      distributorId: 'dist',
      userId: CHOFER_B_USER_ID,
    },
  };

  /** El pedido tal como lo trae el lock: sin chofer previo, salvo que se pase uno. */
  const makeLockedOrder = (over: Partial<Order> = {}): Order =>
    ({
      orderId: PEDIDO,
      distributorId: 'dist',
      status: OrderStatus.PENDING,
      totalAmount: 9900,
      paymentMethod: 'cash',
      items: [],
      deliveryCode: null,
      delivery: null,
      ...over,
    }) as unknown as Order;

  beforeEach(() => {
    queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(makeLockedOrder())),
    };
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
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
        // Devuelve lo mismo que se guardó, como hace TypeORM.
        save: jest.fn((o: Order) => Promise.resolve(o)),
      },
    };
    dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };
    dispatch = {
      notifyAdmins: jest.fn(),
      notifyDriverNewOrder: jest.fn(),
      notifyDriverOrderCancelled: jest.fn(),
      stopTracking: jest.fn(),
    };
    dispatchOffers = {
      closeAllActiveOffers: jest.fn().mockResolvedValue(0),
    };
    const deliveries = {
      findById: jest.fn((id: string) => Promise.resolve(CHOFERES[id])),
      assertElegibleParaAsignacion: jest.fn(),
    };
    fleetGate = {
      assertChoferHabilitado: jest.fn().mockResolvedValue(undefined),
      vehiculoEnUsoDelChofer: jest.fn().mockResolvedValue({
        carId: 'car-1',
        patent: 'AB123CD',
        brand: 'Honda',
        model: 'Wave',
      }),
    };
    service = new OrderService(
      {} as unknown as Repository<Order>,
      deliveries as unknown as DeliveryService,
      dispatch as unknown as RealtimeDispatchPort,
      {} as unknown as OrderRepositoryPort,
      {} as unknown as CreateOrderUseCase,
      {} as unknown as UpdateOrderStatusUseCase,
      {} as unknown as CancelOrderUseCase,
      {} as unknown as ConfirmDeliveryUseCase,
      {} as unknown as DispatchOrchestratorService,
      dispatchOffers as unknown as DispatchOfferRepositoryPort,
      {} as unknown as NotificationPort,
      dataSource as unknown as DataSource,
      fleetGate as unknown as FleetDispatchLockService,
    );
    // La respuesta final releé el pedido; en vez de volver a pedir el lock
    // (consumiría la cola de `mockResolvedValueOnce` de cada test), devuelve
    // lo que efectivamente se guardó — el mock de `save` ya hace de espejo.
    jest.spyOn(service, 'findOne').mockImplementation(() => {
      const calls = queryRunner.manager.save.mock.calls;
      return Promise.resolve(calls[calls.length - 1][0]);
    });
  });

  it('genera el código de entrega para el QR', async () => {
    const result = await service.assignDelivery(PEDIDO, CHOFER);
    expect(result.status).toBe(OrderStatus.ACCEPTED);
    expect(result.deliveryCode).toMatch(/\S{4,}/);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('guarda el snapshot del vehículo en uso (decisión de nahue, "vehículo en uso")', async () => {
    const result = await service.assignDelivery(PEDIDO, CHOFER);
    expect(fleetGate.vehiculoEnUsoDelChofer).toHaveBeenCalledWith(
      CHOFER_USER_ID,
      'dist',
    );
    expect(result).toMatchObject({
      vehicleCarId: 'car-1',
      vehiclePatent: 'AB123CD',
      vehicleBrand: 'Honda',
      vehicleModel: 'Wave',
    });
  });

  it('reasignar genera un código nuevo: el del chofer anterior deja de servir', async () => {
    queryBuilder.getOne.mockResolvedValueOnce(makeLockedOrder());
    const primero = (await service.assignDelivery(PEDIDO, CHOFER)).deliveryCode;

    queryBuilder.getOne.mockResolvedValueOnce(
      makeLockedOrder({
        status: OrderStatus.ACCEPTED,
        deliveryId: CHOFER,
        delivery: { deliveryId: CHOFER, userId: CHOFER_USER_ID } as never,
      }),
    );
    const segundo = (await service.assignDelivery(PEDIDO, CHOFER)).deliveryCode;

    expect(segundo).not.toBe(primero);
  });

  it('reasignar de un chofer A a otro B actualiza la relación `delivery`, no sólo `deliveryId` (punto 8)', async () => {
    queryBuilder.getOne.mockResolvedValueOnce(
      makeLockedOrder({
        status: OrderStatus.ACCEPTED,
        deliveryId: CHOFER,
        delivery: { deliveryId: CHOFER, userId: CHOFER_USER_ID } as never,
      }),
    );

    const result = await service.assignDelivery(PEDIDO, CHOFER_B);

    // `order.delivery` (la relación @ManyToOne) tiene que quedar sincronizada
    // con `order.deliveryId` (la columna): son la MISMA columna FK, y si
    // sólo se pisa `deliveryId` TypeORM prioriza la relación vieja al
    // guardar (verificado contra la base real, ver release-driver-assignment
    // y el mismo fix acá).
    expect(result.deliveryId).toBe(CHOFER_B);
    expect(result.delivery?.deliveryId).toBe(CHOFER_B);
  });

  it('avisa al panel en vivo (a la sala de la distribuidora del pedido)', async () => {
    await service.assignDelivery(PEDIDO, CHOFER);
    expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
      'order:accepted',
      expect.objectContaining({ orderId: PEDIDO }),
      'dist',
    );
  });

  it('H-55: avisa al chofer por socket, igual que el despacho automático', async () => {
    await service.assignDelivery(PEDIDO, CHOFER);

    expect(dispatch.notifyDriverNewOrder).toHaveBeenCalledWith(
      CHOFER_USER_ID,
      expect.objectContaining({
        event: 'NEW_ORDER',
        orderId: PEDIDO,
        totalAmount: 9900,
      }),
    );
  });

  it('punto 2 (segunda revisión): usa el MISMO lock pesimista que cancelar/liberar', async () => {
    await service.assignDelivery(PEDIDO, CHOFER);

    expect(dataSource.createQueryRunner).toHaveBeenCalled();
    expect(queryRunner.startTransaction).toHaveBeenCalled();
    expect(queryBuilder.setLock).toHaveBeenCalledWith(
      'pessimistic_write',
      undefined,
      ['ord'],
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });

  it('punto 2: si el pedido ya está CANCELLED (cancelación concurrente), corta con 400 y hace rollback', async () => {
    queryBuilder.getOne.mockResolvedValue(
      makeLockedOrder({ status: OrderStatus.CANCELLED }),
    );

    await expect(service.assignDelivery(PEDIDO, CHOFER)).rejects.toThrow();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(dispatch.notifyDriverNewOrder).not.toHaveBeenCalled();
  });

  it('pedido inexistente: 404 dentro de la transacción', async () => {
    queryBuilder.getOne.mockResolvedValue(null);

    await expect(service.assignDelivery(PEDIDO, CHOFER)).rejects.toThrow(
      NotFoundException,
    );
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('punto 5 (segunda revisión): cierra cualquier oferta automática en curso del pedido al asignar a mano', async () => {
    await service.assignDelivery(PEDIDO, CHOFER);

    expect(dispatchOffers.closeAllActiveOffers).toHaveBeenCalledWith(
      PEDIDO,
      DispatchOfferStatus.EXPIRED,
    );
  });

  it('punto 7 (segunda revisión): reasignar de A a B avisa al chofer A (ya no es suyo)', async () => {
    queryBuilder.getOne.mockResolvedValueOnce(
      makeLockedOrder({
        status: OrderStatus.ACCEPTED,
        deliveryId: CHOFER,
        delivery: { deliveryId: CHOFER, userId: CHOFER_USER_ID } as never,
      }),
    );

    await service.assignDelivery(PEDIDO, CHOFER_B);

    expect(dispatch.stopTracking).toHaveBeenCalledWith(CHOFER_USER_ID);
    expect(dispatch.notifyDriverOrderCancelled).toHaveBeenCalledWith(
      CHOFER_USER_ID,
      expect.objectContaining({ orderId: PEDIDO }),
    );
  });

  it('punto 7: asignar al MISMO chofer que ya lo tenía no le avisa a "sí mismo"', async () => {
    queryBuilder.getOne.mockResolvedValueOnce(
      makeLockedOrder({
        status: OrderStatus.ACCEPTED,
        deliveryId: CHOFER,
        delivery: { deliveryId: CHOFER, userId: CHOFER_USER_ID } as never,
      }),
    );

    await service.assignDelivery(PEDIDO, CHOFER);

    expect(dispatch.notifyDriverOrderCancelled).not.toHaveBeenCalled();
  });

  it('CU-136/138: consulta el gate único de flota y rechaza con su 400 si el chofer está inhabilitado, sin asignar', async () => {
    fleetGate.assertChoferHabilitado.mockRejectedValue(
      new BadRequestException(
        'No se puede asignar: Licencia de conducir: venció el 01/01/2020.',
      ),
    );

    await expect(service.assignDelivery(PEDIDO, CHOFER)).rejects.toThrow(
      /Licencia de conducir: venció el 01\/01\/2020/,
    );
    expect(fleetGate.assertChoferHabilitado).toHaveBeenCalledWith(
      CHOFER_USER_ID,
      'dist',
    );
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('un chofer de otra distribuidora es 404 y ni siquiera consulta la flota', async () => {
    const deliveries = {
      findById: jest.fn().mockResolvedValue({
        deliveryId: CHOFER,
        userId: CHOFER_USER_ID,
        distributorId: 'OTRA-DISTRIBUIDORA',
      }),
      assertElegibleParaAsignacion: jest.fn(),
    };
    service = new OrderService(
      {} as unknown as Repository<Order>,
      deliveries as unknown as DeliveryService,
      dispatch as unknown as RealtimeDispatchPort,
      {} as unknown as OrderRepositoryPort,
      {} as unknown as CreateOrderUseCase,
      {} as unknown as UpdateOrderStatusUseCase,
      {} as unknown as CancelOrderUseCase,
      {} as unknown as ConfirmDeliveryUseCase,
      {} as unknown as DispatchOrchestratorService,
      dispatchOffers as unknown as DispatchOfferRepositoryPort,
      {} as unknown as NotificationPort,
      dataSource as unknown as DataSource,
      fleetGate as unknown as FleetDispatchLockService,
    );

    await expect(service.assignDelivery(PEDIDO, CHOFER)).rejects.toThrow(
      NotFoundException,
    );
    // El chequeo de pertenencia al tenant corre ANTES: no se filtra info de
    // flota de un chofer que ni siquiera es de esta distribuidora.
    expect(fleetGate.assertChoferHabilitado).not.toHaveBeenCalled();
    expect(deliveries.assertElegibleParaAsignacion).not.toHaveBeenCalled();
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
  });
});
