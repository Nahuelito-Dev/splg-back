import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CustomersService } from './customer.service';
import { Customer } from './entities/customer.entity';
import { CustomerStatusFilter } from './dto/query-customers.dto';

/**
 * Lo que protege el servicio de clientes es la propiedad del dato: un cliente
 * sólo ve y toca lo suyo; un administrador pasa sin requesterUserId.
 */
describe('CustomersService', () => {
  let service: CustomersService;
  let customers: {
    findOne: jest.Mock;
    save: jest.Mock;
    softRemove: jest.Mock;
    create: jest.Mock;
    preload: jest.Mock;
  };

  const cliente = (over: Partial<Customer> = {}): Customer =>
    ({
      customerId: 'c1',
      userId: 'u1',
      ...over,
    }) as Customer;

  beforeEach(() => {
    customers = {
      findOne: jest.fn(),
      save: jest.fn((c: Customer) => Promise.resolve(c)),
      softRemove: jest.fn(),
      create: jest.fn((c: Partial<Customer>) => c),
      preload: jest.fn(),
    };
    service = new CustomersService(
      customers as unknown as Repository<Customer>,
    );
  });

  it('un cliente inexistente es 404', async () => {
    customers.findOne.mockResolvedValue(null);
    await expect(service.findOne('c9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('un cliente no puede ver el perfil de otro', async () => {
    customers.findOne.mockResolvedValue(cliente());
    await expect(service.findOne('c1', 'otro')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('el dueño y el administrador sí lo ven', async () => {
    customers.findOne.mockResolvedValue(cliente());
    await expect(service.findOne('c1', 'u1')).resolves.toMatchObject({
      customerId: 'c1',
    });
    await expect(service.findOne('c1')).resolves.toMatchObject({
      customerId: 'c1',
    });
  });

  it('por usuario, el control de propiedad corre antes de consultar', async () => {
    await expect(service.findOneByUserId('u1', 'otro')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(customers.findOne).not.toHaveBeenCalled();
  });

  it('la posición de otro cliente no se puede mover', async () => {
    customers.findOne.mockResolvedValue(cliente());
    await expect(
      service.updateLocation('c1', '-27.1,-55.1', 'otro'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(customers.save).not.toHaveBeenCalled();
  });

  it('la baja es lógica y responde con un mensaje', async () => {
    customers.findOne.mockResolvedValue(cliente());
    await expect(service.remove('c1')).resolves.toEqual({
      message: 'Customer deleted successfully',
    });
    expect(customers.softRemove).toHaveBeenCalledWith({ customerId: 'c1' });
  });

  describe('findAll', () => {
    const armarQb = () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (
        customers as unknown as { createQueryBuilder: jest.Mock }
      ).createQueryBuilder = jest.fn().mockReturnValue(qb);
      return qb;
    };

    it('sin status no filtra por cuenta bloqueada', async () => {
      const qb = armarQb();
      await service.findAll({});
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it.each([
      [CustomerStatusFilter.ACTIVE, false],
      [CustomerStatusFilter.BLOCKED, true],
    ])('status=%s filtra user.blocked = %s', async (status, blocked) => {
      const qb = armarQb();
      await service.findAll({ status });
      expect(qb.andWhere).toHaveBeenCalledWith('user.blocked = :blocked', {
        blocked,
      });
    });

    it('combina status con el aislamiento por distribuidora', async () => {
      const qb = armarQb();
      await service.findAll({ status: CustomerStatusFilter.ACTIVE }, 'd1');
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('pertenencia.distributor_id = :distributorId'),
        { distributorId: 'd1' },
      );
      expect(qb.andWhere).toHaveBeenCalledTimes(2);
    });
  });
});
