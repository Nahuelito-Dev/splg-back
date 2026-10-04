import { Repository } from 'typeorm';
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
