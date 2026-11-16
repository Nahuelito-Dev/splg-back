import { NotFoundException } from '@nestjs/common';
import { OrderService } from './order.service';
import { Order, OrderStatus } from './entities/order.entity';

const PEDIDO = 'f1f1f1f1-0000-4000-8000-000000000001';
const DIST = 'dddddddd-0000-4000-8000-00000000000a';

describe('OrderService.getStatusHistory', () => {
  let query: jest.Mock;
  let service: OrderService;

  const armar = () => {
    query = jest.fn().mockResolvedValue([
      {
        history_id: 'h1',
        from_status: null,
        to_status: OrderStatus.PENDING,
        reason: null,
        changed_at: new Date('2026-10-01T10:00:00Z'),
        user_id: 'u-cliente',
        full_name: 'Ana Cliente',
        type: 'customer',
      },
      {
        history_id: 'h2',
        from_status: OrderStatus.PENDING,
        to_status: OrderStatus.ON_THE_WAY,
        reason: null,
        changed_at: new Date('2026-10-01T11:00:00Z'),
        user_id: null,
        full_name: null,
        type: null,
      },
      {
        history_id: 'h3',
        from_status: OrderStatus.ON_THE_WAY,
        to_status: OrderStatus.ON_THE_WAY,
        reason: 'Cobro en efectivo registrado por un administrador: x',
        changed_at: new Date('2026-10-01T12:00:00Z'),
        user_id: 'u-admin',
        full_name: 'Admin Uno',
        type: 'admin',
      },
    ]);
    service = Object.assign(Object.create(OrderService.prototype), {
      orderRepository: { manager: { query } },
      deliveries: { buscarPorIdOUsuario: jest.fn() },
      dispatchOffers: { hasHeldOrder: jest.fn().mockResolvedValue(false) },
      truckLoadGate: {},
    }) as OrderService;
    jest.spyOn(service, 'findOne').mockResolvedValue({
      orderId: PEDIDO,
      customerId: 'u-cliente',
      distributorId: DIST,
      status: OrderStatus.DELIVERED,
    } as Order);
  };

  it('lista del más viejo al más nuevo con los estados de las apps, la nota y el actor', async () => {
    armar();
    const r = await service.getStatusHistory(
      PEDIDO,
      DIST,
      undefined,
      undefined,
      true,
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), [PEDIDO]);
    expect(r).toEqual([
      expect.objectContaining({
        id: 'h1',
        fromStatus: null,
        toStatus: 'pending',
        isNote: false,
        changedBy: {
          userId: 'u-cliente',
          role: 'customer',
          fullName: 'Ana Cliente',
        },
      }),
      expect.objectContaining({
        toStatus: 'out_for_delivery',
        isNote: false,
        changedBy: null,
      }),
      expect.objectContaining({
        fromStatus: 'out_for_delivery',
        toStatus: 'out_for_delivery',
        isNote: true,
        changedBy: { userId: 'u-admin', role: 'admin', fullName: 'Admin Uno' },
      }),
    ]);
  });

  it('el nombre del actor sólo lo ve el staff', async () => {
    armar();
    const r = await service.getStatusHistory(PEDIDO, DIST, 'u-cliente');
    expect(r.map((h) => h.changedBy?.fullName ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('pedido de otra distribuidora o de otro cliente: 404 sin consultar el historial', async () => {
    armar();
    await expect(
      service.getStatusHistory(PEDIDO, 'otra-dist'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.getStatusHistory(PEDIDO, DIST, 'otro-cliente'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(query).not.toHaveBeenCalled();
  });

  it('el chofer que no puede leer el pedido recibe 404', async () => {
    armar();
    const buscar = (
      service as unknown as { deliveries: { buscarPorIdOUsuario: jest.Mock } }
    ).deliveries.buscarPorIdOUsuario;
    buscar.mockResolvedValue(null);
    await expect(
      service.getStatusHistory(PEDIDO, DIST, undefined, 'u-chofer'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('OrderService.findCurrentOfDriver', () => {
  const armar = (chofer: unknown, encontrado: Order | null) => {
    const findCurrentOfDelivery = jest.fn().mockResolvedValue(encontrado);
    const service = Object.assign(Object.create(OrderService.prototype), {
      deliveries: { buscarPorIdOUsuario: jest.fn().mockResolvedValue(chofer) },
      orders: { findCurrentOfDelivery },
    }) as OrderService;
    return { service, findCurrentOfDelivery };
  };

  it('busca con el perfil del chofer, su distribuidora y el inicio del día', async () => {
    const { service, findCurrentOfDelivery } = armar({ deliveryId: 'del-1' }, {
      orderId: 'o1',
      status: OrderStatus.ACCEPTED,
      totalAmount: 1,
      items: [],
    } as unknown as Order);
    const r = await service.findCurrentOfDriver('u1', DIST);
    expect(r?.id).toBe('o1');
    expect(findCurrentOfDelivery).toHaveBeenCalledWith(
      'del-1',
      DIST,
      expect.any(Date),
    );
  });

  it('sin perfil de chofer o sin pedido, null', async () => {
    expect(
      await armar(null, null).service.findCurrentOfDriver('u1', DIST),
    ).toBeNull();
    expect(
      await armar({ deliveryId: 'x' }, null).service.findCurrentOfDriver(
        'u1',
        DIST,
      ),
    ).toBeNull();
  });
});
