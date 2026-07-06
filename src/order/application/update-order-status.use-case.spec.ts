import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UpdateOrderStatusUseCase } from './update-order-status.use-case';
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
  let userRepo: { findOne: jest.Mock };
  let deliveryRepo: { findOne: jest.Mock };
  let dispatch: { notifyCustomer: jest.Mock };
  let notifications: { sendOrderConfirmation: jest.Mock };
  let orders: { findByIdFull: jest.Mock; save: jest.Mock };
  let orchestrator: { onDriverAccepted: jest.Mock };

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      order_id: 'ord-1',
      customer_id: 'cust-1',
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      items: [],
      ...over,
    }) as Order;

  beforeEach(() => {
    userRepo = { findOne: jest.fn().mockResolvedValue(null) };
    deliveryRepo = { findOne: jest.fn() };
    dispatch = {
      notifyCustomer: jest.fn(),
      notifyAdmins: jest.fn(),
      startTracking: jest.fn(),
      stopTracking: jest.fn(),
    };
    notifications = { sendOrderConfirmation: jest.fn().mockResolvedValue(null) };
    orders = {
      findByIdFull: jest.fn(),
      save: jest.fn().mockImplementation(async (o) => o),
    };
    orchestrator = { onDriverAccepted: jest.fn().mockResolvedValue(undefined) };

    useCase = new UpdateOrderStatusUseCase(
      userRepo as any,
      deliveryRepo as any,
      dispatch as any,
      notifications as any,
      orders as any,
      orchestrator as any,
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
    await expect(
      useCase.execute('ord-1', OrderStatus.DELIVERED),
    ).rejects.toThrow(BadRequestException);
    expect(orders.save).not.toHaveBeenCalled();
  });

  describe('ACCEPTED', () => {
    it('asigna el chofer, setea acceptedAt, guarda y emite order:accepted', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveryRepo.findOne.mockResolvedValue({
        delivery_id: 'drv-1',
        user_id: 'user-drv-1',
        isActive: true,
        user: { full_name: 'Chofer Uno', phone_number: '+549110000' },
      });

      const result = await useCase.execute(
        'ord-1',
        OrderStatus.ACCEPTED,
        'drv-1',
      );

      expect(result.status).toBe(OrderStatus.ACCEPTED);
      expect(result.delivery_id).toBe('drv-1');
      expect(result.acceptedAt).toBeInstanceOf(Date);
      // Prueba de entrega con QR: al aceptar se genera el código secreto que
      // el chofer mostrará como QR (ver ConfirmDeliveryUseCase).
      expect(result.deliveryCode).toEqual(expect.stringMatching(/^[0-9A-F]{10}$/));
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

    it('rechaza un chofer inactivo', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveryRepo.findOne.mockResolvedValue({
        delivery_id: 'drv-1',
        isActive: false,
        user: {},
      });
      await expect(
        useCase.execute('ord-1', OrderStatus.ACCEPTED, 'drv-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('lanza NotFound si el chofer no existe', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      deliveryRepo.findOne.mockResolvedValue(null);
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
      userRepo.findOne.mockResolvedValue({
        user_id: 'cust-1',
        customer: { notification_token: 'tok' },
      });
      notifications.sendOrderConfirmation.mockRejectedValue(
        new Error('FCM caído'),
      );

      const result = await useCase.execute('ord-1', OrderStatus.DELIVERED);

      expect(result.status).toBe(OrderStatus.DELIVERED);
    });
  });
});
