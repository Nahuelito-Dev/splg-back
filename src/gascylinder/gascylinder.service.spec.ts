import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
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
  };
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

    it('acepta el slug o el uuid', async () => {
      await expect(service.resolveDistributor('jeny-gas')).resolves.toBe(
        'd-slug',
      );
      await expect(
        service.resolveDistributor('0c8b00a8-7d75-4793-9362-5855689be8c6'),
      ).resolves.toBe('d-uuid');
    });

    it('el listado sólo trae productos activos de esa distribuidora', async () => {
      await service.findAll({ limit: 10, offset: 0 }, 'jeny-gas');
      expect(productos.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, distributorId: 'd-slug' },
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

  it('el stock nunca queda negativo', async () => {
    productos.findOne.mockResolvedValue(producto(2));
    await expect(service.updateStock('g1', -3, 'd1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(productos.save).not.toHaveBeenCalled();
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
