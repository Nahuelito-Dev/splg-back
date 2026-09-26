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
  };
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
    expect(claims.findOne).toHaveBeenCalledWith({
      where: { claimId: 'c1', distributorId: 'd2' },
    });
  });

  it('resolver guarda la nota y el estado', async () => {
    claims.findOne.mockResolvedValue({ claimId: 'c1' });
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
});
