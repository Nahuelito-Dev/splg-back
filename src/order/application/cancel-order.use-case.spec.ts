import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  CancelOrderUseCase,
  mapRoleToCancelActor,
} from './cancel-order.use-case';
import { ReleaseOrderUseCase } from './release-order.use-case';
import { Order, OrderStatus } from '../entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';

/**
 * Caso de uso de cancelación/liberación de pedido. Foco: la política por
 * actor (customer/admin cancelan con devolución de stock; driver libera a
 * PENDING sin tocar stock, delegando en el camino ÚNICO `ReleaseOrderUseCase`)
 * y la concurrencia: TODO —ownership, chequeo de estado, política y
 * guardado— corre dentro de UNA transacción con lock pesimista, para que dos
 * cancelaciones simultáneas del mismo pedido no devuelvan el stock dos veces.
 */
describe('CancelOrderUseCase', () => {
  let useCase: CancelOrderUseCase;
  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: {
      createQueryBuilder: jest.Mock;
      save: jest.Mock;
      find: jest.Mock;
    };
  };
  let queryBuilder: {
    setLock: jest.Mock;
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
  let stock: { restituirStock: jest.Mock };
  let dispatch: {
    notifyCustomer: jest.Mock;
    notifyDriverOrderCancelled: jest.Mock;
    notifyAdmins: jest.Mock;
    stopTracking: jest.Mock;
  };
  let dispatchOrchestrator: {
    releaseOffer: jest.Mock;
    onOrderClosed: jest.Mock;
  };
  let refunds: { reintegrarPorCancelacion: jest.Mock };
  let releaseOrder: ReleaseOrderUseCase;
  let lockedOrder: Order;

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'ord-1',
      customerId: 'cust-1',
      distributorId: 'dist-1',
      status: OrderStatus.ACCEPTED,
      deliveryId: 'delivery-profile-1',
      delivery: { userId: 'user-drv-1' },
      acceptedAt: new Date('2026-01-01'),
      onTheWayAt: null,
      items: [],
      ...over,
    }) as unknown as Order;

  beforeEach(() => {
    lockedOrder = makeOrder();
    queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
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
        save: jest.fn((o: unknown) => Promise.resolve(o)),
        find: jest.fn(() => Promise.resolve(lockedOrder.items)),
      },
    };
    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };
    stock = { restituirStock: jest.fn().mockResolvedValue(undefined) };
    dispatch = {
      notifyCustomer: jest.fn(),
      notifyDriverOrderCancelled: jest.fn(),
      notifyAdmins: jest.fn(),
      stopTracking: jest.fn(),
    };
    dispatchOrchestrator = {
      releaseOffer: jest.fn().mockResolvedValue(undefined),
      onOrderClosed: jest.fn().mockResolvedValue(undefined),
    };
    // ReleaseOrderUseCase REAL: `applyRelease` es pura (sin I/O), así que
    // usarla tal cual verifica de punta a punta que CancelOrderUseCase
    // delega en el camino único de verdad, no en un doble que podría
    // desincronizarse.
    releaseOrder = new ReleaseOrderUseCase(
      {} as unknown as import('typeorm').DataSource,
      dispatch as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      dispatchOrchestrator as unknown as import('./dispatch-orchestrator.service').DispatchOrchestratorService,
    );

    refunds = {
      reintegrarPorCancelacion: jest.fn().mockResolvedValue([]),
    };

    useCase = new CancelOrderUseCase(
      dataSource as unknown as import('typeorm').DataSource,
      stock as unknown as import('../../gascylinder/gascylinder.service').GasCylinderService,
      dispatch as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      releaseOrder,
      dispatchOrchestrator as unknown as import('./dispatch-orchestrator.service').DispatchOrchestratorService,
      refunds as unknown as import('../../payments/application/refunds.service').RefundsService,
    );
  });

  it('lanza NotFound si el pedido no existe', async () => {
    queryBuilder.getOne.mockResolvedValue(null);
    await expect(useCase.execute('nope', 'u1', 'admin')).rejects.toThrow(
      NotFoundException,
    );
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('un pedido finalizado no se puede cancelar de nuevo', async () => {
    lockedOrder = makeOrder({ status: OrderStatus.CANCELLED });
    queryBuilder.getOne.mockResolvedValue(lockedOrder);
    await expect(useCase.execute('ord-1', 'u1', 'admin')).rejects.toThrow(
      BadRequestException,
    );
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  describe('ownership', () => {
    it('el pedido de OTRO cliente responde 404 (no revela que existe)', async () => {
      lockedOrder = makeOrder({ customerId: 'otro' });
      queryBuilder.getOne.mockResolvedValue(lockedOrder);
      await expect(
        useCase.execute('ord-1', 'cust-1', 'customer'),
      ).rejects.toThrow(NotFoundException);
    });

    it('un chofer no puede tocar el pedido de otro chofer', async () => {
      await expect(
        useCase.execute('ord-1', 'otro-chofer', 'driver'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('driver: libera a PENDING por el camino único (desajuste 1)', () => {
    it('limpia deliveryId/acceptedAt/onTheWayAt y NO devuelve stock', async () => {
      const result = await useCase.execute('ord-1', 'user-drv-1', 'driver');

      expect(result.status).toBe(OrderStatus.PENDING);
      expect(result.deliveryId).toBeNull();
      expect(result.acceptedAt).toBeNull();
      expect(result.onTheWayAt).toBeNull();
      expect(stock.restituirStock).not.toHaveBeenCalled();
    });

    it('cierra la oferta del chofer por su user_id, no por el id del perfil de reparto', async () => {
      await useCase.execute('ord-1', 'user-drv-1', 'driver');

      expect(dispatchOrchestrator.releaseOffer).toHaveBeenCalledWith(
        'ord-1',
        'user-drv-1', // user_id (order.delivery.userId), NUNCA order.deliveryId
      );
    });

    it('avisa "buscando chofer" al cliente y al chofer anterior, no "cancelado" a admins', async () => {
      await useCase.execute('ord-1', 'user-drv-1', 'driver');

      expect(dispatch.notifyCustomer).toHaveBeenCalledWith(
        'cust-1',
        'order:searching-driver',
        expect.anything(),
      );
      expect(dispatch.notifyDriverOrderCancelled).toHaveBeenCalledWith(
        'user-drv-1',
        expect.anything(),
      );
      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:pending',
        expect.anything(),
        'dist-1',
      );
    });
  });

  describe('CU-168: devolución del pago al cancelar', () => {
    it('customer y admin piden la devolución del pedido DESPUÉS del commit', async () => {
      await useCase.execute('ord-1', 'cust-1', 'customer');
      expect(refunds.reintegrarPorCancelacion).toHaveBeenCalledWith('ord-1');
      expect(
        refunds.reintegrarPorCancelacion.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        queryRunner.commitTransaction.mock.invocationCallOrder[0],
      );

      refunds.reintegrarPorCancelacion.mockClear();
      lockedOrder = makeOrder();
      queryBuilder.getOne.mockResolvedValue(lockedOrder);
      await useCase.execute('ord-1', 'admin-1', 'admin');
      expect(refunds.reintegrarPorCancelacion).toHaveBeenCalledWith('ord-1');
    });

    it('si la pasarela falla la cancelación igual se confirma', async () => {
      refunds.reintegrarPorCancelacion.mockRejectedValue(new Error('MP caído'));
      const result = await useCase.execute('ord-1', 'cust-1', 'customer');
      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('el chofer que libera el pedido NO dispara ninguna devolución', async () => {
      await useCase.execute('ord-1', 'user-drv-1', 'driver');
      expect(refunds.reintegrarPorCancelacion).not.toHaveBeenCalled();
    });

    it('una cancelación rechazada no pide devolución', async () => {
      lockedOrder = makeOrder({ status: OrderStatus.CANCELLED });
      queryBuilder.getOne.mockResolvedValue(lockedOrder);
      await expect(useCase.execute('ord-1', 'u1', 'admin')).rejects.toThrow(
        BadRequestException,
      );
      expect(refunds.reintegrarPorCancelacion).not.toHaveBeenCalled();
    });
  });

  describe('customer/admin: cancela con devolución de stock', () => {
    it('al cancelar de verdad limpia la marca de sin choferes del despacho', async () => {
      await useCase.execute('ord-1', 'cust-1', 'customer');
      expect(dispatchOrchestrator.onOrderClosed).toHaveBeenCalledWith('ord-1');
    });

    it('customer cancela y se devuelve el stock', async () => {
      const result = await useCase.execute('ord-1', 'cust-1', 'customer');

      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(stock.restituirStock).toHaveBeenCalledTimes(1);
      expect(dispatchOrchestrator.releaseOffer).not.toHaveBeenCalled();
      expect(dispatch.notifyCustomer).toHaveBeenCalledWith(
        expect.any(String),
        'order:cancelled',
        expect.objectContaining({ cancelledBy: 'customer' }),
      );
    });

    it('customer no puede cancelar un pedido ya en camino', async () => {
      lockedOrder = makeOrder({ status: OrderStatus.ON_THE_WAY });
      queryBuilder.getOne.mockResolvedValue(lockedOrder);
      await expect(
        useCase.execute('ord-1', 'cust-1', 'customer'),
      ).rejects.toThrow(BadRequestException);
      expect(stock.restituirStock).not.toHaveBeenCalled();
    });

    it('admin cancela un pedido en camino y avisa al panel de SU distribuidora', async () => {
      lockedOrder = makeOrder({ status: OrderStatus.ON_THE_WAY });
      queryBuilder.getOne.mockResolvedValue(lockedOrder);

      const result = await useCase.execute(
        'ord-1',
        'admin-1',
        'admin',
        'motivo',
      );

      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(result.cancellationReason).toBe('motivo');
      expect(stock.restituirStock).toHaveBeenCalledTimes(1);
      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:cancelled',
        expect.objectContaining({ orderId: 'ord-1', cancelledBy: 'admin' }),
        'dist-1',
      );
      // El cliente recibe el mismo aviso, con quién canceló.
      expect(dispatch.notifyCustomer).toHaveBeenCalledWith(
        expect.any(String),
        'order:cancelled',
        expect.objectContaining({ cancelledBy: 'admin', reason: 'motivo' }),
      );
      // Avisa también al chofer que tenía el pedido, por su user_id (no por
      // el id de su perfil de reparto).
      expect(dispatch.notifyDriverOrderCancelled).toHaveBeenCalledWith(
        'user-drv-1',
        expect.anything(),
      );
      // Segunda revisión, punto 3: cancelar un ON_THE_WAY por CUALQUIER
      // puerta corta el tracking del chofer que lo tenía. Antes sólo lo
      // hacía la liberación del propio chofer (`ReleaseOrderUseCase`); esta
      // rama (admin/customer cancelan de verdad) no lo hacía.
      expect(dispatch.stopTracking).toHaveBeenCalledWith('user-drv-1');
    });

    it('punto 3 (segunda revisión): cancelar un ACCEPTED (sin tracking activo todavía) también corta el tracking — inofensivo, sólo limpia Redis', async () => {
      // `lockedOrder` por defecto ya es ACCEPTED con chofer (ver makeOrder).
      await useCase.execute('ord-1', 'admin-1', 'admin');

      expect(dispatch.stopTracking).toHaveBeenCalledWith('user-drv-1');
    });

    it('sin chofer previo asignado, no llama a stopTracking (no hay nada que cortar)', async () => {
      lockedOrder = makeOrder({ delivery: null, deliveryId: null });
      queryBuilder.getOne.mockResolvedValue(lockedOrder);

      await useCase.execute('ord-1', 'cust-1', 'customer');

      expect(dispatch.stopTracking).not.toHaveBeenCalled();
    });
  });

  describe('concurrencia: dos cancelaciones del mismo pedido', () => {
    it('la segunda ve el estado que dejó la primera (CANCELLED) y no devuelve stock de nuevo', async () => {
      // Simula la carrera: la 2da lectura con lock ya ve CANCELLED, como si
      // la 1ra hubiera hecho commit un instante antes de que esta adquiriera
      // el lock (el pessimistic_write serializa el acceso real a la fila).
      queryBuilder.getOne
        .mockResolvedValueOnce(makeOrder()) // 1ra cancelación: pedido vivo
        .mockResolvedValueOnce(makeOrder({ status: OrderStatus.CANCELLED })); // 2da: ya cancelado

      const primera = await useCase.execute('ord-1', 'cust-1', 'customer');
      expect(primera.status).toBe(OrderStatus.CANCELLED);
      expect(stock.restituirStock).toHaveBeenCalledTimes(1);

      await expect(
        useCase.execute('ord-1', 'cust-1', 'customer'),
      ).rejects.toThrow(BadRequestException);
      // Sigue en 1: la segunda no volvió a devolver stock.
      expect(stock.restituirStock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('mapRoleToCancelActor', () => {
  it('mapea cada rol al actor de cancelación correspondiente', () => {
    expect(mapRoleToCancelActor(RoleType.CUSTOMER)).toBe('customer');
    expect(mapRoleToCancelActor(RoleType.DELIVERY)).toBe('driver');
    expect(mapRoleToCancelActor(RoleType.ADMIN)).toBe('admin');
    expect(mapRoleToCancelActor(RoleType.SUPER_ADMIN)).toBe('admin');
    expect(mapRoleToCancelActor(undefined)).toBe('admin');
  });
});
