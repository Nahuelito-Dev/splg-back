import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { OrderService } from './order.service';
import {
  AssignmentMethod,
  Order,
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from './entities/order.entity';
import { DispatchOfferStatus } from './entities/dispatch-offer.entity';
import type { Repository, DataSource, EntityManager } from 'typeorm';
import type { DeliveryService } from '../delivery/delivery.service';
import type { RealtimeDispatchPort } from './domain/ports/realtime-dispatch.port';
import type { OrderRepositoryPort } from './domain/ports/order.repository.port';
import type { CreateOrderUseCase } from './application/create-order.use-case';
import type { UpdateOrderStatusUseCase } from './application/update-order-status.use-case';
import type { CancelOrderUseCase } from './application/cancel-order.use-case';
import type { ConfirmDeliveryUseCase } from './application/confirm-delivery.use-case';
import type { DispatchOrchestratorService } from './application/dispatch-orchestrator.service';
import type { DispatchSettingsService } from '../distributor/dispatch-settings.service';
import { conRespuestaVigilada } from '../common/interceptors/respuesta-incompleta';
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
/** La hora del servidor de la base, distinta a propósito de la de Node. */
const HORA_DE_LA_BASE = new Date('2030-01-01T10:00:00.000Z');

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
  let dispatchOffers: {
    withdrawOtherActiveOffers: jest.Mock;
    isInPlannedRouteSheet: jest.Mock;
  };
  let orchestrator: { onOrderAssigned: jest.Mock };
  let dispatchSettings: { obtener: jest.Mock };
  let dataSource: { createQueryRunner: jest.Mock; transaction: jest.Mock };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: {
      createQueryBuilder: jest.Mock;
      find: jest.Mock;
      save: jest.Mock<Promise<Order>, [Order]>;
      query: jest.Mock;
    };
  };
  let queryBuilder: {
    setLock: jest.Mock;
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getOne: jest.Mock;
  };
  let truckGate: { assertPuedeAsignar: jest.Mock };
  let fleetGate: {
    assertChoferHabilitado: jest.Mock;
    assertEnMoto: jest.Mock;
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
      andWhere: jest.fn().mockReturnThis(),
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
        query: jest.fn((sql: string, params?: [string[]]) =>
          sql.includes('clock_timestamp')
            ? Promise.resolve([{ ahora: HORA_DE_LA_BASE }])
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
        // Devuelve lo mismo que se guardó, como hace TypeORM.
        save: jest.fn((o: Order) => Promise.resolve(o)),
      },
    };
    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      transaction: jest.fn((fn: (m: unknown) => unknown) =>
        fn({ ...queryRunner.manager, update: jest.fn().mockResolvedValue({}) }),
      ),
    };
    dispatch = {
      notifyAdmins: jest.fn(),
      notifyDriverNewOrder: jest.fn(),
      notifyDriverOrderCancelled: jest.fn(),
      stopTracking: jest.fn(),
    };
    dispatchOffers = {
      withdrawOtherActiveOffers: jest.fn().mockResolvedValue([]),
      isInPlannedRouteSheet: jest.fn().mockResolvedValue(false),
    };
    orchestrator = { onOrderAssigned: jest.fn().mockResolvedValue(undefined) };
    dispatchSettings = {
      obtener: jest
        .fn()
        .mockResolvedValue({ radiusStepsKm: [5], offerTtlSeconds: 30 }),
    };
    const deliveries = {
      findById: jest.fn((id: string) => Promise.resolve(CHOFERES[id])),
      assertElegibleParaAsignacion: jest.fn(),
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
    truckGate = { assertPuedeAsignar: jest.fn().mockResolvedValue(undefined) };
    service = new OrderService(
      {} as unknown as Repository<Order>,
      deliveries as unknown as DeliveryService,
      dispatch as unknown as RealtimeDispatchPort,
      {} as unknown as OrderRepositoryPort,
      {} as unknown as CreateOrderUseCase,
      {} as unknown as UpdateOrderStatusUseCase,
      {} as unknown as CancelOrderUseCase,
      {} as unknown as ConfirmDeliveryUseCase,
      orchestrator as unknown as DispatchOrchestratorService,
      dispatchOffers as unknown as DispatchOfferRepositoryPort,
      {} as unknown as NotificationPort,
      dataSource as unknown as DataSource,
      fleetGate as unknown as FleetDispatchLockService,
      truckGate as unknown as import('./domain/ports/truck-load-gate.port').TruckLoadGatePort,
      {} as never,
      dispatchSettings as unknown as DispatchSettingsService,
      {} as never,
    );
    // La respuesta final releé el pedido; en vez de volver a pedir el lock
    // (consumiría la cola de `mockResolvedValueOnce` de cada test), devuelve
    // lo que efectivamente se guardó — el mock de `save` ya hace de espejo.
    jest.spyOn(service, 'findOne').mockImplementation(() => {
      const calls = queryRunner.manager.save.mock.calls;
      return Promise.resolve(calls[calls.length - 1][0]);
    });
  });

  it('con distribuidora, el lock filtra por ella; sin ella no agrega filtro', async () => {
    await service.assignDelivery(PEDIDO, CHOFER, 'dist-1');
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'ord.distributorId = :distributorId',
      { distributorId: 'dist-1' },
    );
    queryBuilder.andWhere.mockClear();
    await service.assignDelivery(PEDIDO, CHOFER);
    expect(queryBuilder.andWhere).not.toHaveBeenCalled();
  });

  it('relee los renglones DESPUÉS del lock: guarda los vigentes y no los que trajo el JOIN', async () => {
    const vigentes = [{ orderItemId: 'nuevo', quantity: 4 }];
    queryRunner.manager.find.mockResolvedValue(vigentes);
    await service.assignDelivery(PEDIDO, CHOFER);
    const [guardado] = queryRunner.manager.save.mock.calls[0];
    expect(guardado.items).toBe(vigentes);
  });

  it('acceptedAt de la asignación sale del reloj de la base, no del de Node', async () => {
    const result = await service.assignDelivery(PEDIDO, CHOFER);
    expect(result.acceptedAt).toEqual(HORA_DE_LA_BASE);
  });

  it('repetir la asignación al MISMO chofer no regenera el código ni el acceptedAt (el QR sigue sirviendo)', async () => {
    const asignado = makeLockedOrder({
      status: OrderStatus.ACCEPTED,
      deliveryId: CHOFER,
      deliveryCode: 'CODIGO-VIEJO',
      acceptedAt: new Date('2030-01-01T09:00:00.000Z'),
    });
    queryBuilder.getOne.mockResolvedValue(asignado);
    jest.spyOn(service, 'findOne').mockResolvedValue(asignado);
    const result = await service.assignDelivery(PEDIDO, CHOFER);
    expect(result.deliveryCode).toBe('CODIGO-VIEJO');
    expect(result.acceptedAt).toEqual(new Date('2030-01-01T09:00:00.000Z'));
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(dispatch.notifyDriverNewOrder).not.toHaveBeenCalled();
  });

  it('si falla la relectura después del commit, responde con el pedido asignado (no un 500 que invite a reintentar)', async () => {
    jest
      .spyOn(service, 'findOne')
      .mockRejectedValue(new Error('conexión caída'));
    const { valor: result, incompleta } = await conRespuestaVigilada(() =>
      service.assignDelivery(PEDIDO, CHOFER),
    );
    expect(result.status).toBe(OrderStatus.ACCEPTED);
    expect(result.deliveryCode).toMatch(/\S{4,}/);
    expect(incompleta).toBe(true);
  });

  it('si falla un aviso posterior al commit, la asignación igual responde bien', async () => {
    dispatch.notifyAdmins.mockImplementation(() => {
      throw new Error('socket caído');
    });
    const result = await service.assignDelivery(PEDIDO, CHOFER);
    expect(result.status).toBe(OrderStatus.ACCEPTED);
  });

  it('genera el código de entrega para el QR', async () => {
    const result = await service.assignDelivery(PEDIDO, CHOFER);
    expect(result.status).toBe(OrderStatus.ACCEPTED);
    expect(result.deliveryCode).toMatch(/\S{4,}/);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  describe('método de asignación (M1)', () => {
    it('la asignación del admin queda como manual_override', async () => {
      const r = await service.assignDelivery(PEDIDO, CHOFER);
      expect(r.assignmentMethod).toBe(AssignmentMethod.MANUAL_OVERRIDE);
    });

    it('el lote de recorrido queda como batch', async () => {
      const r = await service.assignDelivery(PEDIDO, CHOFER, 'dist', {
        soloSiLibre: true,
        metodo: AssignmentMethod.BATCH,
      });
      expect(r.assignmentMethod).toBe(AssignmentMethod.BATCH);
    });

    it('la hoja de ruta queda como route_sheet', async () => {
      const r = await service.assignDelivery(PEDIDO, CHOFER, 'dist', {
        soloSiLibre: true,
        metodo: AssignmentMethod.ROUTE_SHEET,
      });
      expect(r.assignmentMethod).toBe(AssignmentMethod.ROUTE_SHEET);
    });

    it('repetir la asignación al mismo chofer no pisa el método que ya tenía', async () => {
      queryBuilder.getOne.mockResolvedValueOnce(
        makeLockedOrder({
          status: OrderStatus.ACCEPTED,
          deliveryId: CHOFER,
          assignmentMethod: AssignmentMethod.AUTOMATIC,
        }),
      );
      const r = await service.assignDelivery(PEDIDO, CHOFER);
      expect(r.assignmentMethod).toBe(AssignmentMethod.AUTOMATIC);
    });
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
    // A otro chofer: ahí sí se regenera el código (al mismo, no: ver más arriba).
    const segundo = (await service.assignDelivery(PEDIDO, CHOFER_B))
      .deliveryCode;

    expect(segundo).not.toBe(primero);
  });

  describe('soloSiLibre (lote de recorrido, M4)', () => {
    const tomadoPorB = () =>
      makeLockedOrder({
        status: OrderStatus.ACCEPTED,
        deliveryId: CHOFER_B,
        delivery: { deliveryId: CHOFER_B, userId: CHOFER_B_USER_ID } as never,
      });

    it('no le saca a otro chofer un pedido que ya tomó: 409 y no guarda nada', async () => {
      queryBuilder.getOne.mockResolvedValueOnce(tomadoPorB());

      await expect(
        service.assignDelivery(PEDIDO, CHOFER, undefined, {
          soloSiLibre: true,
        }),
      ).rejects.toThrow(
        new ConflictException('El pedido ya no está disponible'),
      );
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('sin la opción, la asignación manual del admin sí reasigna (no cambia)', async () => {
      queryBuilder.getOne.mockResolvedValueOnce(tomadoPorB());

      await service.assignDelivery(PEDIDO, CHOFER);

      expect(queryRunner.manager.save).toHaveBeenCalled();
    });

    it('un pedido libre se asigna y repetir al mismo chofer sigue siendo idempotente', async () => {
      queryBuilder.getOne.mockResolvedValueOnce(makeLockedOrder());
      await service.assignDelivery(PEDIDO, CHOFER, undefined, {
        soloSiLibre: true,
      });
      expect(queryRunner.manager.save).toHaveBeenCalledTimes(1);

      queryBuilder.getOne.mockResolvedValueOnce(
        makeLockedOrder({
          status: OrderStatus.ACCEPTED,
          deliveryId: CHOFER,
          delivery: { deliveryId: CHOFER, userId: CHOFER_USER_ID } as never,
        }),
      );
      await service.assignDelivery(PEDIDO, CHOFER, undefined, {
        soloSiLibre: true,
      });
      expect(queryRunner.manager.save).toHaveBeenCalledTimes(1);
    });
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
        assigned: true,
      }),
    );
  });

  it('CU-171: el aviso al chofer vence con la ventana configurada de la distribuidora del pedido', async () => {
    dispatchSettings.obtener.mockResolvedValue({
      radiusStepsKm: [5],
      offerTtlSeconds: 90,
    });
    const antes = Date.now();

    await service.assignDelivery(PEDIDO, CHOFER);

    expect(dispatchSettings.obtener).toHaveBeenCalledWith('dist');
    const [, payload] = dispatch.notifyDriverNewOrder.mock.calls[0] as [
      string,
      { expiresAt: string },
    ];
    const vencimiento = new Date(payload.expiresAt).getTime();
    expect(vencimiento - antes).toBeGreaterThanOrEqual(90_000);
    expect(vencimiento - antes).toBeLessThan(95_000);
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

  it('F34: un pedido que está en una hoja de ruta no se asigna ni se reasigna a mano (409 ORDER_IN_ROUTE_SHEET), con el pedido bloqueado', async () => {
    dispatchOffers.isInPlannedRouteSheet.mockResolvedValue(true);

    await expect(
      service.assignDelivery(PEDIDO, CHOFER, 'dist-1'),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'ORDER_IN_ROUTE_SHEET' },
    });
    expect(dispatchOffers.isInPlannedRouteSheet).toHaveBeenCalledWith(
      PEDIDO,
      queryRunner.manager,
    );
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('F34 E4: el inicio de la hoja pide la excepción explícita para ESA hoja y SU chofer; si igual está retenido (otra hoja u otro chofer), 409', async () => {
    dispatchOffers.isInPlannedRouteSheet.mockResolvedValue(false);
    await service.assignDelivery(PEDIDO, CHOFER, 'dist-1', {
      soloSiLibre: true,
      hojaDeRuta: 'hoja-1',
    });
    expect(dispatchOffers.isInPlannedRouteSheet).toHaveBeenCalledWith(
      PEDIDO,
      queryRunner.manager,
      { batchId: 'hoja-1', deliveryId: CHOFER },
    );
    dispatchOffers.isInPlannedRouteSheet.mockResolvedValue(true);
    await expect(
      service.assignDelivery(PEDIDO, CHOFER, 'dist-1', {
        soloSiLibre: true,
        hojaDeRuta: 'otra-hoja',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'ORDER_IN_ROUTE_SHEET' },
    });
  });

  describe('hoja de ruta (F34)', () => {
    const DE_LA_HOJA = {
      carId: 'auto-hoja',
      patent: 'HOJ123',
      brand: 'Ford',
      model: 'F-100',
    };

    it('la hoja le entrega sus pedidos al chofer: sin los controles de la jornada, con el vehículo de la hoja y sin aviso por pedido', async () => {
      const r = await service.assignDelivery(PEDIDO, CHOFER, 'dist-1', {
        soloSiLibre: true,
        hojaDeRuta: 'hoja-1',
        vehiculoDeLaHoja: DE_LA_HOJA,
      });
      expect(truckGate.assertPuedeAsignar).not.toHaveBeenCalled();
      expect(fleetGate.assertChoferHabilitado).not.toHaveBeenCalled();
      expect(fleetGate.vehiculoEnUsoDelChofer).not.toHaveBeenCalled();
      expect(r).toMatchObject({
        status: OrderStatus.ACCEPTED,
        vehicleCarId: 'auto-hoja',
        vehiclePatent: 'HOJ123',
      });
      expect(dispatch.notifyDriverNewOrder).not.toHaveBeenCalled();
    });

    it('postergarEntrega: en camino → aceptado con el mismo chofer, corta el seguimiento y avisa al panel', async () => {
      queryBuilder.getOne.mockResolvedValue(
        makeLockedOrder({ status: OrderStatus.ON_THE_WAY, deliveryId: CHOFER }),
      );
      const r = await service.postergarEntrega(PEDIDO, CHOFER);
      expect(r.status).toBe(OrderStatus.ACCEPTED);
      expect(r.deliveryId).toBe(CHOFER);
      expect(dispatch.stopTracking).toHaveBeenCalledWith(CHOFER_USER_ID);
      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:accepted',
        { orderId: PEDIDO, status: OrderStatus.ACCEPTED },
        'dist',
      );
    });

    it('postergarEntrega: ya aceptado es idempotente; de otro chofer o en otro estado, 409; inexistente, 404', async () => {
      queryBuilder.getOne.mockResolvedValue(
        makeLockedOrder({ status: OrderStatus.ACCEPTED, deliveryId: CHOFER }),
      );
      expect((await service.postergarEntrega(PEDIDO, CHOFER)).status).toBe(
        OrderStatus.ACCEPTED,
      );
      queryBuilder.getOne.mockResolvedValue(
        makeLockedOrder({
          status: OrderStatus.ON_THE_WAY,
          deliveryId: CHOFER_B,
        }),
      );
      await expect(
        service.postergarEntrega(PEDIDO, CHOFER),
      ).rejects.toMatchObject({
        status: 409,
      });
      queryBuilder.getOne.mockResolvedValue(
        makeLockedOrder({ status: OrderStatus.DELIVERED, deliveryId: CHOFER }),
      );
      await expect(
        service.postergarEntrega(PEDIDO, CHOFER),
      ).rejects.toMatchObject({
        status: 409,
      });
      queryBuilder.getOne.mockResolvedValue(null);
      await expect(service.postergarEntrega(PEDIDO, CHOFER)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('C5: postergarEntregaEn usa la transacción de quien llama y no avisa; los avisos van aparte, después del commit', async () => {
      queryBuilder.getOne.mockResolvedValue(
        makeLockedOrder({ status: OrderStatus.ON_THE_WAY, deliveryId: CHOFER }),
      );
      const save = jest.fn((o: Order) => Promise.resolve(o));
      const externo = { ...queryRunner.manager, save };
      const r = await service.postergarEntregaEn(
        externo as unknown as EntityManager,
        PEDIDO,
        CHOFER,
      );
      expect(r.status).toBe(OrderStatus.ACCEPTED);
      expect(save).toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(dispatch.notifyAdmins).not.toHaveBeenCalled();
      await service.avisarPostergada(r, CHOFER);
      expect(dispatch.stopTracking).toHaveBeenCalledWith(CHOFER_USER_ID);
      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:accepted',
        { orderId: PEDIDO, status: OrderStatus.ACCEPTED },
        'dist',
      );
    });

    it('C5: reprogramarEntrega con la transacción de quien llama no abre otra', async () => {
      queryBuilder.getOne.mockResolvedValue(
        makeLockedOrder({ status: OrderStatus.PENDING, deliveryId: null }),
      );
      const update = jest.fn().mockResolvedValue({});
      const externo = { ...queryRunner.manager, update };
      await service.reprogramarEntrega(
        PEDIDO,
        '2026-11-16',
        externo as unknown as EntityManager,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith(
        Order,
        { orderId: PEDIDO },
        { scheduledDate: '2026-11-16', timeSlotId: null },
      );
    });

    it('reprogramarEntrega: un pendiente sin chofer pasa a la fecha nueva SIN franja fija; otro estado o con chofer, 409', async () => {
      queryBuilder.getOne.mockResolvedValue(
        makeLockedOrder({
          status: OrderStatus.PENDING,
          deliveryId: null,
          timeSlotId: 'franja-1',
        }),
      );
      const update = jest.fn().mockResolvedValue({});
      dataSource.transaction.mockImplementationOnce(
        (fn: (m: unknown) => unknown) => fn({ ...queryRunner.manager, update }),
      );
      const r = await service.reprogramarEntrega(PEDIDO, '2026-11-16');
      expect(r.scheduledDate).toBe('2026-11-16');
      expect(r.timeSlotId).toBeNull();
      expect(update).toHaveBeenCalledWith(
        Order,
        { orderId: PEDIDO },
        { scheduledDate: '2026-11-16', timeSlotId: null },
      );
      queryBuilder.getOne.mockResolvedValue(
        makeLockedOrder({ status: OrderStatus.ACCEPTED, deliveryId: CHOFER }),
      );
      await expect(
        service.reprogramarEntrega(PEDIDO, '2026-11-16'),
      ).rejects.toMatchObject({ status: 409 });
      queryBuilder.getOne.mockResolvedValue(null);
      await expect(
        service.reprogramarEntrega(PEDIDO, '2026-11-16'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('pedido inexistente: 404 dentro de la transacción', async () => {
    queryBuilder.getOne.mockResolvedValue(null);

    await expect(service.assignDelivery(PEDIDO, CHOFER)).rejects.toThrow(
      NotFoundException,
    );
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('punto 5: retira en la misma transacción las ofertas abiertas a otros choferes y les avisa por socket', async () => {
    dispatchOffers.withdrawOtherActiveOffers.mockResolvedValue(['user-otro']);

    await service.assignDelivery(PEDIDO, CHOFER);

    expect(dispatchOffers.withdrawOtherActiveOffers).toHaveBeenCalledWith(
      queryRunner.manager,
      PEDIDO,
      CHOFER_USER_ID,
      DispatchOfferStatus.SUPERSEDED,
    );
    expect(
      dispatchOffers.withdrawOtherActiveOffers.mock.invocationCallOrder[0],
    ).toBeLessThan(queryRunner.commitTransaction.mock.invocationCallOrder[0]);
    expect(dispatch.notifyDriverOrderCancelled).toHaveBeenCalledWith(
      'user-otro',
      expect.objectContaining({ orderId: PEDIDO }),
    );
  });

  it('punto 5: si la asignación se deshace, no se avisa a los choferes de las otras ofertas', async () => {
    dispatchOffers.withdrawOtherActiveOffers.mockResolvedValue(['user-otro']);
    queryRunner.commitTransaction.mockRejectedValue(new Error('commit'));

    await expect(service.assignDelivery(PEDIDO, CHOFER)).rejects.toThrow();
    expect(dispatch.notifyDriverOrderCancelled).not.toHaveBeenCalledWith(
      'user-otro',
      expect.anything(),
    );
  });

  it('el chofer asignado a mano queda registrado como quien tuvo el pedido (no se le re-ofrece si lo libera)', async () => {
    await service.assignDelivery(PEDIDO, CHOFER);

    expect(orchestrator.onOrderAssigned).toHaveBeenCalledWith(
      PEDIDO,
      CHOFER_USER_ID,
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

  it('CU-149: un pedido express sólo se asigna a un chofer con una moto en uso (400) y no se asigna', async () => {
    queryBuilder.getOne.mockResolvedValueOnce(
      makeLockedOrder({ deliveryMode: OrderDeliveryMode.EXPRESS }),
    );
    fleetGate.assertEnMoto.mockRejectedValue(
      new BadRequestException('sólo moto'),
    );

    await expect(service.assignDelivery(PEDIDO, CHOFER)).rejects.toThrow(
      'sólo moto',
    );
    expect(fleetGate.assertEnMoto).toHaveBeenCalledWith(CHOFER_USER_ID, 'dist');
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
  });

  it.each(['pending', 'failed'])(
    'F9: un pedido de Mercado Pago con el pago %s no se asigna a mano (409) y se hace rollback',
    async (paymentStatus) => {
      queryBuilder.getOne.mockResolvedValueOnce(
        makeLockedOrder({
          paymentMethod: PaymentMethod.MERCADOPAGO,
          paymentStatus: paymentStatus as PaymentStatus,
        }),
      );

      await expect(
        service.assignDelivery(PEDIDO, CHOFER),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(fleetGate.assertChoferHabilitado).not.toHaveBeenCalled();
    },
  );

  it('F9: una reserva de Mercado Pago con la seña paga se asigna (el saldo se cobra al entregar)', async () => {
    queryBuilder.getOne.mockResolvedValueOnce(
      makeLockedOrder({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PENDING,
        depositPaid: true,
      }),
    );
    await service.assignDelivery(PEDIDO, CHOFER);
    expect(queryRunner.manager.save).toHaveBeenCalled();
  });

  it('F9: un pedido de Mercado Pago cerrado no da el 409 del pago: da la transición inválida', async () => {
    queryBuilder.getOne.mockResolvedValueOnce(
      makeLockedOrder({
        status: OrderStatus.CANCELLED,
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PENDING,
      }),
    );
    await expect(
      service.assignDelivery(PEDIDO, CHOFER),
    ).rejects.not.toBeInstanceOf(ConflictException);
  });

  it('F9: un pedido de Mercado Pago ya pagado se asigna como cualquiera', async () => {
    queryBuilder.getOne.mockResolvedValueOnce(
      makeLockedOrder({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PAID,
      }),
    );
    await service.assignDelivery(PEDIDO, CHOFER);
    expect(queryRunner.manager.save).toHaveBeenCalled();
  });

  it('CU-149: un pedido común no exige moto', async () => {
    await service.assignDelivery(PEDIDO, CHOFER);

    expect(fleetGate.assertEnMoto).not.toHaveBeenCalled();
  });

  it('D5: si la distribuidora exige carga y el chofer no la tiene, no se asigna (400) y se hace rollback', async () => {
    truckGate.assertPuedeAsignar.mockRejectedValue(
      new BadRequestException('El chofer no tiene la carga del día abierta'),
    );

    await expect(service.assignDelivery(PEDIDO, CHOFER)).rejects.toThrow(
      'El chofer no tiene la carga del día abierta',
    );
    // Con la transacción de la asignación: el lock de la carga es de ella.
    expect(truckGate.assertPuedeAsignar).toHaveBeenCalledWith(
      'dist',
      CHOFER,
      queryRunner.manager,
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
      {
        onOrderAssigned: jest.fn().mockResolvedValue(undefined),
      } as unknown as DispatchOrchestratorService,
      dispatchOffers as unknown as DispatchOfferRepositoryPort,
      {} as unknown as NotificationPort,
      dataSource as unknown as DataSource,
      fleetGate as unknown as FleetDispatchLockService,
      {
        assertPuedeAsignar: jest.fn().mockResolvedValue(undefined),
      } as unknown as import('./domain/ports/truck-load-gate.port').TruckLoadGatePort,
      {} as never,
      {} as never,
      {} as never,
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
