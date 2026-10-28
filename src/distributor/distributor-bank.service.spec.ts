import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DistributorBankService } from './distributor-bank.service';
import { Distributor } from './entities/distributor.entity';

describe('DistributorBankService', () => {
  let service: DistributorBankService;
  let repo: { findOne: jest.Mock; save: jest.Mock };
  let distributor: Distributor;

  beforeEach(() => {
    distributor = {
      distributorId: 'd1',
      bankCbu: '0170099220000067797370',
      bankAlias: 'garrafas.splg',
      bankHolder: 'Demo S.A.',
    } as Distributor;
    repo = {
      findOne: jest.fn().mockResolvedValue(distributor),
      save: jest.fn((d: Distributor) => Promise.resolve(d)),
    };
    service = new DistributorBankService(
      repo as unknown as Repository<Distributor>,
    );
  });

  it('obtener lee sólo la distribuidora pedida', async () => {
    await expect(service.obtener('d1')).resolves.toEqual({
      cbu: '0170099220000067797370',
      alias: 'garrafas.splg',
      holder: 'Demo S.A.',
    });
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { distributorId: 'd1' },
    });
  });

  it('guardar reemplaza los tres datos', async () => {
    await expect(
      service.guardar('d1', {
        cbu: null,
        alias: 'otro.alias',
        holder: undefined,
      }),
    ).resolves.toEqual({ cbu: null, alias: 'otro.alias', holder: null });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        bankCbu: null,
        bankAlias: 'otro.alias',
        bankHolder: null,
      }),
    );
  });

  it('una distribuidora inexistente es 404 y no guarda', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.guardar('nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('un error de la base se traduce (CHECK violado: 400, no 500)', async () => {
    repo.save.mockRejectedValue({
      driverError: { code: '23514', constraint: 'CHK_distributor_cbu' },
      code: '23514',
      constraint: 'CHK_distributor_cbu',
    });
    await expect(service.guardar('d1', {})).rejects.toMatchObject({
      status: 400,
    });
  });
});
