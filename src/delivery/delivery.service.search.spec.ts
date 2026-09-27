import { Repository } from 'typeorm';
import { DeliveryService } from './delivery.service';
import { Delivery } from './entities/delivery.entity';
import { DeliveryStatusFilter } from './dto/query-delivery.dto';
import { RedisService } from '../redis/redis.service';

/**
 * `GET /delivery` y `GET /delivery/active` aceptaban `term` (PaginationDto)
 * pero lo ignoraban. Esto prueba que el WHERE se arme bien: nombre/email/
 * teléfono del chofer y patente del vehículo (vía EXISTS, sin duplicar filas),
 * y que el aislamiento por distribuidora viaje junto con `term`.
 */
describe('DeliveryService · búsqueda de choferes', () => {
  interface QbFake {
    leftJoinAndSelect: jest.Mock;
    andWhere: jest.Mock;
    take: jest.Mock;
    skip: jest.Mock;
    getManyAndCount: jest.Mock;
  }

  let qb: QbFake;
  let deliveryRepo: {
    createQueryBuilder: jest.Mock;
    findAndCount: jest.Mock;
  };
  let redis: { removeDriver: jest.Mock };
  let service: DeliveryService;

  beforeEach(() => {
    qb = {
      leftJoinAndSelect: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      take: jest.fn(() => qb),
      skip: jest.fn(() => qb),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    deliveryRepo = {
      createQueryBuilder: jest.fn(() => qb),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    redis = { removeDriver: jest.fn() };
    service = new DeliveryService(
      deliveryRepo as unknown as Repository<Delivery>,
      redis as unknown as RedisService,
    );
  });

  it('sin term usa la consulta simple (sin query builder)', async () => {
    await service.findAll({ limit: 10, offset: 0 }, 'dist-1');

    expect(deliveryRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ distributorId: 'dist-1' }) as unknown,
      }),
    );
    expect(deliveryRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('con term busca por nombre/email/teléfono y por patente (EXISTS, sin join a car)', async () => {
    await service.findAll({ limit: 10, offset: 0, term: 'ana' }, null);

    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('user.fullName ILIKE :term'),
      { term: '%ana%' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('EXISTS (SELECT 1 FROM car'),
      { term: '%ana%' },
    );
  });

  it('el aislamiento por distribuidora viaja junto con term', async () => {
    await service.findAll({ limit: 10, offset: 0, term: 'zzzz' }, 'dist-1');

    expect(qb.andWhere).toHaveBeenCalledWith(
      'delivery.distributorId = :distributorId',
      { distributorId: 'dist-1' },
    );
  });

  it('findActiveDeliveries con term filtra además por habilitado+validado+en línea', async () => {
    await service.findActiveDeliveries(
      { limit: 10, offset: 0, term: 'ana' },
      null,
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      'delivery.isEnabled = true AND delivery.validated = true AND delivery.isAvailable = true',
    );
  });

  it('findAll con status=disabled filtra por deshabilitados', async () => {
    await service.findAll(
      { limit: 10, offset: 0, term: 'ana' },
      null,
      DeliveryStatusFilter.DISABLED,
    );

    expect(qb.andWhere).toHaveBeenCalledWith('delivery.isEnabled = false');
  });
});
