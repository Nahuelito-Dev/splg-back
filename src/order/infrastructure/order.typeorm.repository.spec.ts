import { In, Not, Repository } from 'typeorm';
import { OrderTypeormRepository } from './order.typeorm.repository';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';

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
    addOrderBy: jest.Mock;
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
      addOrderBy: jest.fn(() => fake),
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

  it('con paymentStatus usa el query builder, filtra por el pago y conserva el tenant', async () => {
    qb.getCount.mockResolvedValue(0);
    qb.getRawAndEntities.mockResolvedValue({ raw: [], entities: [] });
    await repo.findAllPaginated(10, 0, 'dist-1', {
      paymentStatus: PaymentStatus.UNPAID,
    });
    expect(orderRepo.findAndCount).not.toHaveBeenCalled();
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.paymentStatus = :paymentStatus',
      { paymentStatus: PaymentStatus.UNPAID },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.distributorId = :distributorId',
      { distributorId: 'dist-1' },
    );
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
      from: new Date('2026-09-01T03:00:00.000Z'),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('order.createdAt < :to', {
      to: new Date('2026-09-03T03:00:00.000Z'),
    });
  });

  it('con filtros, la página desempata por id', async () => {
    qb.getCount.mockResolvedValue(1);
    await repo.findAllPaginated(10, 0, 'dist-1', {
      status: OrderStatus.PENDING,
    });

    expect(qb.orderBy).toHaveBeenCalledWith(
      'order.createdAt',
      'DESC',
      'NULLS LAST',
    );
    expect(qb.addOrderBy).toHaveBeenCalledWith('order.orderId', 'DESC');
  });

  it('deliveredFrom/deliveredTo filtran por deliveredAt con `deliveredTo` inclusivo', async () => {
    await repo.findAllPaginated(10, 0, 'dist-1', {
      deliveredFrom: '2026-09-01',
      deliveredTo: '2026-09-02',
    });

    expect(orderRepo.findAndCount).not.toHaveBeenCalled();
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.deliveredAt >= :deliveredFrom',
      { deliveredFrom: new Date('2026-09-01T03:00:00.000Z') },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.deliveredAt < :deliveredTo',
      { deliveredTo: new Date('2026-09-03T03:00:00.000Z') },
    );
  });

  it('sort y order ordenan por el campo pedido, los sin entregar al final', async () => {
    qb.getCount.mockResolvedValue(1);
    await repo.findAllPaginated(10, 0, null, {
      sort: 'deliveredAt',
      order: 'asc',
    });

    expect(qb.orderBy).toHaveBeenCalledWith(
      'order.deliveredAt',
      'ASC',
      'NULLS LAST',
    );
    expect(qb.addOrderBy).toHaveBeenCalledWith('order.orderId', 'ASC');
  });

  it('la página conserva el orden que resolvió el filtro', async () => {
    qb.getCount.mockResolvedValue(2);
    qb.getRawAndEntities.mockResolvedValue({
      raw: [],
      entities: [{ orderId: 'b' } as Order, { orderId: 'a' } as Order],
    });
    orderRepo.find.mockResolvedValue([
      { orderId: 'a' } as Order,
      { orderId: 'b' } as Order,
    ]);

    const r = await repo.findAllPaginated(10, 0, null, { order: 'asc' });

    expect(r.orders.map((o) => o.orderId)).toEqual(['b', 'a']);
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

/**
 * Los listados paginan con `skip`/`take`: si el orden sólo mira `createdAt`,
 * dos pedidos con la misma fecha pueden repetirse o saltearse entre páginas.
 * El id desempata y deja el orden total.
 */
describe('OrderTypeormRepository · orden estable al paginar', () => {
  const desempata = (orden: unknown, sentido: 'ASC' | 'DESC'): void => {
    expect(orden).toEqual({ createdAt: sentido, orderId: sentido });
  };

  const armar = () => {
    const orderRepo = {
      findAndCount: jest
        .fn<Promise<[Order[], number]>, [{ order: unknown }]>()
        .mockResolvedValue([[], 0]),
    };
    const repo = new OrderTypeormRepository(
      orderRepo as unknown as Repository<Order>,
    );
    const ordenUsado = (): unknown =>
      orderRepo.findAndCount.mock.calls[0][0].order;
    return { repo, ordenUsado };
  };

  it('findByDelivery desempata por id', async () => {
    const { repo, ordenUsado } = armar();
    await repo.findByDelivery('d-1', 20, 0, 'dist-1');
    desempata(ordenUsado(), 'DESC');
  });

  it('findByCustomer desempata por id', async () => {
    const { repo, ordenUsado } = armar();
    await repo.findByCustomer('c-1', 20, 0, 'dist-1');
    desempata(ordenUsado(), 'DESC');
  });

  it('F9: findAvailable deja afuera los de Mercado Pago que esperan el pago (y respeta el tenant)', async () => {
    const orderRepo = {
      findAndCount: jest
        .fn<Promise<[Order[], number]>, [{ where: unknown }]>()
        .mockResolvedValue([[], 0]),
    };
    const repo = new OrderTypeormRepository(
      orderRepo as unknown as Repository<Order>,
    );
    await repo.findAvailable(20, 0, 'dist-1');
    const where = orderRepo.findAndCount.mock.calls[0][0].where as Record<
      string,
      unknown
    >[];
    expect(where).toHaveLength(3);
    for (const w of where) expect(w.distributorId).toBe('dist-1');
    expect(where[0].paymentMethod).toEqual(Not(PaymentMethod.MERCADOPAGO));
    expect(where[1].paymentStatus).toBe(PaymentStatus.PAID);
    expect(where[2].depositPaid).toBe(true);
  });

  it('findAvailable desempata por id', async () => {
    const { repo, ordenUsado } = armar();
    await repo.findAvailable(20, 0, 'dist-1');
    desempata(ordenUsado(), 'ASC');
  });

  it('findAllPaginated sin filtros desempata por id', async () => {
    const { repo, ordenUsado } = armar();
    await repo.findAllPaginated(20, 0, 'dist-1');
    desempata(ordenUsado(), 'DESC');
  });
});
