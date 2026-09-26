import { In, Repository } from 'typeorm';
import { OrderTypeormRepository } from './order.typeorm.repository';
import { Order, OrderStatus } from '../entities/order.entity';

/**
 * `findAllPaginated` con filtros (`term`/`status`/`from`/`to`) arma el WHERE a
 * mano con un query builder: lo que se prueba acá es que ese WHERE quede bien
 * armado, sin pisarse entre condiciones, y que el aislamiento por
 * distribuidora viaje SIEMPRE junto al resto de los filtros (no se pierde
 * cuando hay `term`).
 */
describe('OrderTypeormRepository · filtro de GET /orders', () => {
  interface QbFake {
    leftJoin: jest.Mock;
    withDeleted: jest.Mock;
    andWhere: jest.Mock;
    clone: jest.Mock;
    orderBy: jest.Mock;
    take: jest.Mock;
    skip: jest.Mock;
    getCount: jest.Mock;
    getRawAndEntities: jest.Mock;
  }

  let qb: QbFake;
  let orderRepo: {
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
  };
  let repo: OrderTypeormRepository;

  const armarQb = (): QbFake => {
    const fake: QbFake = {
      leftJoin: jest.fn(() => fake),
      withDeleted: jest.fn(() => fake),
      andWhere: jest.fn(() => fake),
      clone: jest.fn(() => fake),
      orderBy: jest.fn(() => fake),
      take: jest.fn(() => fake),
      skip: jest.fn(() => fake),
      getCount: jest.fn().mockResolvedValue(0),
      getRawAndEntities: jest
        .fn()
        .mockResolvedValue({ raw: [], entities: [] as Order[] }),
    };
    return fake;
  };

  beforeEach(() => {
    qb = armarQb();
    orderRepo = {
      createQueryBuilder: jest.fn(() => qb),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    repo = new OrderTypeormRepository(
      orderRepo as unknown as Repository<Order>,
    );
  });

  it('sin term/status/from/to usa la consulta simple (sin query builder)', async () => {
    await repo.findAllPaginated(10, 0, 'dist-1');

    expect(orderRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ distributorId: 'dist-1' }) as unknown,
      }),
    );
    expect(orderRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('con term arma el WHERE por nombre/email/teléfono del cliente y por el id del pedido', async () => {
    qb.getCount.mockResolvedValue(1);
    qb.getRawAndEntities.mockResolvedValue({
      raw: [],
      entities: [{ orderId: 'o1' } as Order],
    });
    orderRepo.find.mockResolvedValue([{ orderId: 'o1' } as Order]);

    const resultado = await repo.findAllPaginated(10, 0, null, {
      term: 'ana',
    });

    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('customer.fullName ILIKE :term'),
      { term: '%ana%', idTerm: '%ana%' },
    );
    expect(orderRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: In(['o1']) } }),
    );
    expect(resultado.total).toBe(1);
    expect(resultado.orders).toEqual([{ orderId: 'o1' }]);
  });

  it('el aislamiento por distribuidora viaja junto con term (no se pierde)', async () => {
    await repo.findAllPaginated(10, 0, 'dist-1', { term: 'zzzz' });

    const llamadas = qb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
    expect(llamadas).toContain('order.distributorId = :distributorId');
    expect(
      llamadas.some(
        (sql) =>
          typeof sql === 'string' && sql.includes('customer.fullName ILIKE'),
      ),
    ).toBe(true);
    // La condición de distribuidora se agrega con su propio valor.
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.distributorId = :distributorId',
      { distributorId: 'dist-1' },
    );
  });

  it('status filtra por el estado exacto', async () => {
    await repo.findAllPaginated(10, 0, null, { status: OrderStatus.PENDING });

    expect(qb.andWhere).toHaveBeenCalledWith('order.status = :status', {
      status: OrderStatus.PENDING,
    });
  });

  it('from/to arman un rango con `to` inclusivo (hasta el día siguiente, exclusivo)', async () => {
    await repo.findAllPaginated(10, 0, null, {
      from: '2026-09-01',
      to: '2026-09-02',
    });

    expect(qb.andWhere).toHaveBeenCalledWith('order.createdAt >= :from', {
      from: new Date('2026-09-01T00:00:00'),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('order.createdAt < :to', {
      to: new Date('2026-09-03T00:00:00'),
    });
  });

  it('sin resultados no llama a buscar el detalle completo', async () => {
    qb.getCount.mockResolvedValue(0);

    const resultado = await repo.findAllPaginated(10, 0, null, {
      term: 'zzzznoexiste',
    });

    expect(resultado).toEqual({ orders: [], total: 0, limit: 10, offset: 0 });
    expect(orderRepo.find).not.toHaveBeenCalled();
  });
});
