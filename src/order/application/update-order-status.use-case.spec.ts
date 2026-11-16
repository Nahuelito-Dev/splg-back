import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DispatchOfferStatus } from '../entities/dispatch-offer.entity';
import {
  MENSAJE_PEDIDO_EN_RECORRIDO,
  UpdateOrderStatusUseCase,
} from './update-order-status.use-case';
import { EVENTO_PEDIDO_ENTREGADO } from '../domain/events/pedido-entregado.event';
import { AuditoriaDeDatos } from '../../audit/data/auditoria-de-datos';
import { InvalidOrderTransitionError } from '../domain/errors/invalid-order-transition.error';
import { ReservationNotActivableError } from '../domain/errors/reservation-not-activable.error';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';

/**
 * Use-case de cambio de estado. Mockeamos repos, puerto de tiempo real y
 * notificaciones: verificamos los EFECTOS de dominio de cada estado (asignar
 * chofer + timestamps, CASH→PAID) y que los side-effects sean best-effort.
 * La validez de la transición en sí la cubre order-status.machine.spec.
 */
/** La hora del servidor de la base, distinta a propósito de la de Node. */
const HORA_DE_LA_BASE = new Date('2030-01-01T10:00:00.000Z');

describe('UpdateOrderStatusUseCase', () => {
  /** Lo que relee el cerrojo del chofer: si el pedido es de una hoja en curso y si tiene otro en camino. */
  let enCamino: { enHoja: boolean; otro: boolean };
  let useCase: UpdateOrderStatusUseCase;
  let deliveries: {
    buscarPorIdOUsuario: jest.Mock;
    assertElegibleParaAsignacion: jest.Mock;
  };
  let offers: {
    withdrawOtherActiveOffers: jest.Mock;
    isInLiveBatch: jest.Mock;
    isInPlannedRouteSheet: jest.Mock;
  };
  let eventos: { emitAsync: jest.Mock };
  let dispatch: {
    notifyDriverOrderCancelled: jest.Mock;
    notifyCustomer: jest.Mock;
    notifyAdmins: jest.Mock;
    startTracking: jest.Mock;
    stopTracking: jest.Mock;
  };
  let notifications: { sendOrderConfirmation: jest.Mock };
  let orders: {
    findByIdFull: jest.Mock<Promise<Order | null>, [string]>;
    findInProgressOfDeliveries: jest.Mock;
    save: jest.Mock<Promise<Order>, [Order]>;
  };
  let orchestrator: {
    onDriverAccepted: jest.Mock;
    releaseOffer: jest.Mock;
    offerToNextDriver: jest.Mock;
  };
  let cylinderLifecycle: { onOrderDelivered: jest.Mock };
  let stockDelivery: { onOrderDelivered: jest.Mock };
  let fotos: { urlDe: jest.Mock };
  let truckGate: { assertPuedeAceptar: jest.Mock };
  let cancelOrderUseCase: { execute: jest.Mock };
  let releaseOrderUseCase: { execute: jest.Mock };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    isTransactionActive: boolean;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: {
      createQueryBuilder: jest.Mock;
      find: jest.Mock;
      save: jest.Mock;
      insert: jest.Mock;
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
    assertEnMoto: jest.Mock;
    vehiculoEnUsoDelChofer: jest.Mock;
  };

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'ord-1',
      customerId: 'cust-1',
      distributorId: 'dist-1',
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      items: [],
      ...over,
    }) as Order;

  beforeEach(() => {
    enCamino = { enHoja: false, otro: false };
    deliveries = {
      buscarPorIdOUsuario: jest.fn(),
      // Réplica fiel de DeliveryService.assertElegibleParaAsignacion: la
      // cobertura de la regla en sí vive en delivery.service.spec.ts, acá sólo
      // interesa que el use-case la invoque y propague el error.
      assertElegibleParaAsignacion: jest.fn(
        (delivery: { isEnabled?: boolean; validated?: boolean }) => {
          if (!delivery.isEnabled) {
            throw new BadRequestException('El repartidor está deshabilitado');
          }
          if (!delivery.validated) {
            throw new BadRequestException('El repartidor no está validado');
          }
        },
      ),
    };
    offers = {
      withdrawOtherActiveOffers: jest.fn().mockResolvedValue([]),
      isInLiveBatch: jest.fn().mockResolvedValue(false),
      isInPlannedRouteSheet: jest.fn().mockResolvedValue(false),
    };
    dispatch = {
      notifyDriverOrderCancelled: jest.fn(),
      notifyCustomer: jest.fn(),
      notifyAdmins: jest.fn(),
      startTracking: jest.fn(),
      stopTracking: jest.fn(),
    };
    notifications = {
      sendOrderConfirmation: jest.fn().mockResolvedValue(null),
    };
    orders = {
      findByIdFull: jest.fn<Promise<Order | null>, [string]>(),
      findInProgressOfDeliveries: jest.fn().mockResolvedValue([]),
      save: jest.fn((o: Order) => Promise.resolve(o)),
    };
    orchestrator = {
      onDriverAccepted: jest.fn().mockResolvedValue(undefined),
      releaseOffer: jest.fn().mockResolvedValue(undefined),
      offerToNextDriver: jest.fn().mockResolvedValue(undefined),
    };
    cylinderLifecycle = { onOrderDelivered: jest.fn().mockResolvedValue(0) };
    cancelOrderUseCase = { execute: jest.fn() };
    releaseOrderUseCase = { execute: jest.fn() };

    // Segunda revisión, punto 2: ACCEPTED/ON_THE_WAY/DELIVERED (y la
    // activación RESERVED→PENDING) re-leen el pedido con el MISMO lock
    // pesimista que cancelar/liberar, en vez de `orders.findByIdFull`/
    // `orders.save` directo. `getOne`/`manager.save` delegan en los mismos
    // mocks `orders.findByIdFull`/`orders.save` de siempre: cada test sigue
    // configurando el pedido con `orders.findByIdFull.mockResolvedValue(...)`
    // sin cambios, y las aserciones sobre `orders.save` siguen valiendo.
    queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => orders.findByIdFull('ord-1')),
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
        query: jest.fn((sql: string, params?: [string[]]) =>
          sql.includes('clock_timestamp')
            ? Promise.resolve([{ ahora: HORA_DE_LA_BASE }])
            : sql.includes('pg_advisory_xact_lock')
              ? Promise.resolve([{}])
              : sql.includes('"enHoja"')
                ? Promise.resolve([enCamino])
                : Promise.resolve(
                    (params?.[0] ?? []).map((id) => ({
                      delivery_id: id,
                      deleted: false,
                    })),
                  ),
        ),
        createQueryBuilder: jest.fn(() => queryBuilder),
        // Los renglones se releen después del lock, aparte del JOIN.
        find: jest.fn(
          async () =>
            ((await queryBuilder.getOne()) as Order | null)?.items ?? [],
        ),
        save: jest.fn((o: Order) => orders.save(o)),
        insert: jest.fn().mockResolvedValue(undefined),
      },
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };
    stockDelivery = {
      onOrderDelivered: jest.fn().mockResolvedValue(undefined),
    };
    truckGate = { assertPuedeAceptar: jest.fn().mockResolvedValue(undefined) };
    fotos = {
      urlDe: jest.fn((key: string | null) =>
        Promise.resolve(key ? 'https://s3/firmada-chofer' : null),
      ),
    };
    fleetGate = {
      assertChoferHabilitado: jest.fn().mockResolvedValue(undefined),
      assertEnMoto: jest.fn().mockResolvedValue(undefined),
      vehiculoEnUsoDelChofer: jest.fn().mockResolvedValue({
        carId: 'car-1',
        patent: 'AB123CD',
        brand: 'Honda',
        model: 'Wave',
      }),
    };

    eventos = { emitAsync: jest.fn().mockResolvedValue([]) };
    useCase = new UpdateOrderStatusUseCase(
      dataSource as unknown as import('typeorm').DataSource,
      deliveries as unknown as import('../../delivery/delivery.service').DeliveryService,
      dispatch as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      notifications as unknown as import('../domain/ports/notification.port').NotificationPort,
      orders as unknown as import('../domain/ports/order.repository.port').OrderRepositoryPort,
      orchestrator as unknown as import('./dispatch-orchestrator.service').DispatchOrchestratorService,
      cylinderLifecycle as unknown as import('../domain/ports/cylinder-lifecycle.port').CylinderLifecyclePort,
      cancelOrderUseCase as unknown as import('./cancel-order.use-case').CancelOrderUseCase,
      releaseOrderUseCase as unknown as import('./release-order.use-case').ReleaseOrderUseCase,
      fleetGate as unknown as import('../../fleet/fleet-dispatch-lock.service').FleetDispatchLockService,
      stockDelivery as unknown as import('../domain/ports/stock-delivery.port').StockDeliveryPort,
      fotos as unknown as import('../../s3/entity-photo.service').EntityPhotoService,
      truckGate as unknown as import('../domain/ports/truck-load-gate.port').TruckLoadGatePort,
      offers as unknown as import('../domain/ports/dispatch-offer.repository.port').DispatchOfferRepositoryPort,
      eventos as unknown as import('@nestjs/event-emitter').EventEmitter2,
      { registrar: jest.fn().mockResolvedValue(0) } as never,
    );
  });

  it('lanza NotFound si el pedido no existe', async () => {
    orders.findByIdFull.mockResolvedValue(null);
    await expect(
      useCase.execute('nope', OrderStatus.ACCEPTED, 'drv-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('rechaza una transición inválida (PENDING → DELIVERED)', async () => {
    orders.findByIdFull.mockResolvedValue(makeOrder());
    // La state machine lanza el error de DOMINIO (InvalidOrderTransitionError,
    // no BadRequestException); el GlobalExceptionFilter lo mapea a 400 en la
    // capa HTTP (ver global-exception.filter.spec.ts), acá el use-case no debe
    // atrapar ni transformar nada.
    await expect(
      useCase.execute('ord-1', OrderStatus.DELIVERED),
    ).rejects.toThrow(InvalidOrderTransitionError);
    expect(orders.save).not.toHaveBeenCalled();
  });

  it('F34: en camino → aceptado no se pide por este endpoint (sólo la hoja de ruta lo usa)', async () => {
    orders.findByIdFull.mockResolvedValue(
      makeOrder({ status: OrderStatus.ON_THE_WAY, deliveryId: 'drv-1' }),
    );
    await expect(
      useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
    ).rejects.toThrow(InvalidOrderTransitionError);
    expect(orders.save).not.toHaveBeenCalled();
  });

  it('punto 2 (segunda revisión): usa el MISMO lock pesimista que cancelar/liberar para ACCEPTED/ON_THE_WAY/DELIVERED', async () => {
    orders.findByIdFull.mockResolvedValue(
      makeOrder({ status: OrderStatus.ON_THE_WAY }),
    );

    await useCase.execute('ord-1', OrderStatus.DELIVERED);

    expect(queryBuilder.setLock).toHaveBeenCalledWith(
      'pessimistic_write',
      undefined,
      ['ord'],
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });

  it('punto 2: la carrera real (cancelar MIENTRAS se acepta/avanza) — si el dato que trae el lock YA está CANCELLED, corta con 400 y hace rollback, sin guardar', async () => {
    // Simula que, para cuando esta transacción consiguió el lock, una
    // cancelación concurrente ya hizo commit: el SELECT ... FOR UPDATE del
    // lock devuelve el estado FRESCO (CANCELLED), no el que se hubiera leído
    // antes de pedirlo.
    orders.findByIdFull.mockResolvedValue(
      makeOrder({ status: OrderStatus.CANCELLED }),
    );

    await expect(
      useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
    ).rejects.toThrow(InvalidOrderTransitionError);

    expect(orders.save).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  describe('ACCEPTED', () => {
    const choferVigente = {
      deliveryId: 'drv-1',
      distributorId: 'dist-1',
      userId: 'user-drv-1',
      isEnabled: true,
      validated: true,
      user: { fullName: 'Chofer Uno', phoneNumber: '+549110000' },
    };

    it('acceptedAt sale del reloj de la base, no del de Node', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);
      const result = await useCase.execute(
        'ord-1',
        OrderStatus.ACCEPTED,
        'drv-1',
      );
      expect(result.acceptedAt).toEqual(HORA_DE_LA_BASE);
    });

    it('F9: el chofer no acepta un pedido de Mercado Pago sin pagar (409) y no se guarda nada', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          paymentMethod: PaymentMethod.MERCADOPAGO,
          paymentStatus: PaymentStatus.PENDING,
          depositPaid: false,
        }),
      );
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);

      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    describe('un pedido más para quien está por terminar (CU-013)', () => {
      const aceptar = (role?: RoleType) =>
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1', role);
      const deOtro = (status: OrderStatus, orderId: string) => ({
        deliveryId: 'drv-1',
        orderId,
        status,
        destino: null,
      });

      beforeEach(() => {
        orders.findByIdFull.mockResolvedValue(makeOrder());
        deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);
      });

      it('con uno en camino acepta el nuevo: queda uno solo encolado', async () => {
        orders.findInProgressOfDeliveries.mockResolvedValue([
          deOtro(OrderStatus.ON_THE_WAY, 'o-a'),
        ]);

        const r = await aceptar(RoleType.DELIVERY);

        expect(r.status).toBe(OrderStatus.ACCEPTED);
      });

      it('con uno en camino y otro ya aceptado esperando, el chofer no toma un tercero (409)', async () => {
        orders.findInProgressOfDeliveries.mockResolvedValue([
          deOtro(OrderStatus.ON_THE_WAY, 'o-a'),
          deOtro(OrderStatus.ACCEPTED, 'o-b'),
        ]);

        await expect(aceptar(RoleType.DELIVERY)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(queryRunner.manager.save).not.toHaveBeenCalled();
      });

      it('repetir la aceptación del mismo pedido no se cuenta como otro encolado', async () => {
        orders.findByIdFull.mockResolvedValue(
          makeOrder({
            status: OrderStatus.ACCEPTED,
            deliveryId: 'drv-1',
          } as Partial<Order>),
        );
        orders.findInProgressOfDeliveries.mockResolvedValue([
          deOtro(OrderStatus.ACCEPTED, 'ord-1'),
          deOtro(OrderStatus.ON_THE_WAY, 'o-a'),
        ]);

        const r = await aceptar(RoleType.DELIVERY);

        expect(r.status).toBe(OrderStatus.ACCEPTED);
        expect(orders.findInProgressOfDeliveries).not.toHaveBeenCalled();
      });

      it('el administrador asigna a su criterio: no se le aplica el límite', async () => {
        orders.findInProgressOfDeliveries.mockResolvedValue([
          deOtro(OrderStatus.ACCEPTED, 'o-b'),
        ]);

        const r = await aceptar(RoleType.ADMIN);

        expect(r.status).toBe(OrderStatus.ACCEPTED);
      });
    });

    it('relee los renglones DESPUÉS del lock: guarda los vigentes y no los que trajo el JOIN', async () => {
      const vigentes = [{ orderItemId: 'nuevo', quantity: 4 }];
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);
      queryRunner.manager.find.mockResolvedValue(vigentes);

      await useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1');

      const [guardado] = queryRunner.manager.save.mock.calls[0] as [Order];
      expect(guardado.items).toBe(vigentes);
    });

    it('bloquea la fila del chofer (FOR NO KEY UPDATE) ANTES de leer su vehículo en uso', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);

      await useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1');

      const [consulta, parametros] = queryRunner.manager.query.mock
        .calls[0] as [string, string[][]];
      expect(consulta).toContain('FOR NO KEY UPDATE');
      expect(parametros).toEqual([['drv-1']]);
      expect(
        queryRunner.manager.query.mock.invocationCallOrder[0],
      ).toBeLessThan(
        fleetGate.vehiculoEnUsoDelChofer.mock.invocationCallOrder[0],
      );
    });

    it('D5: si la distribuidora exige carga abierta y el chofer no la tiene, no acepta y no guarda', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);
      truckGate.assertPuedeAceptar.mockRejectedValue(
        new BadRequestException('Tu distribuidora exige una carga abierta'),
      );

      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Con la transacción de la aceptación: el lock de la carga es de ella.
      expect(truckGate.assertPuedeAceptar).toHaveBeenCalledWith(
        'dist-1',
        'drv-1',
        queryRunner.manager,
      );
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('al tomar el pedido retira las ofertas de los demás choferes en la misma transacción y les avisa', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);
      offers.withdrawOtherActiveOffers.mockResolvedValue([
        'user-otro-1',
        'user-otro-2',
      ]);

      await useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1');

      expect(offers.withdrawOtherActiveOffers).toHaveBeenCalledWith(
        queryRunner.manager,
        'ord-1',
        'user-drv-1',
        DispatchOfferStatus.SUPERSEDED,
      );
      expect(
        offers.withdrawOtherActiveOffers.mock.invocationCallOrder[0],
      ).toBeLessThan(queryRunner.commitTransaction.mock.invocationCallOrder[0]);
      expect(dispatch.notifyDriverOrderCancelled).toHaveBeenCalledTimes(2);
      expect(dispatch.notifyDriverOrderCancelled).toHaveBeenCalledWith(
        'user-otro-1',
        expect.objectContaining({ orderId: 'ord-1' }),
      );
    });

    it('si la transacción falla, no se avisa a nadie', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);
      offers.withdrawOtherActiveOffers.mockResolvedValue(['user-otro-1']);
      queryRunner.commitTransaction.mockRejectedValue(new Error('commit'));

      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
      ).rejects.toThrow('commit');
      expect(dispatch.notifyDriverOrderCancelled).not.toHaveBeenCalled();
    });

    it('D5: repetir la aceptación que ya era del mismo chofer no vuelve a pedir la carga', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ACCEPTED, deliveryId: 'drv-1' }),
      );
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);

      await useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1');

      expect(truckGate.assertPuedeAceptar).not.toHaveBeenCalled();
    });

    it('M4: un pedido que es parada de un recorrido vivo no se toma suelto (409) y no guarda', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);
      offers.isInLiveBatch.mockResolvedValue(true);

      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
      ).rejects.toThrow(new ConflictException(MENSAJE_PEDIDO_EN_RECORRIDO));
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('F34: una parada de una hoja de ruta no la toma ni el chofer ni el admin (409 ORDER_IN_ROUTE_SHEET) y no guarda', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);
      offers.isInPlannedRouteSheet.mockResolvedValue(true);

      for (const rol of [RoleType.DELIVERY, RoleType.ADMIN]) {
        await expect(
          useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1', rol),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'ORDER_IN_ROUTE_SHEET' },
        });
      }
      expect(offers.isInPlannedRouteSheet).toHaveBeenCalledWith(
        'ord-1',
        queryRunner.manager,
      );
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('si el chofer fue dado de baja mientras esperaba el lock es 404 y no guarda', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(choferVigente);
      queryRunner.manager.query.mockResolvedValue([
        { delivery_id: 'drv-1', deleted: true },
      ]);

      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('si la transacción ya no está activa, no intenta el rollback y sale el error original', async () => {
      orders.findByIdFull.mockResolvedValue(null);
      queryRunner.isTransactionActive = false;

      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
      ).rejects.toThrow(NotFoundException);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    describe('entrega manual del administrador', () => {
      let registrar: jest.SpyInstance;
      beforeEach(() => {
        registrar = jest
          .spyOn(AuditoriaDeDatos, 'registrar')
          .mockResolvedValue(undefined);
        orders.findByIdFull.mockResolvedValue(
          makeOrder({ status: OrderStatus.ON_THE_WAY }),
        );
      });
      afterEach(() => registrar.mockRestore());

      it.each([undefined, '', '   ', 'corto'])(
        'sin un motivo válido (%p) el admin recibe 400 y no se toca nada',
        async (reason) => {
          await expect(
            useCase.execute(
              'ord-1',
              OrderStatus.DELIVERED,
              undefined,
              RoleType.ADMIN,
              'admin-1',
              reason,
            ),
          ).rejects.toThrow(BadRequestException);
          expect(queryRunner.startTransaction).not.toHaveBeenCalled();
          expect(orders.save).not.toHaveBeenCalled();
          expect(stockDelivery.onOrderDelivered).not.toHaveBeenCalled();
        },
      );

      it('con motivo, lo deja en el historial de estados y en la auditoría, en la misma transacción', async () => {
        await useCase.execute(
          'ord-1',
          OrderStatus.DELIVERED,
          undefined,
          RoleType.SUPER_ADMIN,
          'admin-1',
          '  El cliente no tiene celular  ',
        );

        // El historial lo asienta el subscriber al guardar, con este motivo.
        expect(queryRunner.manager.save).toHaveBeenCalledWith(
          expect.objectContaining({
            transitionReason: 'El cliente no tiene celular',
          }),
        );
        expect(registrar).toHaveBeenCalledWith(
          queryRunner.manager,
          expect.objectContaining({
            entity: 'Order',
            recordId: 'ord-1',
            details: [
              {
                field: 'manualDeliveryReason',
                oldValue: null,
                newValue: 'El cliente no tiene celular',
              },
            ],
          }),
        );
        expect(queryRunner.commitTransaction).toHaveBeenCalled();
      });

      it('la entrega por QR (sin rol) no pide motivo ni escribe el asiento manual', async () => {
        await useCase.execute('ord-1', OrderStatus.DELIVERED);
        expect(queryRunner.manager.insert).not.toHaveBeenCalled();
        expect(registrar).not.toHaveBeenCalled();
      });
    });

    it('al entregar, los envases avanzan por el manager de la transacción', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ON_THE_WAY }),
      );

      await useCase.execute('ord-1', OrderStatus.DELIVERED);

      expect(cylinderLifecycle.onOrderDelivered).toHaveBeenCalledWith(
        'ord-1',
        'dist-1',
        queryRunner.manager,
      );
    });

    it('si falla el avance de envases, la entrega no se confirma (rollback)', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ON_THE_WAY }),
      );
      cylinderLifecycle.onOrderDelivered.mockRejectedValue(new Error('boom'));

      await expect(
        useCase.execute('ord-1', OrderStatus.DELIVERED),
      ).rejects.toThrow('boom');
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('la constancia de la oferta se escribe DESPUÉS del commit, con el lock del pedido ya liberado', async () => {
      // Escribir adentro (otra conexión, FK al pedido bloqueado con FOR UPDATE)
      // dejaba la transacción colgada para siempre.
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-1',
        distributorId: 'dist-1',
        userId: 'user-drv-1',
        isEnabled: true,
        validated: true,
        user: { fullName: 'Chofer Uno', phoneNumber: '+549110000' },
      });

      await useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1');

      const commit = queryRunner.commitTransaction.mock.invocationCallOrder[0];
      const constancia =
        orchestrator.onDriverAccepted.mock.invocationCallOrder[0];
      expect(constancia).toBeGreaterThan(commit);
    });

    it('si el rollback falla, sale el error original y la conexión se libera', async () => {
      orders.findByIdFull.mockResolvedValue(null);
      queryRunner.rollbackTransaction.mockRejectedValue(
        new Error('conexión caída'),
      );

      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
      ).rejects.toThrow(NotFoundException);
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it.each([
      ['tarda más del tope', () => new Promise<string>(() => undefined)],
      ['falla', () => Promise.reject(new Error('firma caída'))],
    ])(
      'si la firma de la foto %s, el evento sale igual con photoUrl null y sin demora',
      async (_n, firma) => {
        fotos.urlDe.mockImplementation(firma);
        orders.findByIdFull.mockResolvedValue(makeOrder());
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'drv-1',
          distributorId: 'dist-1',
          userId: 'user-drv-1',
          isEnabled: true,
          validated: true,
          user: {
            fullName: 'Chofer Uno',
            phoneNumber: '+549110000',
            photoKey: 'users/u1/foto.png',
          },
        });
        const t0 = Date.now();
        await useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1');
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(dispatch.notifyCustomer).toHaveBeenCalledWith(
          'cust-1',
          'order:accepted',
          expect.objectContaining({
            driver: expect.objectContaining({ photoUrl: null }) as unknown,
          }),
        );
      },
    );

    it('asigna el chofer, setea acceptedAt, guarda y emite order:accepted', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-1',
        distributorId: 'dist-1',
        userId: 'user-drv-1',
        isEnabled: true,
        validated: true,
        user: {
          fullName: 'Chofer Uno',
          phoneNumber: '+549110000',
          photoKey: 'users/u1/foto.png',
        },
      });

      const result = await useCase.execute(
        'ord-1',
        OrderStatus.ACCEPTED,
        'drv-1',
      );

      expect(result.status).toBe(OrderStatus.ACCEPTED);
      expect(result.deliveryId).toBe('drv-1');
      expect(result.acceptedAt).toBeInstanceOf(Date);
      // Prueba de entrega con QR: al aceptar se genera el código secreto que
      // el chofer mostrará como QR (ver ConfirmDeliveryUseCase).
      expect(result.deliveryCode).toEqual(expect.stringMatching(/^\d{6}$/));
      expect(orders.save).toHaveBeenCalledWith(result);
      // Cierra la oferta de despacho del chofer que aceptó (por user_id).
      expect(orchestrator.onDriverAccepted).toHaveBeenCalledWith(
        'ord-1',
        'user-drv-1',
      );
      expect(dispatch.notifyCustomer).toHaveBeenCalledWith(
        'cust-1',
        'order:accepted',
        expect.objectContaining({
          status: OrderStatus.ACCEPTED,
          driver: {
            name: 'Chofer Uno',
            phone: '+549110000',
            photoUrl: 'https://s3/firmada-chofer',
          },
        }),
      );
      // Mismo gate de flota que `assignDelivery` y el despacho automático.
      expect(fotos.urlDe).toHaveBeenCalledWith('users/u1/foto.png');
      expect(fleetGate.assertChoferHabilitado).toHaveBeenCalledWith(
        'user-drv-1',
        'dist-1',
      );
      // Snapshot del vehículo en uso (decisión de nahue, "vehículo en uso").
      expect(result.vehicleCarId).toBe('car-1');
      expect(result.vehiclePatent).toBe('AB123CD');
      expect(result.vehicleBrand).toBe('Honda');
      expect(result.vehicleModel).toBe('Wave');
    });

    it('exige deliveryId para aceptar', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza un chofer deshabilitado', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-1',
        distributorId: 'dist-1',
        isEnabled: false,
        validated: true,
        user: {},
      });
      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechaza un chofer sin validar', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-1',
        distributorId: 'dist-1',
        isEnabled: true,
        validated: false,
        user: {},
      });
      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('lanza NotFound si el chofer no existe', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(null);
      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'ghost'),
      ).rejects.toThrow(NotFoundException);
    });

    describe('idempotencia (H-55): aceptar la asignación manual propia', () => {
      it('ACCEPTED→ACCEPTED del mismo chofer NO regenera acceptedAt ni deliveryCode', async () => {
        const acceptedAtOriginal = new Date('2026-01-01T00:00:00Z');
        orders.findByIdFull.mockResolvedValue(
          makeOrder({
            status: OrderStatus.ACCEPTED,
            deliveryId: 'drv-1',
            acceptedAt: acceptedAtOriginal,
            deliveryCode: 'CODIGO-VIEJO',
          }),
        );
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'drv-1',
          distributorId: 'dist-1',
          userId: 'user-drv-1',
          isEnabled: true,
          validated: true,
          user: { fullName: 'Chofer Uno' },
        });

        const result = await useCase.execute(
          'ord-1',
          OrderStatus.ACCEPTED,
          'drv-1',
        );

        expect(result.status).toBe(OrderStatus.ACCEPTED);
        expect(result.acceptedAt).toBe(acceptedAtOriginal);
        expect(result.deliveryCode).toBe('CODIGO-VIEJO');
        // No vuelve a cerrar ninguna oferta: nunca hubo una real (asignación
        // manual, no despacho automático).
        expect(orchestrator.onDriverAccepted).not.toHaveBeenCalled();
      });

      it('ACCEPTED de un chofer DISTINTO sí reasigna (no es el caso idempotente)', async () => {
        orders.findByIdFull.mockResolvedValue(
          makeOrder({
            status: OrderStatus.ACCEPTED,
            deliveryId: 'drv-1',
            acceptedAt: new Date('2026-01-01'),
            deliveryCode: 'CODIGO-VIEJO',
          }),
        );
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'drv-2',
          distributorId: 'dist-1',
          userId: 'user-drv-2',
          isEnabled: true,
          validated: true,
          user: { fullName: 'Chofer Dos' },
        });

        const result = await useCase.execute(
          'ord-1',
          OrderStatus.ACCEPTED,
          'drv-2',
          RoleType.ADMIN,
        );

        expect(result.deliveryId).toBe('drv-2');
        expect(result.deliveryCode).not.toBe('CODIGO-VIEJO');
        expect(orchestrator.onDriverAccepted).toHaveBeenCalledWith(
          'ord-1',
          'user-drv-2',
        );
      });
    });

    /**
     * Revisión cruzada, punto 1: `PATCH /orders/:id/status` con
     * `status=accepted` (el admin con `deliveryId`, o el propio chofer
     * aceptando desde el pool `GET /orders/available`) tenía que respetar el
     * MISMO gate de flota que `assignDelivery` y ya no era así. Los dos
     * escenarios rechazan igual.
     */
    it('CU-136/138: rechaza con el 400 del gate de flota cuando lo asigna el ADMIN (con deliveryId)', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-1',
        distributorId: 'dist-1',
        userId: 'user-drv-1',
        isEnabled: true,
        validated: true,
        user: {},
      });
      fleetGate.assertChoferHabilitado.mockRejectedValue(
        new BadRequestException(
          'No se puede asignar: VTV: venció el 14/06/2021.',
        ),
      );

      await expect(
        useCase.execute(
          'ord-1',
          OrderStatus.ACCEPTED,
          'drv-1',
          undefined, // admin: sin rol de chofer
        ),
      ).rejects.toThrow(/VTV: venció el 14\/06\/2021/);
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('CU-136/138: rechaza con el 400 del gate de flota cuando el propio CHOFER acepta desde el pool', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ deliveryId: undefined }),
      );
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-1',
        distributorId: 'dist-1',
        userId: 'user-drv-1',
        isEnabled: true,
        validated: true,
        user: {},
      });
      fleetGate.assertChoferHabilitado.mockRejectedValue(
        new BadRequestException(
          'No se puede asignar: Licencia de conducir: venció el 01/01/2020.',
        ),
      );

      await expect(
        useCase.execute(
          'ord-1',
          OrderStatus.ACCEPTED,
          'user-drv-1',
          RoleType.DELIVERY,
        ),
      ).rejects.toThrow(/Licencia de conducir: venció el 01\/01\/2020/);
      expect(orders.save).not.toHaveBeenCalled();
    });
  });

  describe('CU-149: pedido express', () => {
    const chofer = {
      deliveryId: 'drv-1',
      distributorId: 'dist-1',
      userId: 'user-drv-1',
      isEnabled: true,
      validated: true,
      user: {},
    };

    it('aceptarlo exige una moto en uso: si no la tiene, 400 y no se asigna', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ deliveryMode: OrderDeliveryMode.EXPRESS }),
      );
      deliveries.buscarPorIdOUsuario.mockResolvedValue(chofer);
      fleetGate.assertEnMoto.mockRejectedValue(
        new BadRequestException('sólo moto'),
      );

      await expect(
        useCase.execute(
          'ord-1',
          OrderStatus.ACCEPTED,
          'user-drv-1',
          RoleType.DELIVERY,
        ),
      ).rejects.toThrow('sólo moto');
      expect(fleetGate.assertEnMoto).toHaveBeenCalledWith(
        'user-drv-1',
        'dist-1',
      );
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('un chofer en moto lo acepta', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ deliveryMode: OrderDeliveryMode.EXPRESS }),
      );
      deliveries.buscarPorIdOUsuario.mockResolvedValue(chofer);

      const r = await useCase.execute(
        'ord-1',
        OrderStatus.ACCEPTED,
        'user-drv-1',
        RoleType.DELIVERY,
      );

      expect(r.status).toBe(OrderStatus.ACCEPTED);
    });

    it('un pedido común no exige moto', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue(chofer);

      await useCase.execute(
        'ord-1',
        OrderStatus.ACCEPTED,
        'user-drv-1',
        RoleType.DELIVERY,
      );

      expect(fleetGate.assertEnMoto).not.toHaveBeenCalled();
    });
  });

  describe('ON_THE_WAY', () => {
    it('F34: toma el cerrojo del chofer y, con otro pedido de la hoja en camino, 409 DRIVER_ALREADY_ON_THE_WAY sin guardar', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ACCEPTED, deliveryId: 'drv-1' }),
      );
      enCamino = { enHoja: true, otro: true };
      await expect(
        useCase.execute('ord-1', OrderStatus.ON_THE_WAY),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'DRIVER_ALREADY_ON_THE_WAY' },
      });
      const llamadas = queryRunner.manager.query.mock.calls as Array<
        [string, unknown[]]
      >;
      const cerrojo = llamadas.findIndex((c) =>
        c[0].includes('pg_advisory_xact_lock'),
      );
      const relectura = llamadas.findIndex((c) => c[0].includes('"enHoja"'));
      expect(llamadas[cerrojo][1]).toEqual(['chofer-en-camino:drv-1']);
      // La relectura va DESPUÉS del cerrojo.
      expect(relectura).toBeGreaterThan(cerrojo);
      expect(llamadas[relectura][1]).toEqual(['ord-1', 'drv-1']);
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('F34: fuera de una hoja en curso, o sin otro en camino, sale como siempre', async () => {
      for (const caso of [
        { enHoja: false, otro: true },
        { enHoja: true, otro: false },
      ]) {
        orders.findByIdFull.mockResolvedValue(
          makeOrder({ status: OrderStatus.ACCEPTED, deliveryId: 'drv-1' }),
        );
        enCamino = caso;
        await expect(
          useCase.execute('ord-1', OrderStatus.ON_THE_WAY),
        ).resolves.toMatchObject({ status: OrderStatus.ON_THE_WAY });
      }
    });

    it('onTheWayAt sale del reloj de la base, no del de Node', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ACCEPTED }),
      );
      const result = await useCase.execute('ord-1', OrderStatus.ON_THE_WAY);
      expect(result.onTheWayAt).toEqual(HORA_DE_LA_BASE);
    });
  });

  describe('DELIVERED', () => {
    it('NO marca pagado al entregar en CASH: el cobro lo confirma el chofer', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          status: OrderStatus.ON_THE_WAY,
          paymentMethod: PaymentMethod.CASH,
        }),
      );

      const result = await useCase.execute('ord-1', OrderStatus.DELIVERED);

      expect(result.deliveredAt).toBeInstanceOf(Date);
      expect(result.paymentStatus).toBe(PaymentStatus.PENDING);
    });

    it('deliveredAt sale del reloj de la base, no del de Node', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ON_THE_WAY }),
      );
      const result = await useCase.execute('ord-1', OrderStatus.DELIVERED);
      expect(result.deliveredAt).toEqual(HORA_DE_LA_BASE);
    });

    it('descuenta el stock físico por el MISMO manager de la transacción del pedido', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          status: OrderStatus.ON_THE_WAY,
          paymentMethod: PaymentMethod.CASH,
          vehicleCarId: 'car-9',
          items: [
            { gasCylinderId: 'g1', quantity: 2 },
            { gasCylinderId: 'g2', quantity: 1 },
          ] as unknown as Order['items'],
        }),
      );

      await useCase.execute('ord-1', OrderStatus.DELIVERED);

      expect(stockDelivery.onOrderDelivered).toHaveBeenCalledTimes(1);
      expect(stockDelivery.onOrderDelivered).toHaveBeenCalledWith(
        queryRunner.manager,
        expect.objectContaining({
          orderId: 'ord-1',
          vehicleCarId: 'car-9',
          items: [
            { gasCylinderId: 'g1', quantity: 2 },
            { gasCylinderId: 'g2', quantity: 1 },
          ],
        }),
      );
    });

    it('no descuenta stock si la transición a entregado es inválida', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      await expect(
        useCase.execute('ord-1', OrderStatus.DELIVERED),
      ).rejects.toThrow();
      expect(stockDelivery.onOrderDelivered).not.toHaveBeenCalled();
    });

    it('publica "pedido entregado" después de confirmar la entrega, con lo que necesitan cuenta corriente y comisiones', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          status: OrderStatus.ON_THE_WAY,
          paymentMethod: PaymentMethod.ACCOUNT,
          totalAmount: 2500,
        }),
      );

      await useCase.execute('ord-1', OrderStatus.DELIVERED);

      expect(eventos.emitAsync).toHaveBeenCalledTimes(1);
      expect(eventos.emitAsync).toHaveBeenCalledWith(
        EVENTO_PEDIDO_ENTREGADO,
        expect.objectContaining({
          orderId: 'ord-1',
          paymentMethod: PaymentMethod.ACCOUNT,
          totalAmount: 2500,
          deliveredAt: HORA_DE_LA_BASE,
        }),
      );
      expect(
        queryRunner.commitTransaction.mock.invocationCallOrder[0],
      ).toBeLessThan(eventos.emitAsync.mock.invocationCallOrder[0]);
    });

    it('si un oyente del evento falla, la entrega se confirma igual', async () => {
      eventos.emitAsync.mockRejectedValue(new Error('oyente caído'));
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ON_THE_WAY }),
      );
      const result = await useCase.execute('ord-1', OrderStatus.DELIVERED);
      expect(result.status).toBe(OrderStatus.DELIVERED);
    });

    it('otros estados no publican el evento', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ACCEPTED }),
      );
      await useCase.execute('ord-1', OrderStatus.ON_THE_WAY);
      expect(eventos.emitAsync).not.toHaveBeenCalled();
    });

    it('NO marca pagado si el método es MERCADOPAGO (lo resuelve el webhook)', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          status: OrderStatus.ON_THE_WAY,
          paymentMethod: PaymentMethod.MERCADOPAGO,
        }),
      );

      const result = await useCase.execute('ord-1', OrderStatus.DELIVERED);

      expect(result.paymentStatus).toBe(PaymentStatus.PENDING);
    });
  });

  describe('PENDING (desajuste 1: volver a pending libera al chofer)', () => {
    it('un admin libera un pedido con chofer asignado: delega en el camino único SIN exigir dueño (ReleaseOrderUseCase)', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ACCEPTED, deliveryId: 'drv-1' }),
      );
      const liberado = makeOrder({ status: OrderStatus.PENDING });
      releaseOrderUseCase.execute.mockResolvedValue(liberado);

      const result = await useCase.execute(
        'ord-1',
        OrderStatus.PENDING,
        undefined,
        RoleType.ADMIN,
      );

      // Un admin puede liberar cualquier pedido: no se le exige ser "dueño"
      // (segundo argumento `undefined`, ver punto 6 de la segunda revisión).
      expect(releaseOrderUseCase.execute).toHaveBeenCalledWith(
        'ord-1',
        undefined,
      );
      expect(result).toBe(liberado);
      // No duplica la mutación: no guarda ni emite side-effects acá.
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('un chofer libera lo suyo: pasa su propio user_id para que ReleaseOrderUseCase revalide dueño DENTRO del lock (punto 6)', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ACCEPTED, deliveryId: 'drv-1' }),
      );
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-1',
      });
      const liberado = makeOrder({ status: OrderStatus.PENDING });
      releaseOrderUseCase.execute.mockResolvedValue(liberado);

      await useCase.execute(
        'ord-1',
        OrderStatus.PENDING,
        'user-drv-1',
        RoleType.DELIVERY,
      );

      // Para un chofer, el `deliveryId` que llega acá YA es su propio
      // `user_id` (lo resuelve el controller): se pasa tal cual, es lo que
      // `ReleaseOrderUseCase` compara contra `order.delivery.userId` dentro
      // del lock.
      expect(releaseOrderUseCase.execute).toHaveBeenCalledWith(
        'ord-1',
        'user-drv-1',
      );
    });

    it('un chofer sólo puede liberar lo que tiene asignado', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ACCEPTED, deliveryId: 'drv-1' }),
      );
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-ajeno',
      });

      await expect(
        useCase.execute(
          'ord-1',
          OrderStatus.PENDING,
          'user-ajeno',
          RoleType.DELIVERY,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(releaseOrderUseCase.execute).not.toHaveBeenCalled();
    });
  });

  describe('RESERVED → PENDING (punto 9: activación manual con las mismas condiciones que el cron)', () => {
    it('activa si la seña está paga y el día ya llegó', async () => {
      const ayer = new Date();
      ayer.setDate(ayer.getDate() - 1);
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          status: OrderStatus.RESERVED,
          depositPaid: true,
          scheduledDate: ayer.toISOString().slice(0, 10),
        }),
      );

      const result = await useCase.execute(
        'ord-1',
        OrderStatus.PENDING,
        undefined,
        RoleType.ADMIN,
      );

      expect(result.status).toBe(OrderStatus.PENDING);
      // Desde la activación corre la espera de chofer.
      expect(result.availableSince).toBeInstanceOf(Date);
      expect(orders.save).toHaveBeenCalled();
      expect(orchestrator.offerToNextDriver).toHaveBeenCalledWith(result);
      expect(releaseOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('rechaza activarla si la seña no está paga', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          status: OrderStatus.RESERVED,
          depositPaid: false,
          scheduledDate: '2020-01-01',
        }),
      );

      await expect(
        useCase.execute(
          'ord-1',
          OrderStatus.PENDING,
          undefined,
          RoleType.ADMIN,
        ),
      ).rejects.toThrow(ReservationNotActivableError);
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('rechaza activarla antes de la fecha agendada', async () => {
      const mañana = new Date();
      mañana.setDate(mañana.getDate() + 1);
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          status: OrderStatus.RESERVED,
          depositPaid: true,
          scheduledDate: mañana.toISOString().slice(0, 10),
        }),
      );

      await expect(
        useCase.execute(
          'ord-1',
          OrderStatus.PENDING,
          undefined,
          RoleType.ADMIN,
        ),
      ).rejects.toThrow(ReservationNotActivableError);
    });

    it('un chofer no puede activar una reserva a mano', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          status: OrderStatus.RESERVED,
          depositPaid: true,
          scheduledDate: '2020-01-01',
        }),
      );

      await expect(
        useCase.execute(
          'ord-1',
          OrderStatus.PENDING,
          'drv-1',
          RoleType.DELIVERY,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('punto 7 (segunda revisión): la activación usa el MISMO lock pesimista que cancelar/liberar', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          status: OrderStatus.RESERVED,
          depositPaid: true,
          scheduledDate: '2020-01-01',
        }),
      );

      await useCase.execute(
        'ord-1',
        OrderStatus.PENDING,
        undefined,
        RoleType.ADMIN,
      );

      expect(queryBuilder.setLock).toHaveBeenCalledWith(
        'pessimistic_write',
        undefined,
        ['ord'],
      );
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('punto 7: si el CRON ya activó la reserva mientras se pedía el lock, no duplica la oferta (idempotente, sin error)', async () => {
      // Primera lectura (en `handlePendingTarget`, sin lock): todavía RESERVED.
      // Segunda lectura (YA con el lock, dentro de `activarReservaConLock`):
      // el cron (`ReservationService.activateDueReservations`) ganó la
      // carrera y la dejó PENDING. Sin este chequeo, acá se volvería a
      // ofertar el mismo pedido una segunda vez.
      orders.findByIdFull
        .mockResolvedValueOnce(
          makeOrder({
            status: OrderStatus.RESERVED,
            depositPaid: true,
            scheduledDate: '2020-01-01',
          }),
        )
        .mockResolvedValueOnce(
          makeOrder({
            status: OrderStatus.PENDING,
            depositPaid: true,
            scheduledDate: '2020-01-01',
          }),
        );

      const result = await useCase.execute(
        'ord-1',
        OrderStatus.PENDING,
        undefined,
        RoleType.ADMIN,
      );

      expect(result.status).toBe(OrderStatus.PENDING);
      expect(orchestrator.offerToNextDriver).not.toHaveBeenCalled();
      expect(dispatch.notifyAdmins).not.toHaveBeenCalledWith(
        'order:pending',
        expect.anything(),
        expect.anything(),
      );
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
    });
  });

  describe('CANCELLED (desajuste 2: mismo efecto que /cancel)', () => {
    it('delega en CancelOrderUseCase con el actor mapeado y el userId del token', async () => {
      const cancelado = makeOrder({ status: OrderStatus.CANCELLED });
      cancelOrderUseCase.execute.mockResolvedValue(cancelado);

      const result = await useCase.execute(
        'ord-1',
        OrderStatus.CANCELLED,
        undefined,
        RoleType.ADMIN,
        'admin-1',
        'El cliente pidió cancelar por teléfono',
      );

      expect(cancelOrderUseCase.execute).toHaveBeenCalledWith(
        'ord-1',
        'admin-1',
        'admin',
        'El cliente pidió cancelar por teléfono',
      );
      expect(result).toBe(cancelado);
      // No duplica la política: no busca el pedido ni emite side-effects acá,
      // todo ya lo hizo CancelOrderUseCase.
      expect(orders.findByIdFull).not.toHaveBeenCalled();
    });

    it('mapea RoleType.DELIVERY a "driver" (libera, no cancela)', async () => {
      cancelOrderUseCase.execute.mockResolvedValue(makeOrder());

      await useCase.execute(
        'ord-1',
        OrderStatus.CANCELLED,
        undefined,
        RoleType.DELIVERY,
        'user-drv-1',
      );

      expect(cancelOrderUseCase.execute).toHaveBeenCalledWith(
        'ord-1',
        'user-drv-1',
        'driver',
        undefined,
      );
    });

    it('rechaza cancelar sin un actor identificado', async () => {
      await expect(
        useCase.execute(
          'ord-1',
          OrderStatus.CANCELLED,
          undefined,
          RoleType.ADMIN,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(cancelOrderUseCase.execute).not.toHaveBeenCalled();
    });
  });

  describe('H-54: el panel recibe order:on-the-way, sin el alias viejo', () => {
    it('emite order:on-the-way y no order:on_the_way', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ACCEPTED, deliveryId: 'drv-1' }),
      );
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-1',
        distributorId: 'dist-1',
        user: { userId: 'user-drv-1' },
      });

      await useCase.execute('ord-1', OrderStatus.ON_THE_WAY);

      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:on-the-way',
        expect.objectContaining({ orderId: 'ord-1' }),
        'dist-1',
      );
      expect(dispatch.notifyAdmins).not.toHaveBeenCalledWith(
        'order:on_the_way',
        expect.anything(),
        expect.anything(),
      );
    });

    it('aceptado emite order:accepted y nada más', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.PENDING }),
      );
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-1',
        distributorId: 'dist-1',
        isEnabled: true,
        validated: true,
        user: {},
      });

      await useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1');

      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:accepted',
        expect.anything(),
        'dist-1',
      );
      expect(dispatch.notifyAdmins).not.toHaveBeenCalledWith(
        'order:on-the-way',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('side-effects best-effort', () => {
    it('un error del puerto de tiempo real NO rompe la actualización', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ON_THE_WAY }),
      );
      dispatch.notifyCustomer.mockImplementation(() => {
        throw new Error('socket caído');
      });

      const result = await useCase.execute('ord-1', OrderStatus.DELIVERED);

      expect(result.status).toBe(OrderStatus.DELIVERED);
      expect(orders.save).toHaveBeenCalled();
    });

    it('un error de notificación push NO rompe la actualización', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ON_THE_WAY }),
      );

      notifications.sendOrderConfirmation.mockRejectedValue(
        new Error('FCM caído'),
      );

      const result = await useCase.execute('ord-1', OrderStatus.DELIVERED);

      expect(result.status).toBe(OrderStatus.DELIVERED);
    });
  });
});
