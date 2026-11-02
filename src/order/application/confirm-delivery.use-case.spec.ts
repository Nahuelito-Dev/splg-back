import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfirmDeliveryUseCase } from './confirm-delivery.use-case';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';

/**
 * Prueba de entrega con QR (anti-fraude). Mockeamos el repo de pedidos y
 * UpdateOrderStatusUseCase: acá solo nos importa la VALIDACIÓN (ownership,
 * estado, código) y que los efectos de DELIVERED se deleguen sin duplicar
 * lógica. Los efectos en sí ya están cubiertos en update-order-status.use-case.spec.
 */
describe('ConfirmDeliveryUseCase', () => {
  let useCase: ConfirmDeliveryUseCase;
  let orders: {
    findByIdFull: jest.Mock;
    findOnTheWayByCustomer: jest.Mock;
    registerWrongDeliveryCode: jest.Mock;
  };
  let updateOrderStatusUseCase: { execute: jest.Mock };
  let realtime: { notifyDriverDeliveryCode: jest.Mock };

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'ord-1',
      customerId: 'cust-1',
      distributorId: 'dist-1',
      deliveryId: 'drv-1',
      status: OrderStatus.ON_THE_WAY,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      deliveryCode: 'A1B2C3D4E5',
      deliveryCodeAttempts: 0,
      delivery: { userId: 'chofer-user-1' },
      items: [],
      ...over,
    }) as Order;

  beforeEach(() => {
    orders = {
      findByIdFull: jest.fn(),
      findOnTheWayByCustomer: jest.fn().mockResolvedValue([]),
      registerWrongDeliveryCode: jest.fn().mockResolvedValue(1),
    };
    updateOrderStatusUseCase = { execute: jest.fn() };
    realtime = { notifyDriverDeliveryCode: jest.fn() };

    useCase = new ConfirmDeliveryUseCase(
      orders as unknown as import('../domain/ports/order.repository.port').OrderRepositoryPort,
      updateOrderStatusUseCase as unknown as import('./update-order-status.use-case').UpdateOrderStatusUseCase,
      realtime as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
    );
  });

  it('lanza NotFound si el pedido no existe', async () => {
    orders.findByIdFull.mockResolvedValue(null);
    await expect(
      useCase.execute('nope', 'A1B2C3D4E5', 'cust-1', RoleType.CUSTOMER),
    ).rejects.toThrow(NotFoundException);
  });

  it('rechaza confirmar el pedido de OTRO cliente (403)', async () => {
    orders.findByIdFull.mockResolvedValue(makeOrder());
    await expect(
      useCase.execute('ord-1', 'A1B2C3D4E5', 'otro-cliente', RoleType.CUSTOMER),
    ).rejects.toThrow(ForbiddenException);
    expect(updateOrderStatusUseCase.execute).not.toHaveBeenCalled();
  });

  it('rechaza si el pedido no está ON_THE_WAY', async () => {
    orders.findByIdFull.mockResolvedValue(
      makeOrder({ status: OrderStatus.ACCEPTED }),
    );
    await expect(
      useCase.execute('ord-1', 'A1B2C3D4E5', 'cust-1', RoleType.CUSTOMER),
    ).rejects.toThrow(BadRequestException);
    expect(updateOrderStatusUseCase.execute).not.toHaveBeenCalled();
  });

  it('rechaza un código incorrecto y NO transiciona el pedido', async () => {
    orders.findByIdFull.mockResolvedValue(makeOrder());
    await expect(
      useCase.execute('ord-1', 'CODIGO-MAL', 'cust-1', RoleType.CUSTOMER),
    ).rejects.toThrow(BadRequestException);
    expect(updateOrderStatusUseCase.execute).not.toHaveBeenCalled();
  });

  const rechazoBloqueo = async (code: string): Promise<unknown> => {
    try {
      await useCase.execute('ord-1', code, 'cust-1', RoleType.CUSTOMER);
    } catch (e) {
      return (e as ConflictException).getResponse();
    }
    throw new Error('tenía que bloquear');
  };

  const rechazo = async (
    code: string,
    role: RoleType = RoleType.CUSTOMER,
  ): Promise<unknown> => {
    try {
      await useCase.execute('ord-1', code, 'cust-1', role);
    } catch (e) {
      return (e as BadRequestException).getResponse();
    }
    throw new Error('tenía que rechazar el código');
  };

  it('un código con forma de basura se rechaza como FORMATO', async () => {
    orders.findByIdFull.mockResolvedValue(makeOrder());
    expect(await rechazo('https://x.com/a')).toMatchObject({
      statusCode: 400,
      code: 'DELIVERY_CODE_FORMATO',
    });
    expect(orders.findOnTheWayByCustomer).not.toHaveBeenCalled();
  });

  it('un código de otro pedido en camino del cliente se rechaza como OTRO_PEDIDO', async () => {
    orders.findByIdFull.mockResolvedValue(makeOrder());
    orders.findOnTheWayByCustomer.mockResolvedValue([
      { orderId: 'ord-1', deliveryCode: 'A1B2C3D4E5' },
      { orderId: 'ord-2', deliveryCode: '0123456789' },
    ]);
    expect(await rechazo('0123456789')).toMatchObject({
      code: 'DELIVERY_CODE_OTRO_PEDIDO',
    });
    expect(orders.findOnTheWayByCustomer).toHaveBeenCalledWith(
      'cust-1',
      'dist-1',
    );
    expect(updateOrderStatusUseCase.execute).not.toHaveBeenCalled();
  });

  it('un código bien formado que no es de ningún pedido suyo se rechaza como INCORRECTO', async () => {
    orders.findByIdFull.mockResolvedValue(makeOrder());
    orders.findOnTheWayByCustomer.mockResolvedValue([
      { orderId: 'ord-1', deliveryCode: 'A1B2C3D4E5' },
    ]);
    expect(await rechazo('FFFFFFFFFF')).toMatchObject({
      message: 'Código de entrega inválido',
      code: 'DELIVERY_CODE_INCORRECTO',
    });
  });

  it('el admin no consulta los pedidos de nadie: su rechazo es INCORRECTO', async () => {
    orders.findByIdFull.mockResolvedValue(makeOrder());
    expect(await rechazo('0123456789', RoleType.ADMIN)).toMatchObject({
      code: 'DELIVERY_CODE_INCORRECTO',
    });
    expect(orders.findOnTheWayByCustomer).not.toHaveBeenCalled();
  });

  it('el código en minúsculas del pedido también confirma', async () => {
    orders.findByIdFull.mockResolvedValue(makeOrder());
    updateOrderStatusUseCase.execute.mockResolvedValue({});
    await useCase.execute('ord-1', 'a1b2c3d4e5', 'cust-1', RoleType.CUSTOMER);
    expect(updateOrderStatusUseCase.execute).toHaveBeenCalled();
  });

  describe('límite de intentos', () => {
    it('cada código incorrecto del cliente se cuenta en la base', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      orders.registerWrongDeliveryCode.mockResolvedValue(2);
      expect(await rechazo('FFFFFFFFFF')).toMatchObject({ statusCode: 400 });
      expect(orders.registerWrongDeliveryCode).toHaveBeenCalledWith('ord-1');
    });

    it('el quinto incorrecto bloquea el código: 409 con DELIVERY_CODE_BLOQUEADO', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ deliveryCodeAttempts: 4 }),
      );
      orders.registerWrongDeliveryCode.mockResolvedValue(5);
      await expect(
        useCase.execute('ord-1', 'FFFFFFFFFF', 'cust-1', RoleType.CUSTOMER),
      ).rejects.toThrow(ConflictException);
      expect(await rechazoBloqueo('FFFFFFFFFF')).toMatchObject({
        statusCode: 409,
        code: 'DELIVERY_CODE_BLOQUEADO',
        message: 'Demasiados intentos: pedile al chofer un código nuevo',
      });
    });

    it('cada código errado avisa al chofer asignado con los intentos', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      orders.registerWrongDeliveryCode.mockResolvedValue(3);
      await rechazo('FFFFFFFFFF');
      expect(realtime.notifyDriverDeliveryCode).toHaveBeenCalledTimes(1);
      expect(realtime.notifyDriverDeliveryCode).toHaveBeenCalledWith(
        'chofer-user-1',
        'order:delivery-code-failed',
        { orderId: 'ord-1', attempts: 3, maxAttempts: 5, blocked: false },
      );
    });

    it('el quinto errado avisa además el bloqueo al chofer', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      orders.registerWrongDeliveryCode.mockResolvedValue(5);
      await rechazoBloqueo('FFFFFFFFFF');
      const llamadas = realtime.notifyDriverDeliveryCode.mock.calls.map(
        (c: unknown[]) => c[1],
      );
      expect(llamadas).toEqual([
        'order:delivery-code-failed',
        'order:delivery-code-blocked',
      ]);
      expect(realtime.notifyDriverDeliveryCode).toHaveBeenLastCalledWith(
        'chofer-user-1',
        'order:delivery-code-blocked',
        { orderId: 'ord-1', attempts: 5, maxAttempts: 5, blocked: true },
      );
    });

    it('errados simultáneos que pasan del tope (6.º) no repiten el aviso', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      orders.registerWrongDeliveryCode.mockResolvedValue(6);
      expect(await rechazoBloqueo('FFFFFFFFFF')).toMatchObject({
        statusCode: 409,
      });
      expect(realtime.notifyDriverDeliveryCode).not.toHaveBeenCalled();
    });

    it('un fallo del socket no cambia la respuesta al cliente', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      orders.registerWrongDeliveryCode.mockResolvedValue(5);
      realtime.notifyDriverDeliveryCode.mockImplementation(() => {
        throw new Error('socket caído');
      });
      expect(await rechazoBloqueo('FFFFFFFFFF')).toMatchObject({
        statusCode: 409,
      });
    });

    it('sin chofer asignado no avisa a nadie', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder({ delivery: null }));
      orders.registerWrongDeliveryCode.mockResolvedValue(5);
      await rechazoBloqueo('FFFFFFFFFF');
      expect(realtime.notifyDriverDeliveryCode).not.toHaveBeenCalled();
    });

    it('el admin no dispara avisos al chofer', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      await rechazo('FFFFFFFFFF', RoleType.ADMIN);
      expect(realtime.notifyDriverDeliveryCode).not.toHaveBeenCalled();
    });

    it('bloqueado, ni el código correcto confirma y no se transiciona', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ deliveryCodeAttempts: 5 }),
      );
      await expect(
        useCase.execute('ord-1', 'A1B2C3D4E5', 'cust-1', RoleType.CUSTOMER),
      ).rejects.toThrow(ConflictException);
      expect(updateOrderStatusUseCase.execute).not.toHaveBeenCalled();
      expect(orders.registerWrongDeliveryCode).not.toHaveBeenCalled();
    });

    it('con 4 intentos y el código correcto, confirma', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ deliveryCodeAttempts: 4 }),
      );
      updateOrderStatusUseCase.execute.mockResolvedValue({});
      await useCase.execute('ord-1', 'A1B2C3D4E5', 'cust-1', RoleType.CUSTOMER);
      expect(updateOrderStatusUseCase.execute).toHaveBeenCalled();
    });

    it('el admin no suma intentos ni queda bloqueado', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ deliveryCodeAttempts: 5 }),
      );
      expect(await rechazo('FFFFFFFFFF', RoleType.ADMIN)).toMatchObject({
        code: 'DELIVERY_CODE_INCORRECTO',
      });
      expect(orders.registerWrongDeliveryCode).not.toHaveBeenCalled();
      updateOrderStatusUseCase.execute.mockResolvedValue({});
      await useCase.execute(
        'ord-1',
        'A1B2C3D4E5',
        'admin-1',
        RoleType.ADMIN,
        'Cliente sin celular, confirmó por teléfono',
      );
      expect(updateOrderStatusUseCase.execute).toHaveBeenCalled();
    });
  });

  it('con código correcto y ON_THE_WAY, delega en UpdateOrderStatusUseCase → DELIVERED', async () => {
    const order = makeOrder();
    orders.findByIdFull.mockResolvedValue(order);
    const delivered = { ...order, status: OrderStatus.DELIVERED };
    updateOrderStatusUseCase.execute.mockResolvedValue(delivered);

    const result = await useCase.execute(
      'ord-1',
      'A1B2C3D4E5',
      'cust-1',
      RoleType.CUSTOMER,
    );

    expect(updateOrderStatusUseCase.execute).toHaveBeenCalledWith(
      'ord-1',
      OrderStatus.DELIVERED,
    );
    expect(result).toBe(delivered);
  });

  it('el cliente que manda un reason no lo hace pesar: se ignora', async () => {
    orders.findByIdFull.mockResolvedValue(makeOrder());
    updateOrderStatusUseCase.execute.mockResolvedValue({});

    await useCase.execute(
      'ord-1',
      'A1B2C3D4E5',
      'cust-1',
      RoleType.CUSTOMER,
      'lo que sea',
    );

    expect(updateOrderStatusUseCase.execute).toHaveBeenCalledWith(
      'ord-1',
      OrderStatus.DELIVERED,
    );
  });

  it.each([RoleType.ADMIN, RoleType.SUPER_ADMIN])(
    '%s por el QR: pasa el rol, el actor y el motivo a la entrega',
    async (rol) => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      updateOrderStatusUseCase.execute.mockResolvedValue({});

      await useCase.execute(
        'ord-1',
        'A1B2C3D4E5',
        'admin-1',
        rol,
        'Cliente sin celular, confirmó por teléfono',
      );

      expect(updateOrderStatusUseCase.execute).toHaveBeenCalledWith(
        'ord-1',
        OrderStatus.DELIVERED,
        undefined,
        rol,
        'admin-1',
        'Cliente sin celular, confirmó por teléfono',
      );
    },
  );

  it('es idempotente: si ya está DELIVERED, devuelve el pedido sin re-procesar ni exigir código', async () => {
    const order = makeOrder({ status: OrderStatus.DELIVERED });
    orders.findByIdFull.mockResolvedValue(order);

    const result = await useCase.execute(
      'ord-1',
      'codigo-que-sea',
      'cust-1',
      RoleType.CUSTOMER,
    );

    expect(result).toBe(order);
    expect(updateOrderStatusUseCase.execute).not.toHaveBeenCalled();
  });

  it('admin puede confirmar la entrega de un pedido que no es suyo (ownership solo aplica a CUSTOMER)', async () => {
    const order = makeOrder();
    orders.findByIdFull.mockResolvedValue(order);
    updateOrderStatusUseCase.execute.mockResolvedValue({
      ...order,
      status: OrderStatus.DELIVERED,
    });

    await expect(
      useCase.execute('ord-1', 'A1B2C3D4E5', 'admin-1', RoleType.ADMIN),
    ).resolves.toBeDefined();
  });
});
