import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ILike, Repository } from 'typeorm';
import { GasCylinderService } from './gascylinder.service';
import { GasCylinder } from './entities/gascylinder.entity';
import { DistributorService } from '../distributor/distributor.service';
import { PaymentSurchargeSettingsService } from '../distributor/payment-surcharge-settings.service';
import { GasCylinderPromotion } from './entities/gascylinder-promotion.entity';

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
  let txManager: {
    createQueryBuilder: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    softRemove: jest.Mock;
  };
  let eventos: { emitAsync: jest.Mock };
  let recargos: { obtener: jest.Mock };
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
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_e: unknown, d: object) => d),
      softRemove: jest.fn().mockResolvedValue([]),
    };
    eventos = { emitAsync: jest.fn().mockResolvedValue([]) };
    recargos = {
      obtener: jest.fn().mockResolvedValue({
        transferPercentage: 10,
        mercadoPagoPercentage: 10,
        cashPercentage: 0,
      }),
    };
    distribuidoras = {
      getDefault: jest.fn().mockResolvedValue({ distributorId: 'd-default' }),
      findBySlug: jest.fn().mockResolvedValue({ distributorId: 'd-slug' }),
      assertActive: jest.fn().mockResolvedValue({ distributorId: 'd-uuid' }),
    };
    service = new GasCylinderService(
      productos as unknown as Repository<GasCylinder>,
      distribuidoras as unknown as DistributorService,
      eventos as unknown as EventEmitter2,
      recargos as unknown as PaymentSurchargeSettingsService,
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

  describe('stock vendible inicial y edición', () => {
    it('un producto nuevo con stock publica el evento para que el stock lo registre como físico', async () => {
      productos.findOne.mockResolvedValue(null);
      txManager.save.mockImplementation((g: GasCylinder) =>
        Promise.resolve({ ...g, gasCylinderId: 'nuevo' }),
      );
      await service.create(
        { type: '5kg', weight: 5, price: 100, stock: 12 },
        'd1',
      );
      // Con el manager de la transacción del alta: el físico se escribe ahí.
      expect(eventos.emitAsync).toHaveBeenCalledWith(
        'garrafa.creada',
        expect.objectContaining({
          gasCylinderId: 'nuevo',
          distributorId: 'd1',
          stock: 12,
          manager: txManager,
        }),
      );
    });

    it('si el listener falla, el alta falla (misma transacción)', async () => {
      productos.findOne.mockResolvedValue(null);
      txManager.save.mockImplementation((g: GasCylinder) =>
        Promise.resolve({ ...g, gasCylinderId: 'nuevo' }),
      );
      eventos.emitAsync.mockRejectedValue(new Error('sin depósito'));
      await expect(
        service.create({ type: '5kg', weight: 5, price: 100, stock: 3 }, 'd1'),
      ).rejects.toThrow();
    });

    it('sin stock inicial no publica nada', async () => {
      productos.findOne.mockResolvedValue(null);
      await service.create({ type: '5kg', weight: 5, price: 100 }, 'd1');
      expect(eventos.emitAsync).not.toHaveBeenCalled();
    });

    it('la edición con stock es 400 y no guarda nada: el stock cambia sólo con un ajuste', async () => {
      productos.findOne.mockResolvedValue(producto(5));
      const preload = jest.fn().mockResolvedValue(producto(5));
      (productos as unknown as { preload: jest.Mock }).preload = preload;
      await expect(
        service.update('g1', { price: 200, stock: 999 }, 'd1'),
      ).rejects.toThrow(/ajuste de stock/);
      expect(preload).not.toHaveBeenCalled();
    });

    it('el ABM nunca escribe stock ni déficit: una reserva confirmada en el medio no se pisa con el valor viejo', async () => {
      const leido = {
        ...producto(10),
        reservationDeficit: 3,
      } as GasCylinder;
      productos.findOne.mockResolvedValue(leido);
      (productos as unknown as { preload: jest.Mock }).preload = jest
        .fn()
        .mockResolvedValue({ ...leido, description: 'nueva' });
      await service.update('g1', { description: 'nueva' }, 'd1');
      const [guardado] = productos.save.mock.calls[0] as [Partial<GasCylinder>];
      expect(guardado.description).toBe('nueva');
      expect(guardado.stock).toBeUndefined();
      expect(guardado.reservationDeficit).toBeUndefined();
    });

    it('la baja lógica tampoco escribe stock ni déficit', async () => {
      productos.findOne.mockResolvedValue({
        ...producto(10),
        reservationDeficit: 3,
      });
      await service.remove('g1', 'd1');
      const [guardado] = productos.save.mock.calls[0] as [Partial<GasCylinder>];
      expect(guardado.isActive).toBe(false);
      expect(guardado.stock).toBeUndefined();
      expect(guardado.reservationDeficit).toBeUndefined();
    });

    it('la edición sin stock sigue funcionando', async () => {
      productos.findOne.mockResolvedValue(producto(5));
      const preload = jest.fn().mockResolvedValue(producto(5));
      (productos as unknown as { preload: jest.Mock }).preload = preload;
      await service.update('g1', { price: 200 }, 'd1');
      expect(preload).toHaveBeenCalledWith({ gasCylinderId: 'g1', price: 200 });
    });
  });

  describe('promociones al editar un producto', () => {
    const vigente = (quantity: number, discountPercentage: number) =>
      ({
        promotionId: `p${quantity}`,
        gasCylinderId: 'g1',
        quantity,
        discountPercentage,
      }) as GasCylinderPromotion;

    beforeEach(() => {
      productos.findOne.mockResolvedValue(producto(5));
      (productos as unknown as { preload: jest.Mock }).preload = jest
        .fn()
        .mockResolvedValue(producto(5));
      bloqueado.getOne.mockResolvedValue(producto(5));
    });

    it('reenviar la misma lista no inserta duplicados ni da de baja nada', async () => {
      txManager.find.mockResolvedValue([vigente(2, 5), vigente(4, 12)]);

      await service.update(
        'g1',
        {
          price: 300,
          promotions: [
            { quantity: 2, discountPercentage: 5 },
            { quantity: 4, discountPercentage: 12 },
          ],
        },
        'd1',
      );

      expect(txManager.softRemove).not.toHaveBeenCalled();
      // sólo se guarda el producto: ninguna promoción
      expect(txManager.save).toHaveBeenCalledTimes(1);
    });

    it('la promoción que ya existe para esa cantidad cambia su descuento en vez de duplicarse', async () => {
      const existente = vigente(3, 8);
      txManager.find.mockResolvedValue([existente]);

      await service.update(
        'g1',
        { promotions: [{ quantity: 3, discountPercentage: 9 }] },
        'd1',
      );

      expect(existente.discountPercentage).toBe(9);
      expect(txManager.save).toHaveBeenCalledWith(existente);
      expect(txManager.create).not.toHaveBeenCalled();
    });

    it('agrega las nuevas y da de baja (lógica) las que no vinieron, las bajas antes que las altas', async () => {
      const sobra = vigente(4, 12);
      txManager.find.mockResolvedValue([vigente(2, 5), sobra]);
      const orden: string[] = [];
      txManager.softRemove.mockImplementation(() => {
        orden.push('baja');
        return Promise.resolve([]);
      });
      txManager.save.mockImplementation((g: object) => {
        if (!('gasCylinderId' in g) || 'quantity' in g) orden.push('alta');
        return Promise.resolve(g);
      });

      await service.update(
        'g1',
        {
          promotions: [
            { quantity: 2, discountPercentage: 5 },
            { quantity: 6, discountPercentage: 20 },
          ],
        },
        'd1',
      );

      expect(txManager.softRemove).toHaveBeenCalledWith(GasCylinderPromotion, [
        sobra,
      ]);
      expect(txManager.create).toHaveBeenCalledWith(GasCylinderPromotion, {
        gasCylinderId: 'g1',
        quantity: 6,
        discountPercentage: 20,
      });
      expect(orden).toEqual(['baja', 'alta']);
    });

    it('una lista vacía da de baja todas las promociones', async () => {
      const a = vigente(2, 5);
      txManager.find.mockResolvedValue([a]);
      await service.update('g1', { promotions: [] }, 'd1');
      expect(txManager.softRemove).toHaveBeenCalledWith(GasCylinderPromotion, [
        a,
      ]);
    });

    it('promotions: null es 400 (no 500) y no escribe nada', async () => {
      await expect(
        service.update('g1', { promotions: null as never }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(productos.save).not.toHaveBeenCalled();
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it('sin promotions en el cuerpo no toca las promociones', async () => {
      await service.update('g1', { price: 10 }, 'd1');
      expect(txManager.find).not.toHaveBeenCalled();
      expect(productos.save).toHaveBeenCalled();
    });
  });

  describe('medios de pago públicos', () => {
    it('una distribuidora activa informa su recargo', async () => {
      distribuidoras.findBySlug.mockResolvedValue({
        distributorId: 'd-slug',
        status: 'active',
      });
      const medios = await service.mediosDePagoPublicos('demo');
      expect(recargos.obtener).toHaveBeenCalledWith('d-slug');
      expect(medios.map((m) => m.key)).toEqual([
        'CASH',
        'TRANSFER',
        'MERCADOPAGO',
      ]);
    });

    it('una distribuidora que no está activa es 404', async () => {
      distribuidoras.findBySlug.mockResolvedValue({
        distributorId: 'd-slug',
        status: 'suspended',
      });
      await expect(service.mediosDePagoPublicos('demo')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('medios de pago del catálogo', () => {
    it('informan el recargo vigente de la distribuidora, no un valor fijo', async () => {
      recargos.obtener.mockResolvedValue({
        transferPercentage: 7.5,
        mercadoPagoPercentage: 12,
        cashPercentage: 2,
      });
      (productos as unknown as { find: jest.Mock }).find = jest
        .fn()
        .mockResolvedValue([]);

      const { paymentMethods } = await service.getAvailableCylinders('demo');

      expect(recargos.obtener).toHaveBeenCalledWith('d-slug');
      expect(paymentMethods).toEqual([
        { name: 'Efectivo', key: 'CASH', surcharge: 2 },
        { name: 'Transferencia', key: 'TRANSFER', surcharge: 7.5 },
        { name: 'Mercado Pago', key: 'MERCADOPAGO', surcharge: 12 },
      ]);
    });
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

  describe('leerParaCotizar', () => {
    it('devuelve el producto con sus promociones, sin lock ni escritura', async () => {
      productos.findOne.mockResolvedValue(producto(10));
      const r = await service.leerParaCotizar('g1');
      expect(r.gasCylinderId).toBe('g1');
      expect(productos.findOne).toHaveBeenCalledWith({
        where: { gasCylinderId: 'g1' },
        relations: ['promotions'],
      });
      expect(txManager.createQueryBuilder).not.toHaveBeenCalled();
      expect(productos.save).not.toHaveBeenCalled();
    });

    it('un producto inexistente es 404', async () => {
      productos.findOne.mockResolvedValue(null);
      await expect(service.leerParaCotizar('g1')).rejects.toThrow('g1');
    });

    it('no controla el stock (lo hace quien cotiza, después de validar la distribuidora) ni lo descuenta', async () => {
      const p = producto(2);
      productos.findOne.mockResolvedValue(p);
      await expect(service.leerParaCotizar('g1')).resolves.toBe(p);
      expect(p.stock).toBe(2);
    });
  });

  describe('productos dados de baja y su reactivación (CU-268, CU-269)', () => {
    it('lista sólo los inactivos de la distribuidora, también al buscar por texto', async () => {
      await service.findInactive({ limit: 5, offset: 10 }, 'd1');
      expect(productos.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: false, distributorId: 'd1' },
          take: 5,
          skip: 10,
        }),
      );

      await service.findInactive({ term: ' 10kg ' }, 'd1');
      const [{ where }] = productos.findAndCount.mock.calls[1] as [
        { where: Array<Record<string, unknown>> },
      ];
      expect(where).toHaveLength(2);
      for (const condicion of where) {
        expect(condicion).toMatchObject({
          isActive: false,
          distributorId: 'd1',
        });
      }
      expect(where[0].type).toEqual(ILike('%10kg%'));
    });

    it('reactivar guarda sólo isActive (por save, para que quede en la auditoría) sin tocar stock', async () => {
      productos.findOne
        .mockResolvedValueOnce({
          ...producto(7),
          isActive: false,
          reservationDeficit: 2,
        })
        .mockResolvedValueOnce(producto(7));

      const reactivado = await service.reactivate('g1', 'd1');

      const [guardado] = productos.save.mock.calls[0] as [Partial<GasCylinder>];
      expect(guardado.isActive).toBe(true);
      expect(guardado.stock).toBeUndefined();
      expect(guardado.reservationDeficit).toBeUndefined();
      expect(reactivado.stock).toBe(7);
    });

    it('reactivar uno ya activo responde igual y no escribe', async () => {
      productos.findOne.mockResolvedValue(producto(3));
      const r = await service.reactivate('g1', 'd1');
      expect(r.isActive).toBe(true);
      expect(productos.save).not.toHaveBeenCalled();
    });

    it('un producto inexistente o de otra distribuidora es 404 y no escribe', async () => {
      productos.findOne.mockResolvedValue(null);
      await expect(service.reactivate('g1', 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(productos.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { gasCylinderId: 'g1', distributorId: 'd2' },
        }),
      );
      expect(productos.save).not.toHaveBeenCalled();
    });
  });

  describe('para la importación masiva (dentro de la transacción de quien llama)', () => {
    const repoDelManager = () => ({
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((d: Partial<GasCylinder>) => d),
    });

    it('crearEn aplica la unicidad del tipo con el repositorio del manager', async () => {
      const repo = repoDelManager();
      repo.findOne.mockResolvedValue(producto(1));
      const manager = { getRepository: jest.fn(() => repo), save: jest.fn() };

      await expect(
        service.crearEn(
          manager as never,
          { type: '10kg', weight: 10, price: 100 },
          'd1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
      expect(productos.manager.transaction).not.toHaveBeenCalled();
    });

    it('crearEn guarda con el manager y publica el stock inicial en esa transacción', async () => {
      const repo = repoDelManager();
      const manager = {
        getRepository: jest.fn(() => repo),
        save: jest.fn((g: GasCylinder) =>
          Promise.resolve({ ...g, gasCylinderId: 'nuevo' }),
        ),
      };

      await service.crearEn(
        manager as never,
        { type: '5kg', weight: 5, price: 100, stock: 4 },
        'd1',
      );

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ type: '5kg', distributorId: 'd1' }),
      );
      expect(eventos.emitAsync).toHaveBeenCalledWith(
        'garrafa.creada',
        expect.objectContaining({ gasCylinderId: 'nuevo', stock: 4, manager }),
      );
      expect(productos.manager.transaction).not.toHaveBeenCalled();
    });

    it('cambiarPrecioEn guarda el precio nuevo sin escribir el vendible', async () => {
      const bloqueada = { ...producto(7), price: 100 } as GasCylinder;
      bloqueado.getOne.mockResolvedValue(bloqueada);

      const cambio = await service.cambiarPrecioEn(
        txManager as never,
        'g1',
        150,
        'd1',
      );

      expect(cambio).toBe(true);
      const [guardado] = txManager.save.mock.calls[0] as [Partial<GasCylinder>];
      expect(guardado.price).toBe(150);
      expect(guardado.stock).toBeUndefined();
      expect(guardado.reservationDeficit).toBeUndefined();
    });

    it('cambiarPrecioEn: una garrafa dada de baja después de la vista previa es 409', async () => {
      bloqueado.getOne.mockResolvedValue({
        ...producto(7),
        price: 100,
        isActive: false,
      });
      await expect(
        service.cambiarPrecioEn(txManager as never, 'g1', 150, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it('cambiarPrecioEn con el mismo precio no escribe', async () => {
      bloqueado.getOne.mockResolvedValue({ ...producto(7), price: 100 });
      await expect(
        service.cambiarPrecioEn(txManager as never, 'g1', 100, 'd1'),
      ).resolves.toBe(false);
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it('cambiarPrecioEn: un producto inexistente o de otra distribuidora es 404', async () => {
      bloqueado.getOne.mockResolvedValue(null);
      await expect(
        service.cambiarPrecioEn(txManager as never, 'g1', 100, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      bloqueado.getOne.mockResolvedValue({
        ...producto(1),
        distributorId: 'otra',
      });
      await expect(
        service.cambiarPrecioEn(txManager as never, 'g1', 100, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it('tiposDelCatalogo trae todo el catálogo de la distribuidora, también lo desactivado', async () => {
      (productos as unknown as { find: jest.Mock }).find = jest
        .fn()
        .mockResolvedValue([producto(1)]);
      await service.tiposDelCatalogo('d1');
      expect(
        (productos as unknown as { find: jest.Mock }).find,
      ).toHaveBeenCalledWith({
        where: { distributorId: 'd1' },
        order: { type: 'ASC' },
      });
    });
  });
});
