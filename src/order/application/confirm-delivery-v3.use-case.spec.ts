import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfirmDeliveryV3UseCase } from './confirm-delivery-v3.use-case';
import {
  RechazoAsentado,
  VerificarEntrega,
} from './update-order-status.use-case';
import { Order, OrderStatus } from '../entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import { ConfirmacionDeEntrega } from '../domain/delivery-confirmation';

/**
 * Código al revés (v3): lo escribe el chofer asignado con su ubicación. El
 * caso de uso de transición es un doble que reproduce lo que importa del real:
 * bloquea el pedido (un mutex por pedido), corre la verificación con el dato
 * FRESCO de la «base» (`base.pedido`), commitea el intento de un
 * `RechazoAsentado` y corre su `despues` con el lock liberado. Así se prueba la
 * regla (rol, asignación, estado, intentos, distancia, avisos) y las carreras.
 */
describe('ConfirmDeliveryV3UseCase', () => {
  const DOMICILIO = { lat: -27.3671, lng: -55.8961 };
  /** ≈ 56 m al sur del domicilio. */
  const CERCA = { latitude: DOMICILIO.lat - 0.0005, longitude: DOMICILIO.lng };
  /** ≈ 2,2 km al sur del domicilio. */
  const LEJOS = { latitude: DOMICILIO.lat - 0.02, longitude: DOMICILIO.lng };

  /** La fila del pedido en la «base»: lo que lee el lock y lo que escribe el intento. */
  let base: { pedido: Order };
  let orders: {
    findByIdFull: jest.Mock;
    registerWrongDeliveryCode: jest.Mock;
  };
  let update: { execute: jest.Mock };
  let realtime: {
    notifyCustomer: jest.Mock;
    notifyDriverDeliveryCode: jest.Mock;
  };
  let deliveries: { buscarPorIdOUsuario: jest.Mock };
  let settings: { obtener: jest.Mock };
  let redis: { get: jest.Mock; setex: jest.Mock; datos: Map<string, string> };
  let useCase: ConfirmDeliveryV3UseCase;
  /** Lo que quedó asentado de la confirmación en la entrega (o undefined). */
  let confirmada: ConfirmacionDeEntrega | undefined;

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'ord-1',
      customerId: 'cust-1',
      distributorId: 'dist-1',
      deliveryId: 'drv-1',
      status: OrderStatus.ON_THE_WAY,
      deliveryCode: '482913',
      deliveryCodeAttempts: 0,
      deliveryPoint: {
        type: 'Point',
        coordinates: [DOMICILIO.lng, DOMICILIO.lat],
      },
      ...over,
    }) as Order;

  /** Doble de `UpdateOrderStatusUseCase.execute` con un lock por pedido. */
  const transicionConLock = () => {
    let cola: Promise<unknown> = Promise.resolve();
    return async (
      _id: string,
      _status: OrderStatus,
      _deliveryId: unknown,
      _role: unknown,
      _actor: unknown,
      _reason: unknown,
      entrega?: ConfirmacionDeEntrega | VerificarEntrega,
    ): Promise<Order> => {
      let liberar = () => {};
      const anterior = cola;
      cola = new Promise<void>((r) => (liberar = r));
      await anterior;
      let rechazo: RechazoAsentado | null = null;
      try {
        const locked = { ...base.pedido } as Order;
        if (locked.status === OrderStatus.DELIVERED) return locked;
        const manager = {
          createQueryBuilder: () => {
            const qb = {
              valores: {} as Partial<Order>,
              update: () => qb,
              set: (v: Partial<Order>) => ((qb.valores = v), qb),
              where: () => qb,
              execute: () => {
                // Escribe en la «base» (lo commitea el rechazo).
                base.pedido = { ...base.pedido, ...qb.valores } as Order;
                return Promise.resolve({ affected: 1 });
              },
            };
            return qb;
          },
        };
        try {
          confirmada =
            typeof entrega === 'function'
              ? await entrega(locked, manager as never)
              : entrega;
        } catch (e) {
          if (!(e instanceof RechazoAsentado)) throw e;
          rechazo = e;
        }
        if (!rechazo) {
          base.pedido = {
            ...base.pedido,
            status: OrderStatus.DELIVERED,
          } as Order;
          return base.pedido;
        }
      } finally {
        liberar();
      }
      await rechazo.despues?.();
      throw rechazo.causa;
    };
  };

  const chofer = (over = {}) => ({
    orderId: 'ord-1',
    userId: 'u-chofer',
    role: RoleType.DELIVERY,
    code: '482913',
    ...CERCA,
    ...over,
  });

  beforeEach(() => {
    confirmada = undefined;
    base = { pedido: makeOrder() };
    orders = {
      // La lectura previa (sin lock) devuelve una copia: puede quedar vieja.
      findByIdFull: jest.fn(() => Promise.resolve({ ...base.pedido })),
      registerWrongDeliveryCode: jest.fn(),
    };
    update = { execute: jest.fn(transicionConLock()) };
    realtime = {
      notifyCustomer: jest.fn(),
      notifyDriverDeliveryCode: jest.fn(),
    };
    deliveries = {
      buscarPorIdOUsuario: jest.fn().mockResolvedValue({ deliveryId: 'drv-1' }),
    };
    settings = {
      obtener: jest.fn().mockResolvedValue({ arrivalRadiusMeters: 100 }),
    };
    const datos = new Map<string, string>();
    redis = {
      datos,
      get: jest.fn((k: string) => Promise.resolve(datos.get(k) ?? null)),
      setex: jest.fn((k: string, _ttl: number, v: string) => {
        datos.set(k, v);
        return Promise.resolve();
      }),
    };
    useCase = new ConfirmDeliveryV3UseCase(
      orders as never,
      update as never,
      realtime as never,
      deliveries as never,
      settings as never,
      redis as never,
    );
  });

  describe('chofer', () => {
    it('con el código correcto entrega y asienta punto, precisión, distancia y quién confirmó', async () => {
      const r = await useCase.execute(chofer({ accuracyMeters: 9 }));

      expect(r.status).toBe(OrderStatus.DELIVERED);
      expect(update.execute).toHaveBeenCalledTimes(1);
      const args = update.execute.mock.calls[0] as unknown[];
      // Sin rol: la prueba es el código, no un admin.
      expect(args.slice(0, 6)).toEqual([
        'ord-1',
        OrderStatus.DELIVERED,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(typeof args[6]).toBe('function');
      expect(confirmada).toMatchObject({
        point: {
          type: 'Point',
          coordinates: [CERCA.longitude, CERCA.latitude],
        },
        accuracyM: 9,
        outOfRange: false,
        byUserId: 'u-chofer',
        byRole: RoleType.DELIVERY,
      });
      expect(confirmada?.distanceM).toBeLessThan(60);
    });

    it('fuera del radio NO rechaza: entrega y marca outOfRange', async () => {
      await useCase.execute(chofer(LEJOS));
      expect(confirmada?.outOfRange).toBe(true);
      expect(confirmada?.distanceM).toBeGreaterThan(2000);
    });

    it('con el radio en 0 no marca aunque esté lejos', async () => {
      settings.obtener.mockResolvedValue({ arrivalRadiusMeters: 0 });
      await useCase.execute(chofer(LEJOS));
      expect(confirmada).toMatchObject({ outOfRange: false });
    });

    it('sin punto de entrega mide contra el domicilio; sin ninguno, no mide ni marca', async () => {
      base.pedido = makeOrder({
        deliveryPoint: null,
        address: {
          location: {
            type: 'Point',
            coordinates: [DOMICILIO.lng, DOMICILIO.lat],
          },
        },
      } as Partial<Order>);
      await useCase.execute(chofer(LEJOS));
      expect(confirmada?.outOfRange).toBe(true);

      base.pedido = makeOrder({ deliveryPoint: null, address: undefined });
      await useCase.execute(chofer());
      expect(confirmada).toMatchObject({ distanceM: null, outOfRange: false });
    });

    it('un chofer que no es el asignado recibe 403 y no se toca nada', async () => {
      deliveries.buscarPorIdOUsuario.mockResolvedValue({ deliveryId: 'otro' });
      await expect(useCase.execute(chofer())).rejects.toThrow(
        ForbiddenException,
      );
      expect(update.execute).not.toHaveBeenCalled();
      expect(base.pedido.deliveryCodeAttempts).toBe(0);
    });

    it('sin perfil de chofer, 403', async () => {
      deliveries.buscarPorIdOUsuario.mockResolvedValue(null);
      await expect(useCase.execute(chofer())).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('un cliente no confirma (403), sin leer el pedido', async () => {
      await expect(
        useCase.execute(chofer({ role: RoleType.CUSTOMER })),
      ).rejects.toThrow(ForbiddenException);
      expect(update.execute).not.toHaveBeenCalled();
      expect(orders.findByIdFull).not.toHaveBeenCalled();
    });

    it('pedido inexistente: 404', async () => {
      orders.findByIdFull.mockResolvedValue(null);
      await expect(useCase.execute(chofer())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('el pedido ya entregado responde el pedido sin pedir código (idempotente)', async () => {
      base.pedido = makeOrder({ status: OrderStatus.DELIVERED });
      await expect(
        useCase.execute(chofer({ code: '000000' })),
      ).resolves.toMatchObject({ status: OrderStatus.DELIVERED });
      expect(update.execute).not.toHaveBeenCalled();
    });

    it('el idempotente igual exige que el pedido sea suyo', async () => {
      base.pedido = makeOrder({ status: OrderStatus.DELIVERED });
      deliveries.buscarPorIdOUsuario.mockResolvedValue({ deliveryId: 'otro' });
      await expect(useCase.execute(chofer())).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('con el pedido sin salir: 409 ORDER_NOT_ON_THE_WAY', async () => {
      base.pedido = makeOrder({ status: OrderStatus.ACCEPTED });
      await expect(useCase.execute(chofer())).rejects.toMatchObject({
        response: { code: 'ORDER_NOT_ON_THE_WAY' },
      });
      await expect(useCase.execute(chofer())).rejects.toThrow(
        ConflictException,
      );
    });

    it.each([
      ['sin código', { code: undefined }],
      ['código null', { code: null }],
      ['sin latitud', { latitude: undefined }],
      ['latitud null', { latitude: null }],
      ['longitud null', { longitude: null }],
      ['latitud fuera de rango', { latitude: 91 }],
      ['longitud fuera de rango', { longitude: -180.5 }],
      ['precisión negativa', { accuracyMeters: -1 }],
    ])('%s: 400 VALIDATION, sin contar intento', async (_caso, over) => {
      await expect(useCase.execute(chofer(over))).rejects.toMatchObject({
        response: { statusCode: 400, code: 'VALIDATION' },
      });
      expect(update.execute).not.toHaveBeenCalled();
      expect(base.pedido.deliveryCodeAttempts).toBe(0);
    });

    it.each(['4829', '4829134', 'abcdef', '', ' 48291', 482913])(
      'el código %p no tiene 6 dígitos: 400 DELIVERY_CODE_FORMATO y no cuenta como intento',
      async (code) => {
        await expect(useCase.execute(chofer({ code }))).rejects.toMatchObject({
          response: { statusCode: 400, code: 'DELIVERY_CODE_FORMATO' },
        });
        expect(update.execute).not.toHaveBeenCalled();
        expect(base.pedido.deliveryCodeAttempts).toBe(0);
        expect(realtime.notifyCustomer).not.toHaveBeenCalled();
      },
    );

    it('un código incorrecto suma un intento, avisa al CLIENTE (no al chofer) y dice cuántos quedan', async () => {
      base.pedido = makeOrder({ deliveryCodeAttempts: 1 });
      await expect(
        useCase.execute(chofer({ code: '111111' })),
      ).rejects.toMatchObject({
        response: {
          statusCode: 400,
          code: 'DELIVERY_CODE_INCORRECTO',
          message: 'El código no es correcto. Te quedan 3 intentos',
          attempts: 2,
          remaining: 3,
        },
      });
      expect(base.pedido.deliveryCodeAttempts).toBe(2);
      expect(base.pedido.status).toBe(OrderStatus.ON_THE_WAY);
      expect(realtime.notifyCustomer).toHaveBeenCalledTimes(1);
      expect(realtime.notifyCustomer).toHaveBeenCalledWith(
        'cust-1',
        'order:delivery-code-failed',
        { orderId: 'ord-1', attempts: 2, remaining: 3 },
      );
      expect(realtime.notifyDriverDeliveryCode).not.toHaveBeenCalled();
    });

    it('con un intento restante el mensaje va en singular', async () => {
      base.pedido = makeOrder({ deliveryCodeAttempts: 3 });
      await expect(
        useCase.execute(chofer({ code: '111111' })),
      ).rejects.toMatchObject({
        response: {
          message: 'El código no es correcto. Te queda 1 intento',
          remaining: 1,
        },
      });
    });

    it('el 5.º error bloquea: 409 y el cliente recibe failed + blocked', async () => {
      base.pedido = makeOrder({ deliveryCodeAttempts: 4 });
      await expect(
        useCase.execute(chofer({ code: '111111' })),
      ).rejects.toMatchObject({
        response: { code: 'DELIVERY_CODE_BLOQUEADO' },
      });
      expect(base.pedido.deliveryCodeAttempts).toBe(5);
      expect(realtime.notifyCustomer.mock.calls).toEqual([
        [
          'cust-1',
          'order:delivery-code-failed',
          { orderId: 'ord-1', attempts: 5, remaining: 0 },
        ],
        ['cust-1', 'order:delivery-code-blocked', { orderId: 'ord-1' }],
      ]);
    });

    it('ya bloqueado: 409 aun con el código bueno, sin contar ni avisar', async () => {
      base.pedido = makeOrder({ deliveryCodeAttempts: 5 });
      await expect(useCase.execute(chofer())).rejects.toMatchObject({
        response: { code: 'DELIVERY_CODE_BLOQUEADO' },
      });
      expect(base.pedido.deliveryCodeAttempts).toBe(5);
      expect(base.pedido.status).toBe(OrderStatus.ON_THE_WAY);
      expect(realtime.notifyCustomer).not.toHaveBeenCalled();
    });

    it('si el aviso al cliente falla, el chofer igual recibe su error', async () => {
      realtime.notifyCustomer.mockImplementation(() => {
        throw new Error('socket caído');
      });
      await expect(useCase.execute(chofer({ code: '111111' }))).rejects.toThrow(
        BadRequestException,
      );
    });

    describe('bajo el lock (carreras)', () => {
      it('10 errores en paralelo no pasan el tope: 5 intentos, 4 × 400 + 6 × 409, un solo aviso de bloqueo', async () => {
        const resultados = await Promise.allSettled(
          Array.from({ length: 10 }, () =>
            useCase.execute(chofer({ code: '111111' })),
          ),
        );
        const codes = resultados.map(
          (r) =>
            (
              (r as PromiseRejectedResult).reason as {
                response: { code: string };
              }
            ).response.code,
        );
        expect(
          codes.filter((c) => c === 'DELIVERY_CODE_INCORRECTO'),
        ).toHaveLength(4);
        expect(
          codes.filter((c) => c === 'DELIVERY_CODE_BLOQUEADO'),
        ).toHaveLength(6);
        expect(base.pedido.deliveryCodeAttempts).toBe(5);
        const bloqueos = realtime.notifyCustomer.mock.calls.filter(
          ([, evento]) => evento === 'order:delivery-code-blocked',
        );
        expect(bloqueos).toHaveLength(1);
      });

      it('el código bueno después de un bloqueo concurrente no entrega (los intentos se leen con el lock)', async () => {
        // La lectura previa dice 0 intentos; para cuando toma el lock, otro
        // request ya agotó los 5.
        orders.findByIdFull.mockResolvedValueOnce(makeOrder());
        base.pedido = makeOrder({ deliveryCodeAttempts: 5 });
        await expect(useCase.execute(chofer())).rejects.toMatchObject({
          response: { code: 'DELIVERY_CODE_BLOQUEADO' },
        });
        expect(base.pedido.status).toBe(OrderStatus.ON_THE_WAY);
      });

      it('si el cliente regeneró el código en el medio, el viejo es incorrecto (se compara con el vigente)', async () => {
        orders.findByIdFull.mockResolvedValueOnce(makeOrder());
        base.pedido = makeOrder({ deliveryCode: '700700' });
        await expect(useCase.execute(chofer())).rejects.toMatchObject({
          response: { code: 'DELIVERY_CODE_INCORRECTO', attempts: 1 },
        });
        expect(base.pedido.status).toBe(OrderStatus.ON_THE_WAY);
      });

      it('si el pedido se reasignó en el medio, el chofer anterior recibe 403 sin contar intento', async () => {
        orders.findByIdFull.mockResolvedValueOnce(makeOrder());
        base.pedido = makeOrder({ deliveryId: 'drv-2' });
        await expect(useCase.execute(chofer())).rejects.toThrow(
          ForbiddenException,
        );
        expect(base.pedido.deliveryCodeAttempts).toBe(0);
        expect(base.pedido.status).toBe(OrderStatus.ON_THE_WAY);
      });

      it('si se canceló en el medio, 409 ORDER_NOT_ON_THE_WAY sin contar intento', async () => {
        orders.findByIdFull.mockResolvedValueOnce(makeOrder());
        base.pedido = makeOrder({ status: OrderStatus.CANCELLED });
        await expect(
          useCase.execute(chofer({ code: '111111' })),
        ).rejects.toMatchObject({ response: { code: 'ORDER_NOT_ON_THE_WAY' } });
        expect(base.pedido.deliveryCodeAttempts).toBe(0);
      });
    });

    describe('reintento con la misma Idempotency-Key', () => {
      const claveDeIdempotencia = randomUUID();

      it('el reintento de un código incorrecto responde lo mismo sin sumar otro intento ni re-avisar', async () => {
        const primero = useCase.execute(
          chofer({ code: '111111', idempotencyKey: claveDeIdempotencia }),
        );
        await expect(primero).rejects.toMatchObject({
          response: { code: 'DELIVERY_CODE_INCORRECTO', attempts: 1 },
        });
        await expect(
          useCase.execute(
            chofer({ code: '111111', idempotencyKey: claveDeIdempotencia }),
          ),
        ).rejects.toMatchObject({
          status: 400,
          response: {
            code: 'DELIVERY_CODE_INCORRECTO',
            attempts: 1,
            remaining: 4,
          },
        });
        expect(base.pedido.deliveryCodeAttempts).toBe(1);
        expect(realtime.notifyCustomer).toHaveBeenCalledTimes(1);
      });

      it('el reintento del 5.º error repite el 409', async () => {
        base.pedido = makeOrder({ deliveryCodeAttempts: 4 });
        await expect(
          useCase.execute(
            chofer({ code: '111111', idempotencyKey: claveDeIdempotencia }),
          ),
        ).rejects.toMatchObject({
          response: { code: 'DELIVERY_CODE_BLOQUEADO' },
        });
        await expect(
          useCase.execute(
            chofer({ code: '111111', idempotencyKey: claveDeIdempotencia }),
          ),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'DELIVERY_CODE_BLOQUEADO' },
        });
        expect(base.pedido.deliveryCodeAttempts).toBe(5);
      });

      it('sin la clave, cada intento cuenta', async () => {
        await expect(
          useCase.execute(chofer({ code: '111111' })),
        ).rejects.toThrow(BadRequestException);
        await expect(
          useCase.execute(chofer({ code: '111111' })),
        ).rejects.toThrow(BadRequestException);
        expect(base.pedido.deliveryCodeAttempts).toBe(2);
        expect(redis.setex).not.toHaveBeenCalled();
      });

      it('con la misma clave y OTRO código, es otro intento', async () => {
        await expect(
          useCase.execute(
            chofer({ code: '111111', idempotencyKey: claveDeIdempotencia }),
          ),
        ).rejects.toThrow(BadRequestException);
        await expect(
          useCase.execute(
            chofer({ code: '222222', idempotencyKey: claveDeIdempotencia }),
          ),
        ).rejects.toThrow(BadRequestException);
        expect(base.pedido.deliveryCodeAttempts).toBe(2);
      });

      it('si Redis no responde, el intento se cuenta igual', async () => {
        redis.get.mockRejectedValue(new Error('redis caído'));
        await expect(
          useCase.execute(
            chofer({ code: '111111', idempotencyKey: claveDeIdempotencia }),
          ),
        ).rejects.toThrow(BadRequestException);
        expect(base.pedido.deliveryCodeAttempts).toBe(1);
      });
    });
  });

  describe('admin', () => {
    const admin = (over = {}) => ({
      orderId: 'ord-1',
      userId: 'u-admin',
      role: RoleType.ADMIN,
      reason: 'El cliente no tiene celular',
      ...over,
    });

    it('entrega con motivo, sin código ni ubicación, y queda quién fue', async () => {
      await useCase.execute(admin());
      const args = update.execute.mock.calls[0] as unknown[];
      expect(args.slice(0, 6)).toEqual([
        'ord-1',
        OrderStatus.DELIVERED,
        undefined,
        RoleType.ADMIN,
        'u-admin',
        'El cliente no tiene celular',
      ]);
      expect(confirmada).toEqual({
        point: null,
        accuracyM: null,
        distanceM: null,
        outOfRange: false,
        byUserId: 'u-admin',
        byRole: RoleType.ADMIN,
      });
      expect(deliveries.buscarPorIdOUsuario).not.toHaveBeenCalled();
    });

    it.each(['111111', 'cualquier-cosa'])(
      'el código del admin (%p) es informativo: no se compara, entrega igual y no suma intentos',
      async (code) => {
        await expect(useCase.execute(admin({ code }))).resolves.toMatchObject({
          status: OrderStatus.DELIVERED,
        });
        expect(base.pedido.deliveryCodeAttempts).toBe(0);
      },
    );

    it('el admin entrega aunque el código esté bloqueado', async () => {
      base.pedido = makeOrder({ deliveryCodeAttempts: 5 });
      await expect(useCase.execute(admin())).resolves.toMatchObject({
        status: OrderStatus.DELIVERED,
      });
    });

    it('un super admin también', async () => {
      await useCase.execute(admin({ role: RoleType.SUPER_ADMIN }));
      expect(confirmada).toMatchObject({ byRole: RoleType.SUPER_ADMIN });
    });

    it('con el pedido sin salir, 409', async () => {
      base.pedido = makeOrder({ status: OrderStatus.PENDING });
      await expect(useCase.execute(admin())).rejects.toThrow(ConflictException);
    });

    it('si se canceló mientras tanto, 409 bajo el lock', async () => {
      orders.findByIdFull.mockResolvedValueOnce(makeOrder());
      base.pedido = makeOrder({ status: OrderStatus.CANCELLED });
      await expect(useCase.execute(admin())).rejects.toMatchObject({
        response: { code: 'ORDER_NOT_ON_THE_WAY' },
      });
    });
  });
});
