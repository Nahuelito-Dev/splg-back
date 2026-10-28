import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { Insurer } from '../entities/insurer.entity';
import { InsurerService } from './insurer.service';

describe('InsurerService', () => {
  let service: InsurerService;
  let insurers: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    softRemove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let policies: { createQueryBuilder: jest.Mock };
  let installments: { createQueryBuilder: jest.Mock };
  let cuotasPendientes: number;
  let nombresIguales: number;
  let vivas: number;
  let wheres: Array<[string, unknown]>;

  const qb = (cuenta: () => number) => {
    const b: Record<string, jest.Mock> = {};
    for (const metodo of ['orderBy', 'addOrderBy', 'limit', 'offset']) {
      b[metodo] = jest.fn(() => b);
    }
    for (const metodo of ['where', 'andWhere']) {
      b[metodo] = jest.fn((condicion: string, parametros: unknown) => {
        wheres.push([condicion, parametros]);
        return b;
      });
    }
    b.getCount = jest.fn(() => Promise.resolve(cuenta()));
    b.getManyAndCount = jest.fn(() =>
      Promise.resolve([[{ insurerId: 'i1' }], 1]),
    );
    return b;
  };

  beforeEach(() => {
    nombresIguales = 0;
    vivas = 0;
    cuotasPendientes = 0;
    wheres = [];
    insurers = {
      findOne: jest
        .fn()
        .mockResolvedValue({ insurerId: 'i1', name: 'Rivadavia' }),
      create: jest.fn((x: object) => x),
      save: jest.fn((x: object) => Promise.resolve(x)),
      softRemove: jest.fn((x: object) => Promise.resolve(x)),
      createQueryBuilder: jest.fn(() => qb(() => nombresIguales)),
    };
    policies = { createQueryBuilder: jest.fn(() => qb(() => vivas)) };
    installments = {
      createQueryBuilder: jest.fn(() => ({
        ...qb(() => cuotasPendientes),
        innerJoin: jest.fn().mockReturnThis(),
      })),
    };
    service = new InsurerService(
      insurers as unknown as Repository<Insurer>,
      policies as unknown as Repository<InsurancePolicy>,
      installments as unknown as Repository<InsuranceInstallment>,
    );
  });

  it('crea la aseguradora en la distribuidora, con los opcionales en null', async () => {
    const r = await service.create({ name: 'Rivadavia' }, 'd1');
    expect(r).toMatchObject({
      distributorId: 'd1',
      name: 'Rivadavia',
      taxId: null,
      paymentUrl: null,
    });
  });

  it('el nombre repetido en la distribuidora es 409, sin distinguir mayúsculas', async () => {
    nombresIguales = 1;
    await expect(
      service.create({ name: 'RIVADAVIA' }, 'd1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(insurers.save).not.toHaveBeenCalled();
    expect(wheres).toContainEqual([
      'i.distributor_id = :distributorId',
      { distributorId: 'd1' },
    ]);
  });

  it('una aseguradora de otra distribuidora es 404', async () => {
    insurers.findOne.mockResolvedValue(null);
    await expect(service.findOne('i1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(insurers.findOne).toHaveBeenCalledWith({
      where: { insurerId: 'i1', distributorId: 'd2' },
    });
  });

  it('modifica sólo lo que viene y deja el resto', async () => {
    const r = await service.update(
      'i1',
      { paymentUrl: 'https://pagos.test' },
      'd1',
    );
    expect(r).toMatchObject({
      name: 'Rivadavia',
      paymentUrl: 'https://pagos.test',
    });
  });

  it('renombrar a un nombre ya usado es 409; dejar el mismo nombre no consulta', async () => {
    nombresIguales = 1;
    await expect(
      service.update('i1', { name: 'Otra' }, 'd1'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.update('i1', { name: 'Rivadavia' }, 'd1'),
    ).resolves.toBeDefined();
  });

  it('el borrado es lógico', async () => {
    await service.remove('i1', 'd1');
    expect(insurers.softRemove).toHaveBeenCalledWith(
      expect.objectContaining({ insurerId: 'i1' }),
    );
  });

  it('con pólizas vigentes o futuras no se da de baja (409)', async () => {
    vivas = 2;
    await expect(service.remove('i1', 'd1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(insurers.softRemove).not.toHaveBeenCalled();
  });

  it('con cuotas pendientes no se da de baja aunque la póliza haya vencido (409)', async () => {
    vivas = 0;
    cuotasPendientes = 3;
    await expect(service.remove('i1', 'd1')).rejects.toThrow(
      /3 cuota\(s\) pendiente/,
    );
    expect(insurers.softRemove).not.toHaveBeenCalled();
  });

  it('el listado se acota a la distribuidora y filtra por nombre', async () => {
    const r = await service.findAll('d1', {
      term: ' riva ',
      limit: 5,
      offset: 0,
    });
    expect(r).toEqual({ data: [{ insurerId: 'i1' }], total: 1 });
    expect(wheres).toContainEqual(['i.name ILIKE :term', { term: '%riva%' }]);
    expect(wheres).toContainEqual([
      'i.distributor_id = :distributorId',
      { distributorId: 'd1' },
    ]);
  });
});
