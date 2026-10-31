import { EntityManager, In, Repository } from 'typeorm';
import { DispatchOfferTypeormRepository } from './dispatch-offer.typeorm.repository';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../entities/dispatch-offer.entity';

describe('DispatchOfferTypeormRepository.findDriverOfferState', () => {
  const COOLDOWN = 3 * 60 * 1000;
  const MAX = 3;
  const now = new Date('2026-10-03T12:00:00Z');
  const hace = (ms: number) => new Date(now.getTime() - ms);

  const repoCon = (rows: Partial<DispatchOffer>[]) => {
    const orm = { find: jest.fn().mockResolvedValue(rows) };
    return new DispatchOfferTypeormRepository(
      orm as unknown as Repository<DispatchOffer>,
    );
  };

  it('el que dejó vencer hace más del cooldown es re-ofertable', async () => {
    const repo = repoCon([
      {
        driverId: 'd1',
        status: DispatchOfferStatus.EXPIRED,
        expiresAt: hace(COOLDOWN + 1000),
      },
    ]);
    expect(await repo.findDriverOfferState('o', now, COOLDOWN, MAX)).toEqual({
      blocked: [],
      reofferable: ['d1'],
    });
  });

  it('el que venció hace menos del cooldown sigue bloqueado', async () => {
    const repo = repoCon([
      {
        driverId: 'd1',
        status: DispatchOfferStatus.EXPIRED,
        expiresAt: hace(COOLDOWN - 1000),
      },
    ]);
    expect(await repo.findDriverOfferState('o', now, COOLDOWN, MAX)).toEqual({
      blocked: ['d1'],
      reofferable: [],
    });
  });

  it('el chofer que sostuvo y liberó el pedido (historial A rechazada, B aceptada) no se reofrece', async () => {
    const repo = repoCon([
      {
        driverId: 'A',
        status: DispatchOfferStatus.REJECTED,
        expiresAt: hace(COOLDOWN + 1000),
      },
      {
        driverId: 'B',
        status: DispatchOfferStatus.ACCEPTED,
        expiresAt: hace(1000),
      },
    ]);
    const estado = await repo.findDriverOfferState('o', now, COOLDOWN, MAX);
    expect(estado.blocked).toEqual(expect.arrayContaining(['A', 'B']));
    expect(estado.reofferable).toEqual([]);
  });

  it('una oferta retirada por edición del pedido no cuenta: ni bloquea, ni vencida, ni contactado', async () => {
    const repo = repoCon([
      {
        driverId: 'd1',
        status: DispatchOfferStatus.SUPERSEDED,
        expiresAt: new Date(now.getTime() + 20_000),
      },
      {
        driverId: 'd1',
        status: DispatchOfferStatus.SUPERSEDED,
        expiresAt: new Date(now.getTime() + 20_000),
      },
      {
        driverId: 'd1',
        status: DispatchOfferStatus.SUPERSEDED,
        expiresAt: new Date(now.getTime() + 20_000),
      },
    ]);
    expect(await repo.findDriverOfferState('o', now, COOLDOWN, MAX)).toEqual({
      blocked: [],
      reofferable: [],
    });
  });

  it('rechazó, aceptó u oferta vigente: bloqueado siempre, aunque haya otra oferta vencida vieja', async () => {
    const vieja = hace(COOLDOWN * 10);
    const repo = repoCon([
      { driverId: 'r', status: DispatchOfferStatus.REJECTED, expiresAt: vieja },
      { driverId: 'a', status: DispatchOfferStatus.ACCEPTED, expiresAt: vieja },
      {
        driverId: 'o',
        status: DispatchOfferStatus.OFFERED,
        expiresAt: new Date(now.getTime() + 1000),
      },
      { driverId: 'r', status: DispatchOfferStatus.EXPIRED, expiresAt: vieja },
    ]);
    const res = await repo.findDriverOfferState('ord', now, COOLDOWN, MAX);
    expect(res.blocked.sort()).toEqual(['a', 'o', 'r']);
    expect(res.reofferable).toEqual([]);
  });

  it('con menos del tope de ofertas vencidas sigue siendo re-ofertable', async () => {
    const vieja = hace(COOLDOWN * 10);
    const repo = repoCon(
      [1, 2].map(() => ({
        driverId: 'd1',
        status: DispatchOfferStatus.EXPIRED,
        expiresAt: vieja,
      })),
    );
    expect(await repo.findDriverOfferState('o', now, COOLDOWN, MAX)).toEqual({
      blocked: [],
      reofferable: ['d1'],
    });
  });

  it('con el tope de ofertas vencidas queda agotado (bloqueado) aunque pasó el cooldown', async () => {
    const vieja = hace(COOLDOWN * 10);
    const repo = repoCon(
      [1, 2, 3].map(() => ({
        driverId: 'd1',
        status: DispatchOfferStatus.EXPIRED,
        expiresAt: vieja,
      })),
    );
    expect(await repo.findDriverOfferState('o', now, COOLDOWN, MAX)).toEqual({
      blocked: ['d1'],
      reofferable: [],
    });
  });
});

describe('DispatchOfferTypeormRepository.recordDriverHeldOrder', () => {
  const montar = (over: {
    affected?: number;
    yaAceptada?: number;
    order?: { distributorId: string } | null;
  }) => {
    const orm = {
      update: jest.fn().mockResolvedValue({ affected: over.affected ?? 0 }),
      count: jest.fn().mockResolvedValue(over.yaAceptada ?? 0),
      create: jest.fn((x: Partial<DispatchOffer>) => x),
      save: jest.fn().mockResolvedValue(undefined),
      manager: {
        findOne: jest
          .fn()
          .mockResolvedValue(
            over.order === undefined ? { distributorId: 'dist-1' } : over.order,
          ),
      },
    };
    return {
      orm,
      repo: new DispatchOfferTypeormRepository(
        orm as unknown as Repository<DispatchOffer>,
      ),
    };
  };

  it('si el chofer tenía una oferta OFFERED la cierra como ACCEPTED y no inserta', async () => {
    const { orm, repo } = montar({ affected: 1 });
    await repo.recordDriverHeldOrder('o', 'd');
    expect(orm.update).toHaveBeenCalledWith(
      { orderId: 'o', driverId: 'd', status: DispatchOfferStatus.OFFERED },
      { status: DispatchOfferStatus.ACCEPTED },
    );
    expect(orm.save).not.toHaveBeenCalled();
  });

  it('sin oferta (asignación manual o vencida antes de aceptar) inserta una fila ACCEPTED', async () => {
    const { orm, repo } = montar({});
    await repo.recordDriverHeldOrder('o', 'd');
    expect(orm.save).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'o',
        driverId: 'd',
        distributorId: 'dist-1',
        status: DispatchOfferStatus.ACCEPTED,
      }),
    );
  });

  it('es idempotente: si ya hay una ACCEPTED no inserta otra', async () => {
    const { orm, repo } = montar({ yaAceptada: 1 });
    await repo.recordDriverHeldOrder('o', 'd');
    expect(orm.save).not.toHaveBeenCalled();
  });
});

describe('DispatchOfferTypeormRepository.withdrawOtherActiveOffers', () => {
  const montar = (abiertas: Array<Partial<DispatchOffer>>) => {
    const manager = {
      find: jest.fn().mockResolvedValue(abiertas),
      update: jest.fn().mockResolvedValue({ affected: abiertas.length }),
    };
    const repo = new DispatchOfferTypeormRepository(
      {} as unknown as Repository<DispatchOffer>,
    );
    return {
      manager: manager as unknown as EntityManager,
      manager_: manager,
      repo,
    };
  };

  it('retira las ofertas OFFERED de los demás con el manager recibido y devuelve a quién avisar', async () => {
    const { manager, manager_, repo } = montar([
      { offerId: 'of-1', driverId: 'a' },
      { offerId: 'of-2', driverId: 'b' },
      { offerId: 'of-3', driverId: 'dueño' },
    ]);

    const avisar = await repo.withdrawOtherActiveOffers(
      manager,
      'ord-1',
      'dueño',
      DispatchOfferStatus.SUPERSEDED,
    );

    expect(avisar).toEqual(['a', 'b']);
    expect(manager_.find).toHaveBeenCalledWith(
      DispatchOffer,
      expect.objectContaining({
        where: { orderId: 'ord-1', status: DispatchOfferStatus.OFFERED },
      }),
    );
    expect(manager_.update).toHaveBeenCalledWith(
      DispatchOffer,
      { offerId: In(['of-1', 'of-2']) },
      { status: DispatchOfferStatus.SUPERSEDED },
    );
  });

  it('sin otras ofertas no escribe nada', async () => {
    const { manager, manager_, repo } = montar([
      { offerId: 'of-3', driverId: 'dueño' },
    ]);
    expect(
      await repo.withdrawOtherActiveOffers(
        manager,
        'ord-1',
        'dueño',
        DispatchOfferStatus.SUPERSEDED,
      ),
    ).toEqual([]);
    expect(manager_.update).not.toHaveBeenCalled();
  });
});

describe('DispatchOfferTypeormRepository: cierres de ofertas', () => {
  const repoCon = (orm: object) =>
    new DispatchOfferTypeormRepository(
      orm as unknown as Repository<DispatchOffer>,
    );

  describe('updateStatus', () => {
    it('sólo cambia una oferta que sigue OFFERED', async () => {
      const orm = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
      const ok = await repoCon(orm).updateStatus(
        'of-1',
        DispatchOfferStatus.EXPIRED,
      );
      expect(ok).toBe(true);
      expect(orm.update).toHaveBeenCalledWith(
        { offerId: 'of-1', status: DispatchOfferStatus.OFFERED },
        { status: DispatchOfferStatus.EXPIRED },
      );
    });

    it('si ya estaba aceptada (o cerrada) no la toca y avisa con false', async () => {
      const orm = { update: jest.fn().mockResolvedValue({ affected: 0 }) };
      expect(
        await repoCon(orm).updateStatus('of-1', DispatchOfferStatus.EXPIRED),
      ).toBe(false);
    });
  });

  describe('recordDriverHeldOrder', () => {
    it('el pedido tiene un solo chofer que lo sostiene: la constancia de otro se cierra antes de aceptar la nueva', async () => {
      const llamadas: Array<[object, object]> = [];
      const orm = {
        update: jest.fn((criterio: object, cambios: object) => {
          llamadas.push([criterio, cambios]);
          return Promise.resolve({ affected: 1 });
        }),
        count: jest.fn(),
      };
      await repoCon(orm).recordDriverHeldOrder('ord-1', 'chofer-b');

      // 1ro: lo que tenía otro chofer; 2do: la oferta viva del que lo toma.
      expect(llamadas[0][1]).toEqual({ status: DispatchOfferStatus.REJECTED });
      expect(llamadas[0][0]).toMatchObject({
        orderId: 'ord-1',
        status: DispatchOfferStatus.ACCEPTED,
      });
      expect(llamadas[1][0]).toEqual({
        orderId: 'ord-1',
        driverId: 'chofer-b',
        status: DispatchOfferStatus.OFFERED,
      });
      expect(llamadas[1][1]).toEqual({ status: DispatchOfferStatus.ACCEPTED });
    });

    it('la constancia nueva vence después de ofrecerse (expiresAt > offeredAt)', async () => {
      const guardadas: Array<{ expiresAt: Date }> = [];
      const orm = {
        update: jest.fn().mockResolvedValue({ affected: 0 }),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn((x: { expiresAt: Date }) => x),
        save: jest.fn((x: { expiresAt: Date }) => {
          guardadas.push(x);
          return Promise.resolve(x);
        }),
        manager: {
          findOne: jest
            .fn()
            .mockResolvedValue({ orderId: 'ord-1', distributorId: 'd1' }),
        },
      };
      const antes = Date.now();
      await repoCon(orm).recordDriverHeldOrder('ord-1', 'chofer-a');
      expect(guardadas).toHaveLength(1);
      expect(guardadas[0].expiresAt.getTime()).toBeGreaterThan(antes);
    });
  });
});

describe('DispatchOfferTypeormRepository.isInLiveBatch', () => {
  const repoCon = (rows: unknown[]) => {
    const orm = { query: jest.fn().mockResolvedValue(rows) };
    return {
      orm,
      repo: new DispatchOfferTypeormRepository(
        orm as unknown as Repository<DispatchOffer>,
      ),
    };
  };

  it('es verdadero si el pedido es parada viva de un lote que se está formando u ofreciendo', async () => {
    const { repo, orm } = repoCon([{ '?column?': 1 }]);
    expect(await repo.isInLiveBatch('ord-1')).toBe(true);
    const [sql, params] = orm.query.mock.calls[0] as [string, string[]];
    expect(sql).toContain(`b."status" IN ('forming', 'offered')`);
    expect(sql).toContain('s."active"');
    expect(params).toEqual(['ord-1']);
  });

  it('es falso si el pedido no está en un lote vivo', async () => {
    const { repo } = repoCon([]);
    expect(await repo.isInLiveBatch('ord-1')).toBe(false);
  });
});

describe('DispatchOfferTypeormRepository.isHeldForBatching', () => {
  const repoCon = (rows: unknown[]) => {
    const orm = { query: jest.fn().mockResolvedValue(rows) };
    return {
      orm,
      repo: new DispatchOfferTypeormRepository(
        orm as unknown as Repository<DispatchOffer>,
      ),
    };
  };

  it('consulta el interruptor y el margen de la distribuidora del pedido, con M4 apagado por omisión', async () => {
    const { repo, orm } = repoCon([{ '?column?': 1 }]);
    expect(await repo.isHeldForBatching('ord-1')).toBe(true);
    const [sql, params] = orm.query.mock.calls[0] as [string, string[]];
    expect(sql).toContain(`'enabled')::numeric, 0) = 1`);
    expect(sql).toContain(`'batchingHoldMinutes')::numeric, 60)`);
    expect(sql).toContain('o."scheduled_date" IS NOT NULL');
    expect(params).toEqual(['ord-1']);
  });

  it('es falso si no hay nada que retener (M4 apagado, inmediato o ya dentro del margen)', async () => {
    const { repo } = repoCon([]);
    expect(await repo.isHeldForBatching('ord-1')).toBe(false);
  });
});
