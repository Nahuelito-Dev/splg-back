import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { DistributorService } from './distributor.service';
import { Distributor, DistributorStatus } from './entities/distributor.entity';

/**
 * La distribuidora es el tenant: el slug no se repite, una suspendida no
 * recibe pedidos, y los clientes viejos sin cabecera caen en la de por defecto.
 */
describe('DistributorService', () => {
  let service: DistributorService;
  let repo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      create: jest.fn((d: Partial<Distributor>) => d),
      save: jest.fn((d: Distributor) => Promise.resolve(d)),
    };
    service = new DistributorService(
      repo as unknown as Repository<Distributor>,
      { get: (_k: string, def: string) => def } as unknown as ConfigService,
    );
  });

  it('no se repite el slug', async () => {
    repo.findOne.mockResolvedValue({ slug: 'jeny-gas' });
    await expect(
      service.create({ name: 'Otra', slug: 'jeny-gas' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('una distribuidora suspendida no está disponible', async () => {
    repo.findOne.mockResolvedValue({
      name: 'X',
      status: DistributorStatus.SUSPENDED,
    });
    await expect(service.assertActive('d1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('la de por defecto sale del slug configurado', async () => {
    repo.findOne.mockResolvedValue({ slug: 'jeny-gas' });
    await service.getDefault();
    expect(repo.findOne).toHaveBeenCalledWith({ where: { slug: 'jeny-gas' } });
  });

  it('sin la de por defecto, cae en la activa más antigua', async () => {
    repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      slug: 'otra',
    });
    await expect(service.getDefault()).resolves.toMatchObject({
      slug: 'otra',
    });
  });
});
