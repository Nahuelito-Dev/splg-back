import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ClaimsService } from './claims.service';
import { Claim, ClaimStatus } from './entities/claim.entity';
import { OrderService } from '../order/order.service';

/**
 * Un reclamo cuelga de un pedido: tiene que existir, ser del cliente que
 * reclama y hereda la distribuidora del pedido. Al resolverlo, sólo lo toca un
 * administrador de esa distribuidora.
 */
describe('ClaimsService', () => {
  let service: ClaimsService;
  let claims: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let bloqueo: { setLock: jest.Mock; andWhere: jest.Mock };
  let orders: { findOne: jest.Mock; assertDeLaDistribuidora: jest.Mock };

  const dto = {
    orderId: 'o1',
    customerId: 'u1',
    reason: 'Fuga',
    description: 'Pierde gas',
  };

  beforeEach(() => {
    claims = {
      create: jest.fn((d: Partial<Claim>) => d),
      save: jest.fn((c: Claim) => Promise.resolve(c)),
      find: jest.fn(),
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) => fn(txManager)),
      },
    };
    bloqueo = {
      setLock: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
    };
    // `resolve`/`take`/`reopen` leen con lock y guardan en una transacción:
    // la lectura con lock y el guardado del manager reusan los mismos mocks.
    const txManager = {
      createQueryBuilder: jest.fn(() => ({
        setLock: bloqueo.setLock,
        where: jest.fn().mockReturnThis(),
        andWhere: bloqueo.andWhere,
        getOne: claims.findOne,
      })),
      save: claims.save,
    };
    orders = { findOne: jest.fn(), assertDeLaDistribuidora: jest.fn() };
    service = new ClaimsService(
      claims as unknown as Repository<Claim>,
      orders as unknown as OrderService,
    );
  });

  it('el reclamo hereda la distribuidora del pedido', async () => {
    orders.findOne.mockResolvedValue({
      customerId: 'u1',
      distributorId: 'd1',
    });
    const claim = await service.create(dto);
    expect(claim.distributorId).toBe('d1');
  });

  it('no se puede reclamar un pedido ajeno', async () => {
    orders.findOne.mockResolvedValue({ customerId: 'otro' });
    await expect(service.create(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(claims.save).not.toHaveBeenCalled();
  });

  it('un pedido inexistente es 404', async () => {
    orders.findOne.mockRejectedValue(new NotFoundException());
    await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un admin no resuelve reclamos de otra distribuidora', async () => {
    claims.findOne.mockResolvedValue(null);
    await expect(
      service.resolve('c1', 'ok', ClaimStatus.RESOLVED, 'd2'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(claims.save).not.toHaveBeenCalled();
    // El filtro por distribuidora va en la consulta con lock.
    expect(bloqueo.andWhere).toHaveBeenCalledWith(
      'claim.distributorId = :distributorId',
      { distributorId: 'd2' },
    );
  });

  it('take y reopen también acotan por la distribuidora', async () => {
    claims.findOne.mockResolvedValue(null);
    await expect(service.take('c1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.reopen('c1', 'm', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(bloqueo.andWhere).toHaveBeenCalledTimes(2);
    expect(bloqueo.andWhere).toHaveBeenCalledWith(
      'claim.distributorId = :distributorId',
      { distributorId: 'd2' },
    );
  });

  it('sin distribuidora (cross-tenant) no agrega el filtro', async () => {
    claims.findOne.mockResolvedValue({
      claimId: 'c1',
      status: ClaimStatus.PENDING,
    });
    await service.take('c1');
    expect(bloqueo.andWhere).not.toHaveBeenCalled();
  });

  it('resolver guarda la nota y el estado', async () => {
    claims.findOne.mockResolvedValue({
      claimId: 'c1',
      status: ClaimStatus.PENDING,
    });
    const r = await service.resolve('c1', 'Se cambió', ClaimStatus.RESOLVED);
    expect(r).toMatchObject({
      resolutionNote: 'Se cambió',
      status: ClaimStatus.RESOLVED,
    });
  });

  it('con distribuidora en contexto, el pedido de otra es 404', async () => {
    orders.assertDeLaDistribuidora.mockRejectedValue(new NotFoundException());
    await expect(service.create(dto, 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(orders.assertDeLaDistribuidora).toHaveBeenCalledWith('o1', 'd1');
    expect(claims.save).not.toHaveBeenCalled();
  });

  describe('máquina de estados', () => {
    it('resolve rechaza un salto inválido (resolved → rejected sin reabrir)', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.RESOLVED,
      });
      await expect(
        service.resolve('c1', 'otra vez', ClaimStatus.REJECTED),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(claims.save).not.toHaveBeenCalled();
    });

    it('resolve, take y reopen leen el reclamo con lock pesimista (FOR UPDATE)', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.PENDING,
      });
      await service.resolve('c1', 'ok', ClaimStatus.RESOLVED);
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.PENDING,
      });
      await service.take('c1');
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.RESOLVED,
      });
      await service.reopen('c1', 'motivo');
      expect(bloqueo.setLock).toHaveBeenCalledTimes(3);
      expect(bloqueo.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('resolve rechaza repetir el estado: no pisa la nota', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.IN_PROCESS,
        resolutionNote: 'nota previa',
      });
      await expect(
        service.resolve('c1', 'otra nota', ClaimStatus.IN_PROCESS),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(claims.save).not.toHaveBeenCalled();
    });

    it('take pasa un reclamo pendiente a in_process sin pisar la nota', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.PENDING,
        resolutionNote: null,
      });
      const r = await service.take('c1');
      expect(r).toMatchObject({
        status: ClaimStatus.IN_PROCESS,
        resolutionNote: null,
      });
    });

    it('take rechaza un reclamo que no está pendiente', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.IN_PROCESS,
      });
      await expect(service.take('c1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(claims.save).not.toHaveBeenCalled();
    });

    it('reopen vuelve a in_process un reclamo resuelto y guarda el motivo', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.RESOLVED,
      });
      const r = await service.reopen('c1', 'El cliente mandó más info');
      expect(r).toMatchObject({
        status: ClaimStatus.IN_PROCESS,
        resolutionNote: 'El cliente mandó más info',
      });
    });

    it('reopen rechaza un reclamo pendiente o en proceso', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.PENDING,
      });
      await expect(service.reopen('c1', 'motivo')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(claims.save).not.toHaveBeenCalled();
    });

    it('un admin no toma/reabre reclamos de otra distribuidora (404)', async () => {
      claims.findOne.mockResolvedValue(null);
      await expect(service.take('c1', 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.reopen('c1', 'motivo', 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
