import { EntityManager, In, Repository } from 'typeorm';
import { OrderLookupService } from './order-lookup.service';
import { Order, OrderStatus } from '../entities/order.entity';

describe('OrderLookupService.countActiveByCustomer', () => {
  let repo: { count: jest.Mock };
  let service: OrderLookupService;

  beforeEach(() => {
    repo = { count: jest.fn().mockResolvedValue(2) };
    service = new OrderLookupService(repo as unknown as Repository<Order>);
  });

  it('cuenta los cuatro estados abiertos del cliente, sin filtrar por distribuidora', async () => {
    await expect(service.countActiveByCustomer('u1')).resolves.toBe(2);
    expect(repo.count).toHaveBeenCalledWith({
      where: {
        customerId: 'u1',
        status: In([
          OrderStatus.RESERVED,
          OrderStatus.PENDING,
          OrderStatus.ACCEPTED,
          OrderStatus.ON_THE_WAY,
        ]),
      },
    });
  });

  it('dentro de una transacción cuenta con su manager', async () => {
    const manager = { count: jest.fn().mockResolvedValue(1) };
    await service.countActiveByCustomer(
      'u1',
      manager as unknown as EntityManager,
    );
    expect(manager.count).toHaveBeenCalledWith(Order, expect.anything());
    expect(repo.count).not.toHaveBeenCalled();
  });
});

describe('OrderLookupService.ultimaCompraEntregada', () => {
  const entregado = new Date('2026-09-01T00:00:00.000Z');
  let ordenes: { findOne: jest.Mock };
  let renglones: { find: jest.Mock };
  let service: OrderLookupService;

  beforeEach(() => {
    ordenes = { findOne: jest.fn() };
    renglones = { find: jest.fn() };
    const manager = {
      getRepository: (e: unknown) => (e === Order ? ordenes : renglones),
    };
    service = new OrderLookupService({
      manager,
    } as unknown as Repository<Order>);
  });

  it('sin pedidos entregados devuelve null', async () => {
    ordenes.findOne.mockResolvedValue(null);
    await expect(service.ultimaCompraEntregada('u1')).resolves.toBeNull();
    expect(renglones.find).not.toHaveBeenCalled();
  });

  it('suma los kilos con aritmética decimal exacta', async () => {
    ordenes.findOne.mockResolvedValue({
      orderId: 'o1',
      deliveredAt: entregado,
    });
    renglones.find.mockResolvedValue([
      { quantity: 3, gasCylinder: { weight: 0.1 } },
      { quantity: 1, gasCylinder: { weight: 0.2 } },
    ]);

    const r = await service.ultimaCompraEntregada('u1');

    expect(r?.kg).toBe(0.5);
  });

  it('busca el último entregado del cliente y suma los kilos de sus renglones', async () => {
    ordenes.findOne.mockResolvedValue({
      orderId: 'o1',
      deliveredAt: entregado,
    });
    renglones.find.mockResolvedValue([
      { quantity: 2, gasCylinder: { weight: 10 } },
      { quantity: 1, gasCylinder: { weight: 45 } },
    ]);

    await expect(service.ultimaCompraEntregada('u1')).resolves.toEqual({
      deliveredAt: entregado,
      kg: 65,
    });
    expect(ordenes.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'u1', status: OrderStatus.DELIVERED },
      }),
    );
  });
});

describe('OrderLookupService.findParaDespacho', () => {
  const fila = {
    orderId: 'o1',
    customerId: 'c1',
    status: OrderStatus.ACCEPTED,
    deliveryId: 'd1',
  };

  it('dentro de una transacción bloquea el pedido para que no cambie hasta el commit', async () => {
    const tx = { findOne: jest.fn().mockResolvedValue(fila) };
    const manager = { getRepository: jest.fn().mockReturnValue(tx) };
    const repo = { findOne: jest.fn() };
    const service = new OrderLookupService(
      repo as unknown as Repository<Order>,
    );

    await expect(
      service.findParaDespacho(
        'o1',
        'dist',
        manager as unknown as EntityManager,
      ),
    ).resolves.toEqual(fila);
    expect(tx.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_read' } }),
    );
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('fuera de una transacción no bloquea', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue(null) };
    const service = new OrderLookupService(
      repo as unknown as Repository<Order>,
    );

    await expect(service.findParaDespacho('o1', 'dist')).resolves.toBeNull();
    const [opciones] = repo.findOne.mock.calls[0] as [Record<string, unknown>];
    expect(opciones).not.toHaveProperty('lock');
  });
});

describe('OrderLookupService (recompra)', () => {
  const DESDE = new Date('2026-10-01T00:00:00.000Z');

  /** Un query builder que devuelve `filas` y deja registrada cada llamada. */
  const armarQb = (filas: unknown[]) => {
    const llamadas: Array<[string, unknown[]]> = [];
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'innerJoin',
      'select',
      'addSelect',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
    ]) {
      qb[m] = jest.fn().mockImplementation((...a: unknown[]) => {
        llamadas.push([m, a]);
        return qb;
      });
    }
    qb.getRawMany = jest.fn().mockResolvedValue(filas);
    return { qb, llamadas };
  };

  describe('comprasEntregadas', () => {
    const fila = (
      orderId: string,
      gasCylinderId: string,
      quantity: number,
    ) => ({
      orderId,
      customerId: 'u1',
      deliveredAt: new Date('2026-10-05T12:00:00Z'),
      addressId: 'a1',
      timeSlotId: null,
      paymentMethod: 'cash',
      gasCylinderId,
      quantity,
      weight: '10.00',
    });

    it('agrupa los renglones por pedido, con el peso de cada garrafa', async () => {
      const { qb } = armarQb([
        fila('o1', 'g10', 2),
        fila('o1', 'g45', 1),
        fila('o2', 'g10', 1),
      ]);
      const service = new OrderLookupService({
        manager: { createQueryBuilder: () => qb },
      } as unknown as Repository<Order>);

      const r = await service.comprasEntregadas('d1', DESDE);

      expect(r.map((c) => c.orderId)).toEqual(['o1', 'o2']);
      expect(r[0].items).toEqual([
        { gasCylinderId: 'g10', quantity: 2, weightKg: 10 },
        { gasCylinderId: 'g45', quantity: 1, weightKg: 10 },
      ]);
      expect(r[0]).toMatchObject({ customerId: 'u1', addressId: 'a1' });
    });

    it('acota por distribuidora, entregados y fecha; con cliente, sólo los suyos', async () => {
      const { qb, llamadas } = armarQb([]);
      const service = new OrderLookupService({
        manager: { createQueryBuilder: () => qb },
      } as unknown as Repository<Order>);

      await service.comprasEntregadas('d1', DESDE, 'u1');

      const condiciones = llamadas
        .filter(([m]) => m === 'where' || m === 'andWhere')
        .map(([, a]) => a[0]);
      expect(condiciones).toEqual([
        'ord.distributorId = :distributorId',
        'ord.status = :entregado',
        'ord.deliveredAt >= :desde',
        'ord.customerId = :customerId',
      ]);
    });

    it('sin cliente no filtra por cliente', async () => {
      const { qb, llamadas } = armarQb([]);
      const service = new OrderLookupService({
        manager: { createQueryBuilder: () => qb },
      } as unknown as Repository<Order>);
      await service.comprasEntregadas('d1', DESDE);
      expect(
        llamadas.some(([, a]) => a[0] === 'ord.customerId = :customerId'),
      ).toBe(false);
    });
  });

  it('clientesConPedidoVigente: los abiertos o recientes sin cancelar de la distribuidora', async () => {
    const { qb, llamadas } = armarQb([
      { customerId: 'u1' },
      { customerId: 'u2' },
    ]);
    const service = new OrderLookupService({
      createQueryBuilder: () => qb,
    } as unknown as Repository<Order>);

    const r = await service.clientesConPedidoVigente('d1', DESDE);

    expect([...r]).toEqual(['u1', 'u2']);
    expect(llamadas).toContainEqual([
      'where',
      ['ord.distributorId = :distributorId', { distributorId: 'd1' }],
    ]);
    const [, [texto, params]] = llamadas.find(([m]) => m === 'andWhere') as [
      string,
      [string, Record<string, unknown>],
    ];
    expect(texto).toContain('ord.status != :cancelado');
    expect(params).toMatchObject({
      cancelado: OrderStatus.CANCELLED,
      creadoDesde: DESDE,
      abiertos: [
        OrderStatus.RESERVED,
        OrderStatus.PENDING,
        OrderStatus.ACCEPTED,
        OrderStatus.ON_THE_WAY,
      ],
    });
  });

  it('hayPedidoDesde: un pedido del cliente en la distribuidora, no cancelado, desde esa fecha', async () => {
    const exists = jest.fn().mockResolvedValue(true);
    const service = new OrderLookupService({
      exists,
    } as unknown as Repository<Order>);

    await expect(service.hayPedidoDesde('d1', 'u1', DESDE)).resolves.toBe(true);

    const { where } = (
      exists.mock.calls as Array<[{ where: object }]>
    )[0][0] as {
      where: Record<string, unknown>;
    };
    expect(where).toMatchObject({ distributorId: 'd1', customerId: 'u1' });
    expect(where).toHaveProperty('status');
    expect(where).toHaveProperty('createdAt');
  });
});

describe('OrderLookupService (recupero de envases, CU-108)', () => {
  it('entregasProgramadas trae las del cliente en la ventana que todavía no salieron, de la más próxima a la más lejana', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        {
          orderId: 'o1',
          scheduledDate: '2026-11-03',
          status: OrderStatus.PENDING,
          deliveryId: null,
        },
      ]),
    };
    const service = new OrderLookupService({
      createQueryBuilder: jest.fn(() => qb),
    } as unknown as Repository<Order>);

    await expect(
      service.entregasProgramadas('u1', 'dist', '2026-10-31', '2026-11-07'),
    ).resolves.toEqual([
      {
        orderId: 'o1',
        scheduledDate: '2026-11-03',
        status: OrderStatus.PENDING,
        deliveryId: null,
      },
    ]);
    expect(qb.where).toHaveBeenCalledWith('o.customerId = :customerId', {
      customerId: 'u1',
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      'o.distributorId = :distributorId',
      { distributorId: 'dist' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'o.scheduledDate BETWEEN :desde AND :hasta',
      { desde: '2026-10-31', hasta: '2026-11-07' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith('o.status IN (:...estados)', {
      estados: [
        OrderStatus.RESERVED,
        OrderStatus.PENDING,
        OrderStatus.ACCEPTED,
      ],
    });
  });

  it('findManyForRecovery lee sólo dentro de la distribuidora y sin ids no consulta', async () => {
    const repo = {
      find: jest.fn().mockResolvedValue([
        {
          orderId: 'o1',
          customerId: 'u1',
          status: OrderStatus.ACCEPTED,
          deliveryId: 'del-1',
          scheduledDate: undefined,
        },
      ]),
    };
    const service = new OrderLookupService(
      repo as unknown as Repository<Order>,
    );

    const mapa = await service.findManyForRecovery(['o1'], 'dist');
    expect(mapa.get('o1')).toEqual({
      orderId: 'o1',
      customerId: 'u1',
      status: OrderStatus.ACCEPTED,
      deliveryId: 'del-1',
      scheduledDate: null,
      deliveredAt: null,
    });
    const [opciones] = repo.find.mock.calls[0] as [
      { where: { distributorId: string } },
    ];
    expect(opciones.where.distributorId).toBe('dist');

    repo.find.mockClear();
    expect((await service.findManyForRecovery([], 'dist')).size).toBe(0);
    expect(repo.find).not.toHaveBeenCalled();
  });
});
