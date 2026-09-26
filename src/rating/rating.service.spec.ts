import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { RatingService } from './rating.service';
import { Rating, RaterRole } from './entities/rating.entity';
import { OrderService } from '../order/order.service';
import { DeliveryService } from '../delivery/delivery.service';
import { OrderStatus } from '../order/entities/order.entity';
import { RoleType } from '../common/constants/role-type.enum';

/**
 * Se califica un pedido entregado, cada lado una vez, y sólo lo propio: el
 * cliente sus pedidos, el chofer los que entregó. Cuando el cliente califica,
 * el promedio del chofer se actualiza en su perfil.
 */
describe('RatingService', () => {
  let service: RatingService;
  let ratings: {
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let orders: { findById: jest.Mock };
  let deliveries: {
    findById: jest.Mock;
    updateCalificationByUserId: jest.Mock;
  };

  const entregado = {
    orderId: 'o1',
    distributorId: 'd1',
    customerId: 'cliente',
    deliveryId: 'del-1',
    status: OrderStatus.DELIVERED,
  };
  const dto = { orderId: 'o1', stars: 5 };

  interface QbFalso {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getRawOne: jest.Mock;
  }

  beforeEach(() => {
    const qb: QbFalso = {
      select: jest.fn((): QbFalso => qb),
      addSelect: jest.fn((): QbFalso => qb),
      where: jest.fn((): QbFalso => qb),
      andWhere: jest.fn((): QbFalso => qb),
      getRawOne: jest.fn().mockResolvedValue({ average: '4.5', count: '2' }),
    };
    ratings = {
      create: jest.fn((d: Partial<Rating>) => d),
      save: jest.fn((r: Rating) => Promise.resolve(r)),
      createQueryBuilder: jest.fn((): QbFalso => qb),
    };
    orders = { findById: jest.fn().mockResolvedValue(entregado) };
    deliveries = {
      findById: jest.fn().mockResolvedValue({ userId: 'chofer' }),
      updateCalificationByUserId: jest.fn(),
    };
    service = new RatingService(
      ratings as unknown as Repository<Rating>,
      orders as unknown as OrderService,
      deliveries as unknown as DeliveryService,
    );
  });

  it('el cliente califica al chofer y se actualiza su promedio', async () => {
    const r = await service.create(dto, 'cliente', RoleType.CUSTOMER);
    expect(r).toMatchObject({
      toUserId: 'chofer',
      fromRole: RaterRole.CUSTOMER,
      distributorId: 'd1',
    });
    expect(deliveries.updateCalificationByUserId).toHaveBeenCalledWith(
      'chofer',
      4.5,
    );
  });

  it('el chofer califica al cliente, sin tocar promedios', async () => {
    const r = await service.create(dto, 'chofer', RoleType.DELIVERY);
    expect(r.toUserId).toBe('cliente');
    expect(deliveries.updateCalificationByUserId).not.toHaveBeenCalled();
  });

  it('sólo se califica un pedido entregado', async () => {
    orders.findById.mockResolvedValue({
      ...entregado,
      status: OrderStatus.ON_THE_WAY,
    });
    await expect(
      service.create(dto, 'cliente', RoleType.CUSTOMER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('nadie califica lo ajeno', async () => {
    await expect(
      service.create(dto, 'otro', RoleType.CUSTOMER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.create(dto, 'otro-chofer', RoleType.DELIVERY),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('calificar dos veces el mismo lado es un 409', async () => {
    ratings.save.mockRejectedValue({ code: '23505' });
    await expect(
      service.create(dto, 'cliente', RoleType.CUSTOMER),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('un pedido inexistente es 404', async () => {
    orders.findById.mockResolvedValue(null);
    await expect(
      service.create(dto, 'cliente', RoleType.CUSTOMER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
