import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrderDriverPhotoService } from './order-driver-photo.service';
import { OrderStatus } from '../entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import type { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import type { DeliveryService } from '../../delivery/delivery.service';
import type { EntityPhotoService } from '../../s3/entity-photo.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

const usuario = (role: RoleType, user_id = 'u-x'): AuthenticatedUser =>
  ({ role, user_id }) as AuthenticatedUser;

describe('OrderDriverPhotoService', () => {
  let orders: { findByIdFull: jest.Mock };
  let deliveries: { buscarPorIdOUsuario: jest.Mock };
  let fotos: { enlace: jest.Mock };
  let servicio: OrderDriverPhotoService;
  const pedido = (over: Record<string, unknown> = {}) => ({
    orderId: 'o1',
    distributorId: 'd1',
    customerId: 'cli',
    deliveryId: 'del-1',
    status: OrderStatus.ON_THE_WAY,
    delivery: { user: { photoKey: 'users/ch/f.png' } },
    ...over,
  });

  beforeEach(() => {
    orders = { findByIdFull: jest.fn().mockResolvedValue(pedido()) };
    deliveries = {
      buscarPorIdOUsuario: jest.fn().mockResolvedValue({ deliveryId: 'del-1' }),
    };
    fotos = {
      enlace: jest.fn().mockResolvedValue({ kind: 'stored', signed: {} }),
    };
    servicio = new OrderDriverPhotoService(
      orders as unknown as OrderRepositoryPort,
      deliveries as unknown as DeliveryService,
      fotos as unknown as EntityPhotoService,
    );
  });

  it('el cliente dueño la obtiene con el pedido aceptado o en camino', async () => {
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.ON_THE_WAY]) {
      orders.findByIdFull.mockResolvedValue(pedido({ status }));
      await servicio.enlace('o1', usuario(RoleType.CUSTOMER, 'cli'), null);
    }
    expect(fotos.enlace).toHaveBeenCalledWith('users/ch/f.png');
  });

  it('otro cliente o un pedido de otro tenant: 404', async () => {
    await expect(
      servicio.enlace('o1', usuario(RoleType.CUSTOMER, 'otro'), null),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      servicio.enlace('o1', usuario(RoleType.ADMIN), 'd2'),
    ).rejects.toBeInstanceOf(NotFoundException);
    orders.findByIdFull.mockResolvedValue(null);
    await expect(
      servicio.enlace('o1', usuario(RoleType.ADMIN), 'd1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el chofer asignado sí; otro chofer, 403', async () => {
    await servicio.enlace('o1', usuario(RoleType.DELIVERY), null);
    deliveries.buscarPorIdOUsuario.mockResolvedValue({ deliveryId: 'otro' });
    await expect(
      servicio.enlace('o1', usuario(RoleType.DELIVERY), null),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el admin del tenant sí', async () => {
    await servicio.enlace('o1', usuario(RoleType.ADMIN), 'd1');
    expect(fotos.enlace).toHaveBeenCalled();
  });

  it.each([OrderStatus.PENDING, OrderStatus.DELIVERED, OrderStatus.CANCELLED])(
    'con el pedido %s: 409',
    async (status) => {
      orders.findByIdFull.mockResolvedValue(pedido({ status }));
      await expect(
        servicio.enlace('o1', usuario(RoleType.CUSTOMER, 'cli'), null),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(fotos.enlace).not.toHaveBeenCalled();
    },
  );

  it('sin chofer o sin foto, el enlace es de una foto inexistente', async () => {
    orders.findByIdFull.mockResolvedValue(pedido({ delivery: null }));
    await servicio.enlace('o1', usuario(RoleType.CUSTOMER, 'cli'), null);
    expect(fotos.enlace).toHaveBeenCalledWith(undefined);
  });
});
