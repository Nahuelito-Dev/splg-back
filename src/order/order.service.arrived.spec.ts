import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
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
  let dispatchSettings: { obtener: jest.Mock };
  /** Redis de mentira: lo justo para la marca de «ya avisé». */
  let marcas: Map<string, string>;
  let redis: {
    get: jest.Mock;
    setIfAbsent: jest.Mock;
    setex: jest.Mock;
    del: jest.Mock;
  };
  let service: OrderService;

  const pedidoEnCamino = () => ({
    orderId: PEDIDO,
    customerId: CLIENTE,
    deliveryId: DELIVERY_ASIGNADO,
    status: OrderStatus.ON_THE_WAY,
    delivery: { user: { fullName: 'Ana Gómez' } },
    distributorId: 'd1',
  });

  const armar = (
    pedido:
      | import('./entities/order.entity').Order
      | null = pedidoEnCamino() as unknown as import('./entities/order.entity').Order,
  ) => {
    dispatch = { notifyCustomer: jest.fn() };
    notifications = {
      sendArrivalPushToCustomer: jest.fn().mockResolvedValue('sent'),
    };
    deliveries = {
      buscarPorIdOUsuario: jest.fn(),
      findById: jest.fn(),
      contarDisponibles: jest.fn(),
    };
    dispatchSettings = {
      obtener: jest.fn().mockResolvedValue({ arrivalRadiusMeters: 150 }),
    };
    marcas = new Map();
    redis = {
      get: jest.fn((k: string) => Promise.resolve(marcas.get(k) ?? null)),
      setIfAbsent: jest.fn((k: string) => {
        if (marcas.has(k)) return Promise.resolve(false);
        marcas.set(k, '1');
        return Promise.resolve(true);
      }),
      setex: jest.fn((k: string, _ttl: number, v: string) => {
        marcas.set(k, v);
        return Promise.resolve();
      }),
      del: jest.fn((k: string) => {
        marcas.delete(k);
        return Promise.resolve();
      }),
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
      dispatchSettings as unknown as import('../distributor/dispatch-settings.service').DispatchSettingsService,
      redis as unknown as import('../redis/redis.service').RedisService,
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
      'd1',
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
      'd1',
    );
  });

  it('v2 rechaza lejos con el código, los metros y no notifica al cliente', async () => {
    const s = armar({
      ...pedidoEnCamino(),
      deliveryPoint: { type: 'Point', coordinates: [-55.8961, -27.3671] },
    } as unknown as import('./entities/order.entity').Order);
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: DELIVERY_ASIGNADO,
    });

    const error = await s
      .notifyDriverArrivedWithDistance(
        PEDIDO,
        'user-asignado',
        RoleType.DELIVERY,
        -27.3771,
        -55.8961,
      )
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'ARRIVAL_TOO_FAR',
      radiusMeters: 150,
      distanceMeters: expect.any(Number) as number,
    });
    expect(dispatch.notifyCustomer).not.toHaveBeenCalled();
    expect(notifications.sendArrivalPushToCustomer).not.toHaveBeenCalled();
  });

  it('v2 deja pasar con el radio apagado, incluso lejos', async () => {
    const s = armar({
      ...pedidoEnCamino(),
      deliveryPoint: { type: 'Point', coordinates: [-55.8961, -27.3671] },
    } as unknown as import('./entities/order.entity').Order);
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: DELIVERY_ASIGNADO,
    });
    dispatchSettings.obtener.mockResolvedValue({ arrivalRadiusMeters: 0 });

    await expect(
      s.notifyDriverArrivedWithDistance(
        PEDIDO,
        'user-asignado',
        RoleType.DELIVERY,
        -27.3771,
        -55.8961,
      ),
    ).resolves.toEqual({ message: 'Cliente notificado' });
    expect(dispatch.notifyCustomer).toHaveBeenCalled();
  });

  it('v2 deja pasar y avisa si el pedido no tiene ubicación para controlar', async () => {
    const s = armar();
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: DELIVERY_ASIGNADO,
    });

    await expect(
      s.notifyDriverArrivedWithDistance(
        PEDIDO,
        'user-asignado',
        RoleType.DELIVERY,
        -27.3771,
        -55.8961,
      ),
    ).resolves.toEqual({ message: 'Cliente notificado' });
    expect(dispatch.notifyCustomer).toHaveBeenCalled();
  });

  it('v2 devuelve 409 si el pedido no está en camino', async () => {
    const s = armar({
      ...pedidoEnCamino(),
      status: OrderStatus.ACCEPTED,
    } as unknown as import('./entities/order.entity').Order);
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: DELIVERY_ASIGNADO,
    });

    await expect(
      s.notifyDriverArrivedWithDistance(
        PEDIDO,
        'user-asignado',
        RoleType.DELIVERY,
        -27.3671,
        -55.8961,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  describe('v2 · borde del radio, origen del destino e idempotencia', () => {
    /** Destino y una posición 0,001° al norte (≈ 111 m). */
    const DESTINO = { type: 'Point', coordinates: [-55.8961, -27.3671] };
    const CERCA = { latitude: -27.3661, longitude: -55.8961 };

    const llegar = (s: OrderService, p = CERCA) =>
      s.notifyDriverArrivedWithDistance(
        PEDIDO,
        'user-asignado',
        RoleType.DELIVERY,
        p.latitude,
        p.longitude,
      );
    const conDestino = (extra: Record<string, unknown>) => {
      const s = armar({
        ...pedidoEnCamino(),
        ...extra,
      } as unknown as import('./entities/order.entity').Order);
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: DELIVERY_ASIGNADO,
      });
      return s;
    };

    it('borde del radio: a 149,6 m pasa y a 150,4 m es 409 (se compara la distancia real, no la redondeada)', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      await expect(
        llegar(s, { latitude: -27.3671 + 0.00134539, longitude: -55.8961 }),
      ).resolves.toEqual({ message: 'Cliente notificado' });

      const s2 = conDestino({ deliveryPoint: DESTINO });
      const error = await llegar(s2, {
        latitude: -27.3671 + 0.00135258,
        longitude: -55.8961,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConflictException);
      // 150,4 m se informa redondeado (150) aunque el radio sea 150.
      expect((error as ConflictException).getResponse()).toEqual({
        statusCode: 409,
        error: 'Conflict',
        code: 'ARRIVAL_TOO_FAR',
        distanceMeters: 150,
        radiusMeters: 150,
        message:
          'Todavía estás a 150 m del domicilio. Marcá «Llegué» cuando estés en la puerta.',
      });
      expect(dispatch.notifyCustomer).not.toHaveBeenCalled();
    });

    it('sin punto de entrega del pedido usa la ubicación del domicilio', async () => {
      const s = conDestino({
        deliveryPoint: null,
        address: { location: DESTINO },
      });
      dispatchSettings.obtener.mockResolvedValue({ arrivalRadiusMeters: 50 });
      await expect(llegar(s)).rejects.toMatchObject({
        response: { code: 'ARRIVAL_TOO_FAR', distanceMeters: 111 },
      });
      expect(dispatch.notifyCustomer).not.toHaveBeenCalled();
    });

    it('el punto de entrega del pedido manda sobre el domicilio', async () => {
      const s = conDestino({
        deliveryPoint: DESTINO,
        address: {
          location: { type: 'Point', coordinates: [-58.38, -34.6] },
        },
      });
      await expect(llegar(s)).resolves.toEqual({
        message: 'Cliente notificado',
      });
    });

    it('el pedido que no está en camino es 409 ORDER_NOT_ON_THE_WAY y no consulta el radio', async () => {
      const s = conDestino({ status: OrderStatus.DELIVERED });
      await expect(llegar(s)).rejects.toMatchObject({
        response: { code: 'ORDER_NOT_ON_THE_WAY' },
      });
      expect(dispatchSettings.obtener).not.toHaveBeenCalled();
    });

    it('el chofer ajeno es 403 antes de mirar estado o distancia', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      deliveries.buscarPorIdOUsuario.mockResolvedValue({ deliveryId: 'otro' });
      await expect(llegar(s)).rejects.toBeInstanceOf(ForbiddenException);
      expect(dispatchSettings.obtener).not.toHaveBeenCalled();
    });

    it('marcar dos veces responde 200 las dos y notifica al cliente una sola', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      await expect(llegar(s)).resolves.toEqual({
        message: 'Cliente notificado',
      });
      await expect(llegar(s)).resolves.toEqual({
        message: 'Cliente notificado',
      });
      expect(dispatch.notifyCustomer).toHaveBeenCalledTimes(1);
      expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledTimes(1);
      const marca = `order:arrived:${PEDIDO}:${DELIVERY_ASIGNADO}`;
      // Turno «enviando» corto y, como el push salió, «sent» por 6 h.
      expect(redis.setIfAbsent).toHaveBeenCalledWith(marca, 15);
      expect(redis.setex).toHaveBeenCalledWith(marca, 6 * 60 * 60, 'sent');
      expect(marcas.get(marca)).toBe('sent');
    });

    it('ya avisado: el segundo toque lejos no es 409 (la llegada ya quedó)', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      await llegar(s);
      await expect(
        llegar(s, { latitude: -27.4, longitude: -55.8961 }),
      ).resolves.toEqual({ message: 'Cliente notificado' });
      expect(dispatch.notifyCustomer).toHaveBeenCalledTimes(1);
    });

    it('dos toques simultáneos: sólo el que gana la marca notifica', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      await Promise.all([llegar(s), llegar(s)]);
      expect(dispatch.notifyCustomer).toHaveBeenCalledTimes(1);
    });

    it('si el aviso falla se borra la marca y el reintento vuelve a notificar', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      notifications.sendArrivalPushToCustomer.mockRejectedValueOnce(
        new Error('push caído'),
      );
      await expect(llegar(s)).rejects.toThrow('push caído');
      await expect(llegar(s)).resolves.toEqual({
        message: 'Cliente notificado',
      });
      expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledTimes(2);
    });

    it('con Redis caído avisa igual', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      redis.get.mockRejectedValue(new Error('redis caído'));
      redis.setIfAbsent.mockRejectedValue(new Error('redis caído'));
      await expect(llegar(s)).resolves.toEqual({
        message: 'Cliente notificado',
      });
      expect(dispatch.notifyCustomer).toHaveBeenCalledTimes(1);
    });

    it('v1 sigue igual: cada toque notifica y no usa la marca', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      await s.notifyDriverArrived(PEDIDO, 'user-asignado', RoleType.DELIVERY);
      await s.notifyDriverArrived(PEDIDO, 'user-asignado', RoleType.DELIVERY);
      expect(dispatch.notifyCustomer).toHaveBeenCalledTimes(2);
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.setIfAbsent).not.toHaveBeenCalled();
      expect(dispatchSettings.obtener).not.toHaveBeenCalled();
    });
    it.each(['failed', 'no_token'] as const)(
      'push que no salió (%s): responde 200, borra la marca y el reintento vuelve a avisar',
      async (resultado) => {
        const s = conDestino({ deliveryPoint: DESTINO });
        notifications.sendArrivalPushToCustomer.mockResolvedValueOnce(
          resultado,
        );
        await expect(llegar(s)).resolves.toEqual({
          message: 'Cliente notificado',
        });
        expect(marcas.size).toBe(0);
        await llegar(s);
        expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledTimes(
          2,
        );
        // El segundo salió: ahora sí queda la marca y el tercero no avisa.
        await llegar(s);
        expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledTimes(
          2,
        );
        expect(marcas.size).toBe(1);
      },
    );

    it('con Redis colgado (promesas que nunca resuelven) responde a tiempo y avisa', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      const nunca = () => new Promise<never>(() => undefined);
      redis.get.mockImplementation(nunca);
      redis.setIfAbsent.mockImplementation(nunca);
      redis.del.mockImplementation(nunca);
      redis.setex.mockImplementation(nunca);
      notifications.sendArrivalPushToCustomer.mockResolvedValueOnce('failed');
      const t0 = Date.now();
      await expect(llegar(s)).resolves.toEqual({
        message: 'Cliente notificado',
      });
      // get + set + del, cada uno con tope de 500 ms.
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(dispatch.notifyCustomer).toHaveBeenCalledTimes(1);
      expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledTimes(1);
    });
    it('dos toques y el primer push lento falla: el segundo espera, toma el turno y avisa (al final un push salió)', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      let terminarPrimero!: (r: 'failed') => void;
      notifications.sendArrivalPushToCustomer
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              terminarPrimero = resolve;
            }),
        )
        .mockResolvedValueOnce('sent');

      const primero = llegar(s);
      // El primero ya tomó el turno y está enviando.
      await new Promise((r) => setTimeout(r, 20));
      expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledTimes(1);
      const segundo = llegar(s);
      // El segundo encuentra «enviando» y espera: todavía no avisa.
      await new Promise((r) => setTimeout(r, 300));
      expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledTimes(1);

      terminarPrimero('failed');
      await expect(primero).resolves.toEqual({ message: 'Cliente notificado' });
      await expect(segundo).resolves.toEqual({ message: 'Cliente notificado' });

      expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledTimes(2);
      await expect(
        notifications.sendArrivalPushToCustomer.mock.results[1].value,
      ).resolves.toBe('sent');
      expect(marcas.get(`order:arrived:${PEDIDO}:${DELIVERY_ASIGNADO}`)).toBe(
        'sent',
      );
    });

    it('dos toques y el primer push lento sale: el segundo espera y no re-notifica', async () => {
      const s = conDestino({ deliveryPoint: DESTINO });
      let terminarPrimero!: (r: 'sent') => void;
      notifications.sendArrivalPushToCustomer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            terminarPrimero = resolve;
          }),
      );
      const primero = llegar(s);
      await new Promise((r) => setTimeout(r, 20));
      const segundo = llegar(s);
      await new Promise((r) => setTimeout(r, 300));
      terminarPrimero('sent');
      await Promise.all([primero, segundo]);
      expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledTimes(1);
    });

    describe('con relojes falsos', () => {
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => jest.useRealTimers());

      it('«enviando» que no se resuelve: pasada la espera avisa igual y no borra la marca ajena', async () => {
        const s = conDestino({ deliveryPoint: DESTINO });
        const marca = `order:arrived:${PEDIDO}:${DELIVERY_ASIGNADO}`;
        marcas.set(marca, '1');
        notifications.sendArrivalPushToCustomer.mockResolvedValueOnce('failed');
        const r = llegar(s);
        await jest.advanceTimersByTimeAsync(7_000);
        expect(notifications.sendArrivalPushToCustomer).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(2_000);
        await expect(r).resolves.toEqual({ message: 'Cliente notificado' });
        expect(notifications.sendArrivalPushToCustomer).toHaveBeenCalledTimes(
          1,
        );
        expect(redis.del).not.toHaveBeenCalled();
        expect(marcas.get(marca)).toBe('1');
      });
    });
  });
});
