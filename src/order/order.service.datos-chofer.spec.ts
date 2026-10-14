import { OrderService } from './order.service';
import { Order, OrderStatus } from './entities/order.entity';

/** El bloque `driver` del pedido: sólo con el pedido activo y a quien corresponde. */
describe('OrderService.getOne · datos del chofer', () => {
  const DIST = 'dddddddd-0000-4000-8000-00000000000a';
  let resumen: jest.Mock;
  let lastDriverLocation: jest.Mock;
  let historialQuery: jest.Mock;
  let service: OrderService;

  const pedido = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'o1',
      customerId: 'cli-1',
      distributorId: DIST,
      deliveryId: 'del-1',
      status: OrderStatus.ON_THE_WAY,
      items: [],
      delivery: {
        deliveryId: 'del-1',
        userId: 'chofer-user',
        user: {
          userId: 'chofer-user',
          fullName: 'Ana Gómez',
          phoneNumber: '+5491155550000',
        },
      },
      ...over,
    }) as unknown as Order;

  const armar = (p: Order) => {
    historialQuery = jest.fn().mockResolvedValue([]);
    resumen = jest.fn().mockResolvedValue({ average: 4.75, count: 12 });
    lastDriverLocation = jest.fn().mockResolvedValue({
      lat: -34.6,
      lng: -58.4,
      at: new Date().toISOString(),
    });
    service = Object.assign(Object.create(OrderService.prototype), {
      driverRatings: { resumen },
      dispatch: { lastDriverLocation },
      orderRepository: { manager: { query: historialQuery } },
    }) as OrderService;
    jest.spyOn(service, 'findOne').mockResolvedValue(p);
  };

  const base = {
    userId: 'chofer-user',
    fullName: 'Ana Gómez',
    phoneNumber: '+5491155550000',
    ratingAverage: 4.75,
    ratingCount: 12,
  };

  it('en camino trae nombre, teléfono, calificación y la ubicación de ESE pedido', async () => {
    armar(pedido({ status: OrderStatus.ON_THE_WAY }));
    const dto = await service.getOne('o1', DIST, 'cli-1', undefined, true);
    expect(dto.driver).toEqual({
      ...base,
      location: { lat: -34.6, lng: -58.4, at: expect.any(String) as string },
    });
    expect(resumen).toHaveBeenCalledWith('chofer-user');
    expect(lastDriverLocation).toHaveBeenCalledWith('chofer-user', 'o1');
  });

  it('aceptado trae el teléfono pero NO la ubicación (el chofer puede estar entregando otro pedido)', async () => {
    armar(pedido({ status: OrderStatus.ACCEPTED }));
    const dto = await service.getOne('o1', DIST, 'cli-1', undefined, true);
    expect(dto.driver).toEqual({ ...base, location: null });
    expect(lastDriverLocation).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.DELIVERED, OrderStatus.CANCELLED, OrderStatus.PENDING])(
    'con el pedido %s no expone el chofer ni su teléfono',
    async (status) => {
      armar(pedido({ status }));
      const dto = await service.getOne('o1', DIST, 'cli-1', undefined, true);
      expect(dto.driver).toBeNull();
      expect(resumen).not.toHaveBeenCalled();
    },
  );

  it('sin chofer asignado, driver es null', async () => {
    armar(pedido({ delivery: null as unknown as Order['delivery'] }));
    const dto = await service.getOne('o1', DIST, 'cli-1', undefined, true);
    expect(dto.driver).toBeNull();
  });

  it('si no se pide (el chofer lee su pedido), driver es null', async () => {
    armar(pedido());
    const dto = await service.getOne('o1', DIST);
    expect(dto.driver).toBeNull();
    expect(resumen).not.toHaveBeenCalled();
  });

  it('un chofer sin calificaciones sale con 0 y 0', async () => {
    armar(pedido());
    resumen.mockResolvedValue({ average: 0, count: 0 });
    const dto = await service.getOne('o1', DIST, 'cli-1', undefined, true);
    expect(dto.driver).toMatchObject({ ratingAverage: 0, ratingCount: 0 });
  });

  it('otro cliente sigue sin ver el pedido (404), con o sin chofer', async () => {
    armar(pedido());
    await expect(
      service.getOne('o1', DIST, 'otro-cliente', undefined, true),
    ).rejects.toThrow('not found');
  });

  it('sin posición en el radar, location es null; si el radar falla, el pedido se lee igual', async () => {
    armar(pedido());
    lastDriverLocation.mockResolvedValue(null);
    expect(
      (await service.getOne('o1', DIST, 'cli-1', undefined, true)).driver,
    ).toMatchObject({ fullName: 'Ana Gómez', location: null });
    lastDriverLocation.mockRejectedValue(new Error('redis caído'));
    expect(
      (await service.getOne('o1', DIST, 'cli-1', undefined, true)).driver,
    ).toMatchObject({ location: null });
  });

  it('con el pedido cerrado no consulta la posición', async () => {
    armar(pedido({ status: OrderStatus.DELIVERED }));
    await service.getOne('o1', DIST, 'cli-1', undefined, true);
    expect(lastDriverLocation).not.toHaveBeenCalled();
  });

  describe('cancelledBy', () => {
    const cancelado = () => pedido({ status: OrderStatus.CANCELLED });
    const quien = async (
      filas: Array<{ user_id: string | null; type: string | null }>,
    ) => {
      armar(cancelado());
      historialQuery.mockResolvedValue(filas);
      return (await service.getOne('o1', DIST)).cancelledBy;
    };

    it.each([
      ['customer', 'customer'],
      ['admin', 'admin'],
      ['super_admin', 'admin'],
      ['delivery', 'driver'],
    ])('el rol %s se informa como %s', async (rol, esperado) => {
      expect(await quien([{ user_id: 'u1', type: rol }])).toBe(esperado);
    });

    it('sin usuario en la transición (cron, webhook) lo canceló el sistema', async () => {
      expect(await quien([{ user_id: null, type: null }])).toBe('system');
    });

    it('un pedido anterior al historial no sabe quién canceló', async () => {
      expect(await quien([])).toBeNull();
    });

    it('un pedido no cancelado no consulta el historial y trae null', async () => {
      armar(pedido());
      expect((await service.getOne('o1', DIST)).cancelledBy).toBeNull();
      expect(historialQuery).not.toHaveBeenCalled();
    });

    it('se lee de la última transición a cancelled', async () => {
      await quien([{ user_id: 'u1', type: 'customer' }]);
      const [sql] = historialQuery.mock.calls[0] as [string];
      expect(sql).toContain("to_status = 'cancelled'");
      expect(sql).toContain('changed_at DESC LIMIT 1');
    });
  });

  describe('ubicación vieja', () => {
    const conEdad = (minutos: number | null) =>
      lastDriverLocation.mockResolvedValue({
        lat: -34.6,
        lng: -58.4,
        at:
          minutos === null
            ? null
            : new Date(Date.now() - minutos * 60_000).toISOString(),
      });
    const ubicacion = async () =>
      (await service.getOne('o1', DIST, 'cli-1', undefined, true)).driver
        ?.location;

    it('reciente: se devuelve', async () => {
      armar(pedido({ status: OrderStatus.ON_THE_WAY }));
      conEdad(2);
      expect(await ubicacion()).toMatchObject({ lat: -34.6 });
    });

    it('de hace más de 10 minutos: no se devuelve', async () => {
      armar(pedido({ status: OrderStatus.ON_THE_WAY }));
      conEdad(30);
      expect(await ubicacion()).toBeNull();
    });

    it('sin hora anotada: no se devuelve', async () => {
      armar(pedido({ status: OrderStatus.ON_THE_WAY }));
      conEdad(null);
      expect(await ubicacion()).toBeNull();
    });

    it('el máximo se configura con DRIVER_LOCATION_MAX_AGE_MIN', async () => {
      process.env.DRIVER_LOCATION_MAX_AGE_MIN = '60';
      try {
        armar(pedido({ status: OrderStatus.ON_THE_WAY }));
        conEdad(30);
        expect(await ubicacion()).toMatchObject({ lat: -34.6 });
      } finally {
        delete process.env.DRIVER_LOCATION_MAX_AGE_MIN;
      }
    });
  });
});
