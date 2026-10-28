import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Brackets, EntityManager, Repository } from 'typeorm';
import { CustomersService } from './customer.service';
import { Customer } from './entities/customer.entity';
import { CustomerDistributor } from './entities/customer-distributor.entity';
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
        addOrderBy: jest.fn().mockReturnThis(),
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

    it('desempata por el id para que la paginación no repita ni pierda filas', async () => {
      const qb = armarQb();
      await service.findAll({});
      expect(qb.orderBy).toHaveBeenCalledWith('customer.createdAt', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('customer.customerId', 'ASC');
    });

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

  describe('consumo declarado', () => {
    const consumo = {
      declaredCylinderTypeId: 'g10',
      avgMonthlyConsumptionKg: 20,
      nextRepurchaseEstimateAt: new Date('2026-10-16T00:00:00.000Z'),
    };

    it('guardarConsumo persiste los tres campos sin arrastrar la garrafa vieja', async () => {
      customers.findOne.mockResolvedValue(cliente());

      await service.guardarConsumo('u1', consumo);

      expect(customers.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
      expect(customers.save).toHaveBeenCalledWith(
        expect.objectContaining(consumo),
      );
    });

    it('guardarConsumo de un usuario sin ficha es 404', async () => {
      customers.findOne.mockResolvedValue(null);

      await expect(
        service.guardarConsumo('u9', consumo),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(customers.save).not.toHaveBeenCalled();
    });

    it('el perfil nuevo nace con el consumo declarado en el registro', async () => {
      const manager = {
        getRepository: () => customers,
      } as unknown as EntityManager;

      await service.crearPerfil(manager, 'u1', { consumo });

      expect(customers.create).toHaveBeenCalledWith(
        expect.objectContaining(consumo),
      );
    });
  });
  describe('pertenencia a una distribuidora', () => {
    it('vincula al cliente con quien lo dio de alta; el duplicado reactiva sin repetir', async () => {
      const execute = jest.fn();
      const orUpdate = jest.fn().mockReturnValue({ execute });
      const values = jest.fn().mockReturnValue({ orUpdate });
      const into = jest.fn().mockReturnValue({ values });
      const manager = {
        createQueryBuilder: () => ({ insert: () => ({ into }) }),
      } as unknown as EntityManager;

      await service.vincularConDistribuidora(manager, 'u1', 'd1', 'admin-1');

      expect(into).toHaveBeenCalledWith(CustomerDistributor);
      expect(values).toHaveBeenCalledWith({
        userId: 'u1',
        distributorId: 'd1',
        createdByUserId: 'admin-1',
      });
      expect(orUpdate).toHaveBeenCalledWith(
        ['removed_at', 'removed_by_user_id'],
        ['user_id', 'distributor_id'],
      );
      expect(execute).toHaveBeenCalled();
    });

    it('reactivarVinculo sólo toca vínculos dados de baja', async () => {
      const execute = jest.fn();
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute,
      };
      const manager = {
        createQueryBuilder: () => qb,
      } as unknown as EntityManager;

      await service.reactivarVinculo(manager, 'u1', 'd1');

      expect(qb.set).toHaveBeenCalledWith({
        removedAt: null,
        removedByUserId: null,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('removed_at IS NOT NULL');
      expect(execute).toHaveBeenCalled();
    });

    it('un cliente que no es de la distribuidora es 404; uno que sí, pasa', async () => {
      const getExists = jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getExists,
      };
      (
        customers as unknown as { createQueryBuilder: jest.Mock }
      ).createQueryBuilder = jest.fn().mockReturnValue(qb);

      await expect(
        service.assertDeLaDistribuidora({ customer_id: 'c1' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.assertDeLaDistribuidora({ user_id: 'u1' }, 'd1'),
      ).resolves.toBeUndefined();
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('customer_distributor'),
        { distributorId: 'd1' },
      );
    });
  });

  describe('baja del cliente en la distribuidora', () => {
    let query: jest.Mock;
    let execute: jest.Mock;
    let values: jest.Mock;

    beforeEach(() => {
      query = jest.fn();
      execute = jest.fn();
      values = jest.fn().mockReturnValue({
        orUpdate: jest.fn().mockReturnValue({ execute }),
      });
      const manager = {
        query,
        createQueryBuilder: () => ({
          insert: () => ({ into: () => ({ values }) }),
        }),
      };
      Object.assign(customers, {
        manager: {
          transaction: (fn: (m: unknown) => Promise<void>) => fn(manager),
        },
        createQueryBuilder: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getExists: jest.fn().mockResolvedValue(true),
        }),
      });
      customers.findOne.mockResolvedValue(cliente());
    });

    it('sin pedidos en curso registra la baja con quien la hizo', async () => {
      query
        .mockResolvedValueOnce([{ deleted: false }])
        .mockResolvedValueOnce([]);

      await service.darDeBajaEnDistribuidora('c1', 'd1', 'admin-1');

      const fila = (values.mock.calls[0] as [Record<string, unknown>])[0];
      expect(fila).toMatchObject({
        userId: 'u1',
        distributorId: 'd1',
        removedByUserId: 'admin-1',
      });
      expect(execute).toHaveBeenCalled();
    });

    it('con pedidos en curso es 409 y no registra nada', async () => {
      query
        .mockResolvedValueOnce([{ deleted: false }])
        .mockResolvedValueOnce([{ '?column?': 1 }]);

      await expect(
        service.darDeBajaEnDistribuidora('c1', 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(execute).not.toHaveBeenCalled();
      const params = (query.mock.calls[1] as [string, unknown[]])[1];
      expect(params[2]).toEqual([
        'reserved',
        'pending',
        'accepted',
        'on_the_way',
      ]);
    });

    it('si el cliente no es de la distribuidora es 404', async () => {
      (
        customers as unknown as { createQueryBuilder: jest.Mock }
      ).createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getExists: jest.fn().mockResolvedValue(false),
      });

      await expect(
        service.darDeBajaEnDistribuidora('c1', 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(execute).not.toHaveBeenCalled();
    });

    it('reactivar sin un vínculo dado de baja en esa distribuidora es 404', async () => {
      const execute = jest.fn().mockResolvedValue({ affected: 0 });
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute,
      };
      Object.assign(customers, {
        manager: { createQueryBuilder: () => qb },
      });
      await expect(
        service.reactivarEnDistribuidora('c1', 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      execute.mockResolvedValue({ affected: 1 });
      await service.reactivarEnDistribuidora('c1', 'd1');
      expect(qb.set).toHaveBeenCalledWith({
        removedAt: null,
        removedByUserId: null,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('removed_at IS NOT NULL');
    });

    it('el listado de removidos filtra por la distribuidora y busca sin correo', async () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (
        customers as unknown as { createQueryBuilder: jest.Mock }
      ).createQueryBuilder = jest.fn().mockReturnValue(qb);

      await service.findRemoved({ term: 'ana' }, 'd1');

      // Orden estable: la fecha y, con la misma fecha, el id.
      expect(qb.addOrderBy).toHaveBeenCalledWith('customer.customerId', 'ASC');

      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining('removed_at IS NOT NULL'),
        { distributorId: 'd1' },
      );
      const condiciones: string[] = [];
      const fake = {
        where: (c: string) => {
          condiciones.push(c);
          return fake;
        },
        orWhere: (c: string) => {
          condiciones.push(c);
          return fake;
        },
      };
      const brackets = (qb.andWhere.mock.calls[0] as [Brackets])[0];
      brackets.whereFactory(fake as never);
      expect(condiciones.join(' ')).toContain('fullName');
      expect(condiciones.join(' ')).toContain('phoneNumber');
      expect(condiciones.join(' ')).not.toContain('email');
    });
  });
});
