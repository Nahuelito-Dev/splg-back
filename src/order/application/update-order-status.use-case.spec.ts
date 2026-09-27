import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UpdateOrderStatusUseCase } from './update-order-status.use-case';
import { InvalidOrderTransitionError } from '../domain/errors/invalid-order-transition.error';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';

/**
 * Use-case de cambio de estado. Mockeamos repos, puerto de tiempo real y
 * notificaciones: verificamos los EFECTOS de dominio de cada estado (asignar
 * chofer + timestamps, CASH→PAID) y que los side-effects sean best-effort.
 * La validez de la transición en sí la cubre order-status.machine.spec.
 */
describe('UpdateOrderStatusUseCase', () => {
  let useCase: UpdateOrderStatusUseCase;
  let deliveries: {
    buscarPorIdOUsuario: jest.Mock;
    assertElegibleParaAsignacion: jest.Mock;
  };
  let dispatch: {
    notifyCustomer: jest.Mock;
    notifyAdmins: jest.Mock;
    startTracking: jest.Mock;
    stopTracking: jest.Mock;
  };
  let notifications: { sendOrderConfirmation: jest.Mock };
  let orders: { findByIdFull: jest.Mock; save: jest.Mock };
  let orchestrator: { onDriverAccepted: jest.Mock };
  let cylinderLifecycle: { onOrderDelivered: jest.Mock };

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'ord-1',
      customerId: 'cust-1',
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      items: [],
      ...over,
    }) as Order;

  beforeEach(() => {
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
    dispatch = {
      notifyCustomer: jest.fn(),
      notifyAdmins: jest.fn(),
      startTracking: jest.fn(),
      stopTracking: jest.fn(),
    };
    notifications = {
      sendOrderConfirmation: jest.fn().mockResolvedValue(null),
    };
    orders = {
      findByIdFull: jest.fn(),
      save: jest.fn((o: unknown) => Promise.resolve(o)),
    };
    orchestrator = { onDriverAccepted: jest.fn().mockResolvedValue(undefined) };
    cylinderLifecycle = { onOrderDelivered: jest.fn().mockResolvedValue(0) };

    useCase = new UpdateOrderStatusUseCase(
      deliveries as unknown as import('../../delivery/delivery.service').DeliveryService,
      dispatch as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      notifications as unknown as import('../domain/ports/notification.port').NotificationPort,
      orders as unknown as import('../domain/ports/order.repository.port').OrderRepositoryPort,
      orchestrator as unknown as import('./dispatch-orchestrator.service').DispatchOrchestratorService,
      cylinderLifecycle as unknown as import('../domain/ports/cylinder-lifecycle.port').CylinderLifecyclePort,
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

  describe('ACCEPTED', () => {
    it('asigna el chofer, setea acceptedAt, guarda y emite order:accepted', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveries.buscarPorIdOUsuario.mockResolvedValue({
        deliveryId: 'drv-1',
        userId: 'user-drv-1',
        isEnabled: true,
        validated: true,
        user: { fullName: 'Chofer Uno', phoneNumber: '+549110000' },
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
      expect(result.deliveryCode).toEqual(
        expect.stringMatching(/^[0-9A-F]{10}$/),
      );
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
          driver: { name: 'Chofer Uno', phone: '+549110000' },
        }),
      );
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
  });

  describe('DELIVERED', () => {
    it('marca pagado automáticamente si el método es CASH', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({
          status: OrderStatus.ON_THE_WAY,
          paymentMethod: PaymentMethod.CASH,
        }),
      );

      const result = await useCase.execute('ord-1', OrderStatus.DELIVERED);

      expect(result.deliveredAt).toBeInstanceOf(Date);
      expect(result.paymentStatus).toBe(PaymentStatus.PAID);
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
