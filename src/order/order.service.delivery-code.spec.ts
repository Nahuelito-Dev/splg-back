import { ConflictException, ForbiddenException } from '@nestjs/common';
import { OrderService } from './order.service';
import { Order, OrderStatus } from './entities/order.entity';
import { RoleType } from '../common/constants/role-type.enum';

/**
 * Código de entrega nuevo (`regenerateDeliveryCode`): sólo el chofer asignado
 * (o un admin), sólo con el pedido en camino, y el nuevo es de 6 dígitos.
 */
describe('OrderService · código de entrega nuevo', () => {
  const PEDIDO = 'f1f1f1f1-0000-4000-8000-000000000001';
  let orders: { replaceDeliveryCode: jest.Mock };
  let deliveries: { buscarPorIdOUsuario: jest.Mock };
  let service: OrderService;

  const armar = (status: OrderStatus = OrderStatus.ON_THE_WAY) => {
    orders = { replaceDeliveryCode: jest.fn().mockResolvedValue(true) };
    deliveries = { buscarPorIdOUsuario: jest.fn() };
    service = new OrderService(
      {} as never,
      deliveries as never,
      {} as never,
      orders as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue({
      orderId: PEDIDO,
      deliveryId: 'd-1',
      status,
    } as unknown as Order);
  };

  it('el chofer asignado recibe un código de 6 dígitos y se guarda', async () => {
    armar();
    deliveries.buscarPorIdOUsuario.mockResolvedValue({ deliveryId: 'd-1' });
    const res = await service.regenerateDeliveryCode(
      PEDIDO,
      'u-1',
      RoleType.DELIVERY,
    );
    expect(res.deliveryCode).toMatch(/^\d{6}$/);
    expect(orders.replaceDeliveryCode).toHaveBeenCalledWith(
      PEDIDO,
      res.deliveryCode,
    );
    expect(res).toMatchObject({ attempts: 0, blocked: false });
  });

  it('otro chofer no puede (403) y no se guarda nada', async () => {
    armar();
    deliveries.buscarPorIdOUsuario.mockResolvedValue({ deliveryId: 'otro' });
    await expect(
      service.regenerateDeliveryCode(PEDIDO, 'u-2', RoleType.DELIVERY),
    ).rejects.toThrow(ForbiddenException);
    expect(orders.replaceDeliveryCode).not.toHaveBeenCalled();
  });

  it('con el pedido sin salir (o ya entregado) responde 409', async () => {
    armar(OrderStatus.ACCEPTED);
    await expect(
      service.regenerateDeliveryCode(PEDIDO, 'admin', RoleType.ADMIN),
    ).rejects.toThrow(ConflictException);
    expect(orders.replaceDeliveryCode).not.toHaveBeenCalled();
  });

  it('si el pedido dejó de estar en camino mientras tanto, 409', async () => {
    armar();
    orders.replaceDeliveryCode.mockResolvedValue(false);
    await expect(
      service.regenerateDeliveryCode(PEDIDO, 'admin', RoleType.ADMIN),
    ).rejects.toThrow(ConflictException);
  });

  describe('getDeliveryCode · intentos del cliente', () => {
    const conIntentos = (n: number) => {
      armar();
      deliveries.buscarPorIdOUsuario.mockResolvedValue({ deliveryId: 'd-1' });
      jest.spyOn(service, 'findOne').mockResolvedValue({
        orderId: PEDIDO,
        deliveryId: 'd-1',
        status: OrderStatus.ON_THE_WAY,
        deliveryCode: '123456',
        deliveryCodeAttempts: n,
      } as unknown as Order);
    };

    it('con 4 errados informa attempts 4 y blocked false', async () => {
      conIntentos(4);
      expect(
        await service.getDeliveryCode(PEDIDO, 'u-1', RoleType.DELIVERY),
      ).toMatchObject({ attempts: 4, blocked: false });
    });

    it('con 5 errados informa blocked true', async () => {
      conIntentos(5);
      expect(
        await service.getDeliveryCode(PEDIDO, 'u-1', RoleType.DELIVERY),
      ).toMatchObject({ attempts: 5, blocked: true });
    });
  });
});
