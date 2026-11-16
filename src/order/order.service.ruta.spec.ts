import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrderService } from './order.service';
import { OrderStatus } from './entities/order.entity';
import { RoleType } from '../common/constants/role-type.enum';

describe('OrderService.datosParaLaRuta', () => {
  let findOne: jest.Mock;
  let buscarPorIdOUsuario: jest.Mock;
  let service: OrderService;

  const pedido = (cambios: Record<string, unknown> = {}) => ({
    orderId: 'o1',
    customerId: 'cli-1',
    deliveryId: 'del-1',
    distributorId: 'dist-1',
    status: OrderStatus.ON_THE_WAY,
    delivery: { userId: 'u-ch' },
    address: { location: { type: 'Point', coordinates: [-58.4173, -34.6118] } },
    ...cambios,
  });

  beforeEach(() => {
    findOne = jest.fn().mockResolvedValue(pedido());
    buscarPorIdOUsuario = jest.fn().mockResolvedValue({ deliveryId: 'del-1' });
    service = Object.assign(Object.create(OrderService.prototype), {
      orderRepository: { findOne },
      deliveries: { buscarPorIdOUsuario },
    }) as OrderService;
  });

  it('el cliente dueño: destino = la dirección de entrega, distribuidora y chofer del pedido', async () => {
    await expect(
      service.datosParaLaRuta('o1', 'cli-1', RoleType.CUSTOMER),
    ).resolves.toEqual({
      distributorId: 'dist-1',
      choferUserId: 'u-ch',
      destino: { lat: -34.6118, lng: -58.4173 },
    });
  });

  it('el chofer asignado también puede', async () => {
    await expect(
      service.datosParaLaRuta('o1', 'u-ch', RoleType.DELIVERY),
    ).resolves.toMatchObject({ distributorId: 'dist-1' });
  });

  it('otro cliente: 404 sin revelar el pedido', async () => {
    await expect(
      service.datosParaLaRuta('o1', 'cli-2', RoleType.CUSTOMER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('otro chofer: 404', async () => {
    buscarPorIdOUsuario.mockResolvedValue({ deliveryId: 'del-9' });
    await expect(
      service.datosParaLaRuta('o1', 'u-otro', RoleType.DELIVERY),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un usuario sin perfil de chofer: 404', async () => {
    buscarPorIdOUsuario.mockResolvedValue(null);
    await expect(
      service.datosParaLaRuta('o1', 'u-x', RoleType.DELIVERY),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pedido inexistente: 404', async () => {
    findOne.mockResolvedValue(null);
    await expect(
      service.datosParaLaRuta('o1', 'cli-1', RoleType.CUSTOMER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([RoleType.ADMIN, RoleType.SUPER_ADMIN])(
    '%s no pide rutas',
    async (rol) => {
      await expect(
        service.datosParaLaRuta('o1', 'a', rol),
      ).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('el cliente con el pedido aceptado (el chofer todavía no sale): 403', async () => {
    findOne.mockResolvedValue(pedido({ status: OrderStatus.ACCEPTED }));
    await expect(
      service.datosParaLaRuta('o1', 'cli-1', RoleType.CUSTOMER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el chofer con el pedido aceptado sí puede', async () => {
    findOne.mockResolvedValue(pedido({ status: OrderStatus.ACCEPTED }));
    await expect(
      service.datosParaLaRuta('o1', 'u-ch', RoleType.DELIVERY),
    ).resolves.toMatchObject({ distributorId: 'dist-1' });
  });

  it.each([OrderStatus.PENDING, OrderStatus.DELIVERED, OrderStatus.CANCELLED])(
    'pedido %s: 403 (no está activo)',
    async (status) => {
      findOne.mockResolvedValue(pedido({ status }));
      await expect(
        service.datosParaLaRuta('o1', 'cli-1', RoleType.CUSTOMER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('dirección sin coordenadas: 409', async () => {
    findOne.mockResolvedValue(pedido({ address: { location: null } }));
    await expect(
      service.datosParaLaRuta('o1', 'cli-1', RoleType.CUSTOMER),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
