import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfirmDeliveryUseCase } from './confirm-delivery.use-case';
import { UpdateOrderStatusUseCase } from './update-order-status.use-case';
import { Order, OrderStatus, PaymentMethod, PaymentStatus } from '../entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';

/**
 * Prueba de entrega con QR (anti-fraude). Mockeamos el repo de pedidos y
 * UpdateOrderStatusUseCase: acá solo nos importa la VALIDACIÓN (ownership,
 * estado, código) y que los efectos de DELIVERED se deleguen sin duplicar
 * lógica. Los efectos en sí ya están cubiertos en update-order-status.use-case.spec.
 */
describe('ConfirmDeliveryUseCase', () => {
  let useCase: ConfirmDeliveryUseCase;
  let orders: { findByIdFull: jest.Mock };
  let updateOrderStatusUseCase: { execute: jest.Mock };

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      order_id: 'ord-1',
      customer_id: 'cust-1',
      delivery_id: 'drv-1',
      status: OrderStatus.ON_THE_WAY,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      deliveryCode: 'A1B2C3D4E5',
      items: [],
      ...over,
    }) as Order;

  beforeEach(() => {
    orders = { findByIdFull: jest.fn() };
    updateOrderStatusUseCase = { execute: jest.fn() };

    useCase = new ConfirmDeliveryUseCase(
      orders as any,
      updateOrderStatusUseCase as any,
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
