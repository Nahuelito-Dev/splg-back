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
    findOne: jest.Mock;
  };
  let qbDelResumen: {
    where: jest.Mock;
    andWhere: jest.Mock;
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
      findOne: jest.fn(),
    };
    qbDelResumen = qb;
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

  describe('moderación', () => {
    const calificacion = (over: Partial<Rating> = {}) =>
      ({
        ratingId: 'r1',
        distributorId: 'd1',
        toUserId: 'chofer',
        fromRole: RaterRole.CUSTOMER,
        hidden: false,
        hiddenReason: null,
        ...over,
      }) as Rating;

    it('el resumen no cuenta las ocultas', async () => {
      await service.getSummaryForUser('chofer');
      expect(qbDelResumen.andWhere).toHaveBeenCalledWith('r.hidden = false');
    });

    it('ocultar guarda motivo, fecha y quién, y recalcula el promedio del chofer', async () => {
      ratings.findOne.mockResolvedValue(calificacion());
      await service.hide('r1', 'ofensivo', 'admin-1', 'd1');
      expect(ratings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          hidden: true,
          hiddenReason: 'ofensivo',
          hiddenByUserId: 'admin-1',
          hiddenAt: expect.any(Date) as Date,
        }),
      );
      expect(deliveries.updateCalificationByUserId).toHaveBeenCalledWith(
        'chofer',
        4.5,
      );
    });

    it('ocultar una oculta es 409; mostrar una visible es 409', async () => {
      ratings.findOne.mockResolvedValue(calificacion({ hidden: true }));
      await expect(
        service.hide('r1', 'x', 'admin-1', 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      ratings.findOne.mockResolvedValue(calificacion());
      await expect(service.unhide('r1', 'x', 'd1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('mostrar limpia la moderación y vuelve a contar', async () => {
      ratings.findOne.mockResolvedValue(
        calificacion({ hidden: true, hiddenReason: 'ofensivo' }),
      );
      await service.unhide('r1', 'error mío', 'd1');
      expect(ratings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          hidden: false,
          hiddenReason: null,
          hiddenAt: null,
          hiddenByUserId: null,
        }),
      );
    });

    it('la ficha de otra distribuidora es 404', async () => {
      ratings.findOne.mockResolvedValue(null);
      await expect(service.findOne('r1', 'otra')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
