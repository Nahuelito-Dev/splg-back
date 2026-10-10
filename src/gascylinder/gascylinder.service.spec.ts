import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ILike, Repository } from 'typeorm';
import { GasCylinderService } from './gascylinder.service';
import { GasCylinder } from './entities/gascylinder.entity';
import { DistributorService } from '../distributor/distributor.service';

describe('GasCylinderService', () => {
  let service: GasCylinderService;
  let productos: {
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let bloqueado: {
    getOne: jest.Mock;
    setLock: jest.Mock;
    andWhere: jest.Mock;
  };
  let txManager: { createQueryBuilder: jest.Mock; save: jest.Mock };
  let distribuidoras: {
    getDefault: jest.Mock;
    findBySlug: jest.Mock;
    assertActive: jest.Mock;
  };

  const producto = (stock: number) =>
    ({
      gasCylinderId: 'g1',
      distributorId: 'd1',
      type: '10kg',
      stock,
      isActive: true,
    }) as GasCylinder;

  beforeEach(() => {
    productos = {
      findOne: jest.fn(),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      create: jest.fn((d: Partial<GasCylinder>) => d),
      save: jest.fn((g: GasCylinder) => Promise.resolve(g)),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) => fn(txManager)),
      },
    };
    bloqueado = {
      getOne: jest.fn(),
      setLock: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
    };
    txManager = {
      createQueryBuilder: jest.fn(() => ({
        setLock: bloqueado.setLock,
        where: jest.fn().mockReturnThis(),
        andWhere: bloqueado.andWhere,
        getOne: bloqueado.getOne,
      })),
      save: jest.fn((g: GasCylinder) => Promise.resolve(g)),
    };
    distribuidoras = {
      getDefault: jest.fn().mockResolvedValue({ distributorId: 'd-default' }),
      findBySlug: jest.fn().mockResolvedValue({ distributorId: 'd-slug' }),
      assertActive: jest.fn().mockResolvedValue({ distributorId: 'd-uuid' }),
    };
    service = new GasCylinderService(
      productos as unknown as Repository<GasCylinder>,
      distribuidoras as unknown as DistributorService,
    );
  });

  describe('la distribuidora del catálogo público', () => {
    it('sin distribuidora usa la por defecto, no mezcla catálogos', async () => {
      await expect(service.resolveDistributor()).resolves.toBe('d-default');
    });

    it('una distribuidora suspendida es 404 con mensaje (no 500), también para el admin de esa distribuidora', async () => {
      distribuidoras.assertActive.mockRejectedValue(
        new NotFoundException("La distribuidora 'X' no está disponible"),
      );
      await expect(
        service.resolveDistributor('0c8b00a8-7d75-4793-9362-5855689be8c6'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('acepta el slug o el uuid', async () => {
      await expect(service.resolveDistributor('demo')).resolves.toBe('d-slug');
      await expect(
        service.resolveDistributor('0c8b00a8-7d75-4793-9362-5855689be8c6'),
      ).resolves.toBe('d-uuid');
    });

    it('el listado sólo trae productos activos de esa distribuidora', async () => {
      await service.findAll({ limit: 10, offset: 0 }, 'demo');
      expect(productos.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, distributorId: 'd-slug' },
        }),
      );
    });

    it('term busca por tipo o descripción sin salir de la distribuidora', async () => {
      await service.findAll({ limit: 10, offset: 0, term: ' 45 ' }, 'demo');
      expect(productos.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: [
            { isActive: true, distributorId: 'd-slug', type: ILike('%45%') },
            {
              isActive: true,
              distributorId: 'd-slug',
              description: ILike('%45%'),
            },
          ],
        }),
      );
    });
  });

  it('el tipo es único por distribuidora', async () => {
    productos.findOne.mockResolvedValue(producto(5));
    await expect(
      service.create({ type: '10kg', weight: 10, price: 100 }, 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(productos.save).not.toHaveBeenCalled();
  });

  describe('updateStock', () => {
    it('el stock nunca queda negativo', async () => {
      bloqueado.getOne.mockResolvedValue(producto(2));
      await expect(service.updateStock('g1', -3, 'd1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it('lee y suma con lock pesimista (FOR UPDATE), en una transacción', async () => {
      bloqueado.getOne.mockResolvedValue(producto(2));
      productos.findOne.mockResolvedValue(producto(7));

      const r = await service.updateStock('g1', 5, 'd1');

      expect(bloqueado.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(productos.manager.transaction).toHaveBeenCalled();
      expect(txManager.save).toHaveBeenCalledWith(
        expect.objectContaining({ stock: 7 }),
      );
      expect(r.stock).toBe(7);
    });

    it('un producto de otra distribuidora es 404', async () => {
      bloqueado.getOne.mockResolvedValue(null);
      await expect(service.updateStock('g1', 1, 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // El producto se lee con lock Y acotado a la distribuidora.
      expect(bloqueado.andWhere).toHaveBeenCalledWith(
        'gc.distributorId = :distributorId',
        { distributorId: 'd2' },
      );
    });
  });

  it('un producto de otra distribuidora no existe para quien lo edita', async () => {
    productos.findOne.mockResolvedValue(null);
    await expect(
      service.update('g1', { price: 1 }, 'd2'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(productos.findOne).toHaveBeenCalledWith({
      where: { gasCylinderId: 'g1', distributorId: 'd2' },
      relations: ['promotions'],
    });
  });

  it('dos promociones para la misma cantidad son 400', async () => {
    productos.findOne.mockResolvedValue(null);
    await expect(
      service.create(
        {
          type: '15kg',
          weight: 15,
          price: 100,
          promotions: [
            { quantity: 3, discountPercentage: 5 },
            { quantity: 3, discountPercentage: 10 },
          ],
        },
        'd1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(productos.save).not.toHaveBeenCalled();
  });

  it('la baja desactiva el producto, no lo borra', async () => {
    const g = producto(5);
    productos.findOne.mockResolvedValue(g);
    await service.remove('g1', 'd1');
    expect(productos.save).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false }),
    );
  });
});
