import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReleaseOrderUseCase } from './release-order.use-case';
import { Order, OrderStatus } from '../entities/order.entity';

/**
 * Camino ÚNICO de liberación. Lo verifica de punta a punta: lock pesimista +
 * mutación pura (`applyRelease`, reusable sin abrir una 2da transacción) +
 * los mismos tres avisos siempre (`notifyReleased`), sin importar si lo
 * dispara `PATCH /status`, `/cancel` del chofer o `/reject` de una
 * asignación manual.
 */
describe('ReleaseOrderUseCase', () => {
  let useCase: ReleaseOrderUseCase;
  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: {
      createQueryBuilder: jest.Mock;
      update: jest.Mock;
      save: jest.Mock;
    };
  };
  let queryBuilder: {
    setLock: jest.Mock;
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
  let dispatch: {
    stopTracking: jest.Mock;
    notifyDriverOrderCancelled: jest.Mock;
    notifyCustomer: jest.Mock;
    notifyAdmins: jest.Mock;
  };
  let dispatchOrchestrator: {
    releaseOffer: jest.Mock;
    onOrderClosed: jest.Mock;
  };

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
      vehicleCarId: 'car-1',
      vehiclePatent: 'ABC123',
      vehicleBrand: 'Honda',
      vehicleModel: 'Wave',
      ...over,
    }) as unknown as Order;

  beforeEach(() => {
    queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(makeOrder())),
    };
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        createQueryBuilder: jest.fn(() => queryBuilder),
        update: jest.fn().mockResolvedValue(undefined),
        save: jest.fn((o: unknown) => Promise.resolve(o)),
      },
    };
    dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) };
    dispatch = {
      stopTracking: jest.fn(),
      notifyDriverOrderCancelled: jest.fn(),
      notifyCustomer: jest.fn(),
      notifyAdmins: jest.fn(),
    };
    dispatchOrchestrator = {
      releaseOffer: jest.fn().mockResolvedValue(undefined),
      onOrderClosed: jest.fn().mockResolvedValue(undefined),
    };

    useCase = new ReleaseOrderUseCase(
      dataSource as unknown as import('typeorm').DataSource,
      dispatch as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      dispatchOrchestrator as unknown as import('./dispatch-orchestrator.service').DispatchOrchestratorService,
    );
  });

  describe('execute (lock pesimista + camino completo)', () => {
    it('lanza NotFound si el pedido no existe, dentro de la transacción', async () => {
      queryBuilder.getOne.mockResolvedValue(null);
      await expect(useCase.execute('nope')).rejects.toThrow(NotFoundException);
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });

    it('limpia la asignación, guarda y hace commit', async () => {
      const result = await useCase.execute('ord-1');

      expect(result.status).toBe(OrderStatus.PENDING);
      expect(result.deliveryId).toBeNull();
      expect(result.delivery).toBeNull();
      expect(result.acceptedAt).toBeNull();
      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { orderId: 'ord-1' },
        { emptiesReceived: null },
      );
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it('punto 6 (segunda revisión): con `expectedDriverUserId` que SÍ coincide, libera igual', async () => {
      const result = await useCase.execute('ord-1', 'user-drv-1');

      expect(result.status).toBe(OrderStatus.PENDING);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('punto 6: con `expectedDriverUserId` que NO coincide con el dato FRESCO del lock, corta con 403 y hace rollback (no libera)', async () => {
      // El dato "fresco" del lock dice que el pedido es de `user-drv-1`; si
      // entre que se chequeó afuera (antes del lock) y se consiguió el lock
      // el pedido se reasignó a otro chofer, este chequeo DENTRO del lock lo
      // frena, en vez de liberar un pedido que ya no es del que llamó.
      await expect(useCase.execute('ord-1', 'otro-chofer')).rejects.toThrow(
        ForbiddenException,
      );

      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('punto 6: sin chofer previo asignado, un `expectedDriverUserId` cualquiera no puede liberarlo (403)', async () => {
      queryBuilder.getOne.mockResolvedValue(
        makeOrder({ delivery: null, deliveryId: null }),
      );

      await expect(useCase.execute('ord-1', 'user-drv-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('los tres avisos corren DESPUÉS del commit (best-effort, no dentro de la tx)', async () => {
      const ordenDeLlamadas: string[] = [];
      queryRunner.commitTransaction.mockImplementation(() => {
        ordenDeLlamadas.push('commit');
        return Promise.resolve();
      });
      dispatch.notifyCustomer.mockImplementation(() => {
        ordenDeLlamadas.push('notifyCustomer');
      });

      await useCase.execute('ord-1');

      expect(ordenDeLlamadas).toEqual(['commit', 'notifyCustomer']);
    });
  });

  describe('applyRelease (mutación pura, la reusa CancelOrderUseCase)', () => {
    it('transiciona a PENDING y limpia deliveryId/delivery/acceptedAt/onTheWayAt', () => {
      const order = makeOrder({ onTheWayAt: new Date() });
      const previousUserId = useCase.applyRelease(order);

      expect(order.status).toBe(OrderStatus.PENDING);
      expect(order.deliveryId).toBeNull();
      expect(order.delivery).toBeNull();
      expect(order.acceptedAt).toBeNull();
      expect(order.onTheWayAt).toBeNull();
      expect(previousUserId).toBe('user-drv-1');
    });

    it('limpia también el snapshot del vehículo (vehicle*)', () => {
      const order = makeOrder();
      useCase.applyRelease(order);

      expect(order.vehicleCarId).toBeNull();
      expect(order.vehiclePatent).toBeNull();
      expect(order.vehicleBrand).toBeNull();
      expect(order.vehicleModel).toBeNull();
    });

    it('sin chofer previo, devuelve null', () => {
      const order = makeOrder({ delivery: null, deliveryId: null });
      expect(useCase.applyRelease(order)).toBeNull();
    });
  });

  describe('notifyReleased (los mismos tres avisos, siempre)', () => {
    it('con chofer previo: corta tracking, cierra oferta y avisa a los tres', async () => {
      const order = makeOrder({
        status: OrderStatus.PENDING,
        deliveryId: null,
      });
      await useCase.notifyReleased(order, 'user-drv-1');

      expect(dispatch.stopTracking).toHaveBeenCalledWith('user-drv-1');
      expect(dispatchOrchestrator.releaseOffer).toHaveBeenCalledWith(
        'ord-1',
        'user-drv-1',
      );
      expect(dispatch.notifyDriverOrderCancelled).toHaveBeenCalledWith(
        'user-drv-1',
        expect.anything(),
      );
      expect(dispatch.notifyCustomer).toHaveBeenCalledWith(
        'cust-1',
        'order:searching-driver',
        expect.anything(),
      );
      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:pending',
        expect.anything(),
        'dist-1',
      );
    });

    it('sin chofer previo, no corta tracking ni cierra oferta (pero sí avisa a cliente/admins)', async () => {
      const order = makeOrder({ status: OrderStatus.PENDING });
      await useCase.notifyReleased(order, null);

      expect(dispatch.stopTracking).not.toHaveBeenCalled();
      expect(dispatchOrchestrator.releaseOffer).not.toHaveBeenCalled();
      expect(dispatchOrchestrator.onOrderClosed).toHaveBeenCalledWith('ord-1');
      expect(dispatch.notifyDriverOrderCancelled).not.toHaveBeenCalled();
      expect(dispatch.notifyCustomer).toHaveBeenCalled();
      expect(dispatch.notifyAdmins).toHaveBeenCalled();
    });
  });
});
