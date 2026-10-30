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
    };
  };
  let queryBuilder: {
    setLock: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
  let lockedOrder: Partial<Order> | null;
  let stock: { restituirStock: jest.Mock };
  let orders: { findByIdFull: jest.Mock };
  let dispatchOrchestrator: { offerToNextDriver: jest.Mock };
  let frecuencias: {
    distribuidorasQueCorren: jest.Mock;
    liberarMarca: jest.Mock;
  };

  const staleOrder = {
    orderId: 'ord-mp-1',
    status: OrderStatus.PENDING,
    paymentMethod: PaymentMethod.MERCADOPAGO,
    gatewayPaymentId: null,
    items: [{ gasCylinderId: 'gc-1', quantity: 2 }],
  } as unknown as Order;

  beforeEach(() => {
    lockedOrder = {
      orderId: 'ord-mp-1',
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
        save: jest.fn((o: unknown) => Promise.resolve(o)),
      },
    };
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

    orderRepository = { find: jest.fn().mockResolvedValue([]) };
    stock = { restituirStock: jest.fn().mockResolvedValue(undefined) };
    orders = { findByIdFull: jest.fn() };
    dispatchOrchestrator = { offerToNextDriver: jest.fn() };

    frecuencias = {
      distribuidorasQueCorren: jest.fn((_t: string, ids: string[]) =>
        Promise.resolve(new Set(ids)),
      ),
      liberarMarca: jest.fn().mockResolvedValue(undefined),
    };

    service = new ReservationService(
      orderRepository as unknown as import('typeorm').Repository<Order>,
      dataSource as unknown as import('typeorm').DataSource,
      orders as unknown as import('../domain/ports/order.repository.port').OrderRepositoryPort,
      stock as unknown as import('../../gascylinder/gascylinder.service').GasCylinderService,
      dispatchOrchestrator as unknown as import('./dispatch-orchestrator.service').DispatchOrchestratorService,
      frecuencias as unknown as import('../../distributor/scheduled-tasks-settings.service').ScheduledTasksSettingsService,
      {
        getOrThrow: jest.fn((key: string) => {
          if (key === 'RESERVATION_DEPOSIT_TTL_HOURS') return 48;
          if (key === 'ORDER_MERCADOPAGO_PENDING_TTL_MINUTES') return 60;
          throw new Error('Unknown config key');
        }),
      } as unknown as import('@nestjs/config').ConfigService,
      {
        findPendingCheckoutUrls: jest.fn().mockResolvedValue(new Map()),
      } as unknown as import('../../payments/application/payments.service').PaymentsService,
      undefined as never,
      undefined as never,
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
        }) as unknown as import('typeorm').FindOptionsWhere<
          import('../entities/order.entity').Order
        >,
      }),
    );
  });

  it('pedido vencido y sigue impago: cancela + restituye stock', async () => {
    orderRepository.find.mockResolvedValue([staleOrder]);

    await service.expireUnpaidMercadoPagoOrders();

    expect(queryRunner.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: OrderStatus.CANCELLED,
        orderId: 'ord-mp-1',
      }),
    );
    expect(stock.restituirStock).toHaveBeenCalledWith(queryRunner.manager, [
      { gasCylinderId: 'gc-1', quantity: 2 },
    ]);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('carrera pago-vs-expiración: el webhook confirmó el pago justo antes → NO cancela ni toca stock', async () => {
    orderRepository.find.mockResolvedValue([staleOrder]);
    lockedOrder!.gatewayPaymentId = 'pay-ganó-la-carrera';

    await service.expireUnpaidMercadoPagoOrders();

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(stock.restituirStock).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('el pedido ya no está PENDING (cancelado/despachado por otro flujo): no lo toca', async () => {
    orderRepository.find.mockResolvedValue([staleOrder]);
    lockedOrder!.status = OrderStatus.CANCELLED;

    await service.expireUnpaidMercadoPagoOrders();

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(stock.restituirStock).not.toHaveBeenCalled();
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

  describe('CU-173: frecuencia por distribuidora', () => {
    const delPedido = (distributorId: string, n = 1) =>
      ({
        ...staleOrder,
        orderId: `ord-${distributorId}-${n}`,
        distributorId,
      }) as Order;

    /** Las consultas completas (con `take`), no la que sólo busca distribuidoras. */
    const consultasDeLote = () =>
      (
        orderRepository.find.mock.calls as Array<
          [
            {
              where: { distributorId?: string };
              take?: number;
              order?: unknown;
            },
          ]
        >
      )
        .map((c) => c[0])
        .filter((c) => c.take !== undefined);

    it('decide de una pasada qué distribuidoras corren (con la tarea del vencimiento de MercadoPago) y sólo consulta las que corren', async () => {
      orderRepository.find.mockResolvedValue([
        delPedido('dist-ok'),
        delPedido('dist-espera'),
      ]);
      frecuencias.distribuidorasQueCorren.mockResolvedValue(
        new Set(['dist-ok']),
      );

      await service.expireUnpaidMercadoPagoOrders();

      expect(frecuencias.distribuidorasQueCorren).toHaveBeenCalledTimes(1);
      expect(frecuencias.distribuidorasQueCorren).toHaveBeenCalledWith(
        'unpaidMercadoPagoExpirySeconds',
        ['dist-ok', 'dist-espera'],
      );
      expect(consultasDeLote().map((c) => c.where.distributorId)).toEqual([
        'dist-ok',
      ]);
    });

    it('si a ninguna distribuidora le toca, no consulta más ni toca nada', async () => {
      orderRepository.find.mockResolvedValue([delPedido('dist-espera')]);
      frecuencias.distribuidorasQueCorren.mockResolvedValue(new Set());

      await service.expireUnpaidMercadoPagoOrders();

      expect(orderRepository.find).toHaveBeenCalledTimes(1);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('cada distribuidora tiene su propio límite de 50 y orden por antigüedad: ninguna tapa a otra', async () => {
      orderRepository.find.mockResolvedValue([
        delPedido('d1'),
        delPedido('d2'),
      ]);

      await service.expireUnpaidMercadoPagoOrders();

      const lotes = consultasDeLote();
      expect(lotes.map((c) => c.where.distributorId)).toEqual(['d1', 'd2']);
      expect(lotes.map((c) => c.take)).toEqual([50, 50]);
      expect(lotes.map((c) => c.order)).toEqual([
        { createdAt: 'ASC' },
        { createdAt: 'ASC' },
      ]);
    });

    it('si falla la consulta de una distribuidora le devuelve la marca y sigue con las demás', async () => {
      orderRepository.find.mockImplementation(
        (opciones: { where: { distributorId?: string }; take?: number }) => {
          if (opciones.take === undefined) {
            return Promise.resolve([delPedido('d1'), delPedido('d2')]);
          }
          return opciones.where.distributorId === 'd1'
            ? Promise.reject(new Error('base caída'))
            : Promise.resolve([]);
        },
      );

      await service.expireUnpaidMercadoPagoOrders();

      expect(frecuencias.liberarMarca).toHaveBeenCalledTimes(1);
      expect(frecuencias.liberarMarca).toHaveBeenCalledWith(
        'unpaidMercadoPagoExpirySeconds',
        'd1',
      );
      expect(consultasDeLote().map((c) => c.where.distributorId)).toEqual([
        'd1',
        'd2',
      ]);
    });

    it('reservas sin seña y activación de reservas usan cada una su propia tarea', async () => {
      orderRepository.find.mockResolvedValue([delPedido('d1')]);

      await service.expireUnpaidReservations();
      await service.activateDueReservations();

      expect(
        (frecuencias.distribuidorasQueCorren.mock.calls as Array<[string]>).map(
          (c) => c[0],
        ),
      ).toEqual([
        'unpaidReservationExpirySeconds',
        'reservationActivationSeconds',
      ]);
    });
  });

  describe('el "hoy" es el día argentino', () => {
    beforeEach(() => {
      // 22:30 del 10/10 en Argentina = 01:30 UTC del 11/10.
      jest.useFakeTimers({ now: new Date('2026-10-11T01:30:00Z') });
    });
    afterEach(() => jest.useRealTimers());

    it('activateDueReservations activa las agendadas hasta HOY argentino (10/10), no hasta el día UTC', async () => {
      await service.activateDueReservations();

      const where = (
        orderRepository.find.mock.calls[0] as [
          { where: { scheduledDate: { value: string } } },
        ]
      )[0].where;
      expect(where.scheduledDate.value).toBe('2026-10-10');
    });
  });
});
