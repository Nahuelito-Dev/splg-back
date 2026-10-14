import { GoneException, NotFoundException } from '@nestjs/common';
import { OrderService } from './order.service';
import { Order, OrderStatus } from './entities/order.entity';
import { OrderController } from './order.controller';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';

/**
 * Lectura de un pedido por un chofer (`GET /orders/:id`): sólo lo suyo, lo que
 * se le ofreció o el pool de disponibles. Lo ajeno es 404.
 */
describe('OrderService.getOne · chofer', () => {
  const PEDIDO = 'f1f1f1f1-0000-4000-8000-000000000001';
  const DIST = 'dddddddd-0000-4000-8000-00000000000a';
  const USER_CHOFER = 'u1u1u1u1-0000-4000-8000-000000000001';
  const DELIVERY_PROPIO = 'd1d1d1d1-0000-4000-8000-000000000003';

  let hasActiveOffer: jest.Mock;
  let hasHeldOrder: jest.Mock;
  let motivoParaNoRecibir: jest.Mock;
  let buscarPorIdOUsuario: jest.Mock;
  let service: OrderService;

  const pedido = (parcial: Partial<Order>): Order =>
    ({
      orderId: PEDIDO,
      customerId: 'cliente',
      distributorId: DIST,
      deliveryId: null,
      status: OrderStatus.PENDING,
      items: [],
      ...parcial,
    }) as unknown as Order;

  const armar = (p: Order) => {
    hasActiveOffer = jest.fn().mockResolvedValue(false);
    hasHeldOrder = jest.fn().mockResolvedValue(false);
    motivoParaNoRecibir = jest.fn().mockResolvedValue(null);
    buscarPorIdOUsuario = jest.fn().mockResolvedValue({
      deliveryId: DELIVERY_PROPIO,
      userId: USER_CHOFER,
      distributorId: DIST,
    });
    service = Object.assign(Object.create(OrderService.prototype), {
      deliveries: { buscarPorIdOUsuario },
      dispatchOffers: { hasActiveOffer, hasHeldOrder },
      truckLoadGate: { motivoParaNoRecibir },
    }) as OrderService;
    jest.spyOn(service, 'findOne').mockResolvedValue(p);
  };

  const leer = () => service.getOne(PEDIDO, DIST, undefined, USER_CHOFER);

  it('lee el pedido que tiene asignado', async () => {
    armar(
      pedido({ deliveryId: DELIVERY_PROPIO, status: OrderStatus.ACCEPTED }),
    );
    await expect(leer()).resolves.toMatchObject({ id: PEDIDO });
  });

  it('no lee el pedido asignado a otro chofer', async () => {
    armar(pedido({ deliveryId: 'otro', status: OrderStatus.ACCEPTED }));
    await expect(leer()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lee el pedido que tiene en oferta vigente', async () => {
    armar(pedido({ deliveryId: null, status: OrderStatus.RESERVED }));
    hasActiveOffer.mockResolvedValue(true);
    await expect(leer()).resolves.toBeDefined();
    expect(hasActiveOffer).toHaveBeenCalledWith(PEDIDO, USER_CHOFER);
  });

  it('lee un pedido del pool: pendiente, sin chofer, de su distribuidora', async () => {
    armar(pedido({}));
    await expect(leer()).resolves.toBeDefined();
  });

  it('no lee un pedido del pool si no puede recibir pedidos por su carga', async () => {
    armar(pedido({}));
    motivoParaNoRecibir.mockResolvedValue('Abrí tu carga para recibir pedidos');
    await expect(leer()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('no lee un pedido ya entregado de otro chofer', async () => {
    armar(pedido({ deliveryId: 'otro', status: OrderStatus.DELIVERED }));
    await expect(leer()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el chofer que TUVO el pedido y ya no es suyo recibe 410, para que la app salga de la pantalla', async () => {
    armar(pedido({ deliveryId: null, status: OrderStatus.PENDING }));
    motivoParaNoRecibir.mockResolvedValue('Abrí tu carga para recibir pedidos');
    hasHeldOrder.mockResolvedValue(true);
    await expect(leer()).rejects.toBeInstanceOf(GoneException);
    expect(hasHeldOrder).toHaveBeenCalledWith(PEDIDO, USER_CHOFER);
  });

  it('un pedido asignado a otro, que este chofer tuvo antes, también es 410', async () => {
    armar(pedido({ deliveryId: 'otro', status: OrderStatus.ACCEPTED }));
    hasHeldOrder.mockResolvedValue(true);
    await expect(leer()).rejects.toBeInstanceOf(GoneException);
  });

  it('no lee un pedido pendiente de otra distribuidora', async () => {
    armar(pedido({ distributorId: 'otra' }));
    // El contexto de tenant coincide con el del chofer, pero el pedido no.
    await expect(
      service.getOne(PEDIDO, null, undefined, USER_CHOFER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un usuario sin perfil de chofer no lee nada', async () => {
    armar(pedido({}));
    buscarPorIdOUsuario.mockResolvedValue(null);
    await expect(leer()).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OrderController · roles de las lecturas por cliente', () => {
  it('GET /orders/customer/:customerId no admite al chofer', () => {
    const handler = (
      OrderController.prototype as unknown as Record<string, object>
    )['findByCustomer'];
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as RoleType[];
    expect(roles).not.toContain(RoleType.DELIVERY);
    expect(roles).toEqual(
      expect.arrayContaining([
        RoleType.CUSTOMER,
        RoleType.ADMIN,
        RoleType.SUPER_ADMIN,
      ]),
    );
  });
});

describe('OrderService.assertPedidoPropioDelChofer', () => {
  const USER = 'u1u1u1u1-0000-4000-8000-000000000001';
  const PROPIO = 'd1d1d1d1-0000-4000-8000-000000000003';
  const hasHeldOrder = jest.fn();
  const buscarPorIdOUsuario = jest.fn();
  const service = Object.assign(Object.create(OrderService.prototype), {
    deliveries: { buscarPorIdOUsuario },
    dispatchOffers: { hasHeldOrder },
  }) as OrderService;
  const pedido = (deliveryId: string | null): Order =>
    ({ orderId: 'o1', deliveryId }) as unknown as Order;

  beforeEach(() => {
    hasHeldOrder.mockReset().mockResolvedValue(false);
    buscarPorIdOUsuario.mockReset().mockResolvedValue({ deliveryId: PROPIO });
  });

  it('el pedido asignado al chofer pasa', async () => {
    await expect(
      service.assertPedidoPropioDelChofer(pedido(PROPIO), USER),
    ).resolves.toBeUndefined();
  });

  it('el pedido de otro chofer es 404', async () => {
    await expect(
      service.assertPedidoPropioDelChofer(pedido('otro'), USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un pedido sin chofer es 404', async () => {
    await expect(
      service.assertPedidoPropioDelChofer(pedido(null), USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('si el chofer lo tuvo y ya no es suyo es 410', async () => {
    hasHeldOrder.mockResolvedValue(true);
    await expect(
      service.assertPedidoPropioDelChofer(pedido('otro'), USER),
    ).rejects.toBeInstanceOf(GoneException);
  });
});
