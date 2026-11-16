import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CartService } from './cart.service';
import { Cart } from './entities/cart.entity';
import { CartItem } from './entities/cart-item.entity';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { OrderPricingService } from '../order/domain/order-pricing.service';
import { GasCylinderService } from '../gascylinder/gascylinder.service';

const garrafa = (parcial: Partial<GasCylinder> = {}): GasCylinder =>
  ({
    gasCylinderId: 'g1',
    type: '10kg',
    price: 1000,
    stock: 10,
    isActive: true,
    distributorId: 'd1',
    ...parcial,
  }) as GasCylinder;

describe('CartService', () => {
  let carts: { findOne: jest.Mock };
  let items: { find: jest.Mock };
  let cartTx: {
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    update: jest.Mock;
  };
  let itemTx: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    remove: jest.Mock;
    delete: jest.Mock;
    find: jest.Mock;
  };
  let insertar: { execute: jest.Mock };
  let catalogo: { findOne: jest.Mock };
  let service: CartService;

  const cart = { cartId: 'c1', userId: 'u1', distributorId: 'd1' } as Cart;

  beforeEach(() => {
    carts = { findOne: jest.fn() };
    items = { find: jest.fn().mockResolvedValue([]) };
    cartTx = {
      findOne: jest.fn().mockResolvedValue(cart),
      findOneOrFail: jest.fn().mockResolvedValue(cart),
      update: jest.fn(),
    };
    itemTx = {
      findOne: jest.fn(),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: object) => x),
      remove: jest.fn(),
      delete: jest.fn(),
      find: jest.fn(),
    };
    insertar = { execute: jest.fn() };
    const constructor = {
      insert: () => ({
        into: () => ({
          values: () => ({ orIgnore: () => insertar }),
        }),
      }),
    };
    const manager = {
      getRepository: (entidad: unknown) => (entidad === Cart ? cartTx : itemTx),
      createQueryBuilder: () => constructor,
    } as unknown as EntityManager;
    const dataSource = {
      transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    };
    catalogo = { findOne: jest.fn().mockResolvedValue(garrafa()) };
    service = new CartService(
      carts as unknown as Repository<Cart>,
      items as unknown as Repository<CartItem>,
      dataSource as unknown as DataSource,
      catalogo as unknown as GasCylinderService,
      new OrderPricingService(),
    );
  });

  describe('consultar (CU-125)', () => {
    it('aplica las promociones activas de cada producto, igual que la cotización', async () => {
      carts.findOne.mockResolvedValue(cart);
      items.find.mockResolvedValue([
        {
          cartItemId: 'i1',
          gasCylinderId: 'g1',
          quantity: 4,
          unitPrice: 14900,
          gasCylinder: garrafa({
            price: 14900,
            promotions: [
              { quantity: 2, discountPercentage: 5 },
              { quantity: 4, discountPercentage: 12 },
            ] as GasCylinder['promotions'],
          }),
        },
        {
          cartItemId: 'i2',
          gasCylinderId: 'g2',
          quantity: 1,
          unitPrice: 20000,
          gasCylinder: garrafa({ gasCylinderId: 'g2', price: 20000 }),
        },
      ]);

      const { vista } = await service.consultar('u1', 'd1');

      expect(vista.items[0]).toMatchObject({
        listUnitPrice: 14900,
        discountPercentage: 12,
        currentUnitPrice: 13112,
        subtotal: 52448,
      });
      expect(vista.items[1].discountPercentage).toBe(0);
      expect(vista.total).toBe(72448);
      expect(items.find).toHaveBeenCalledWith(
        expect.objectContaining({
          relations: { gasCylinder: { promotions: true } },
        }),
      );
    });

    it('sin carrito responde uno vacío, no un error', async () => {
      carts.findOne.mockResolvedValue(null);

      const { cart: c, vista } = await service.consultar('u1', 'd1');

      expect(c).toBeNull();
      expect(vista.items).toEqual([]);
      expect(vista.total).toBe(0);
    });

    it('calcula sobre el precio vigente e informa la diferencia', async () => {
      carts.findOne.mockResolvedValue(cart);
      items.find.mockResolvedValue([
        {
          cartItemId: 'i1',
          gasCylinderId: 'g1',
          quantity: 2,
          unitPrice: 1000,
          gasCylinder: garrafa({ price: 1100, stock: 1 }),
        },
      ]);

      const { vista } = await service.consultar('u1', 'd1');

      expect(vista.total).toBe(2200);
      expect(vista.items[0].priceDifference).toBe(100);
      expect(vista.items[0].hasEnoughStock).toBe(false);
    });

    it('un tipo dado de baja queda marcado como no disponible', async () => {
      carts.findOne.mockResolvedValue(cart);
      items.find.mockResolvedValue([
        {
          cartItemId: 'i1',
          gasCylinderId: 'g1',
          quantity: 1,
          unitPrice: 1000,
          gasCylinder: garrafa({ isActive: false }),
        },
      ]);

      const { vista } = await service.consultar('u1', 'd1');

      expect(vista.items[0].available).toBe(false);
      expect(vista.total).toBe(0);
    });
  });

  describe('agregarItem (CU-122)', () => {
    beforeEach(() => {
      carts.findOne.mockResolvedValue(cart);
    });

    it('un tipo nuevo crea el ítem con el precio vigente', async () => {
      itemTx.findOne.mockResolvedValue(null);

      await service.agregarItem('u1', 'd1', 'g1', 2);

      expect(itemTx.create).toHaveBeenCalledWith({
        cartId: 'c1',
        gasCylinderId: 'g1',
        quantity: 2,
        unitPrice: 1000,
      });
      expect(catalogo.findOne).toHaveBeenCalledWith('g1', 'd1');
    });

    it('un tipo que ya estaba suma la cantidad y actualiza el precio guardado', async () => {
      itemTx.findOne.mockResolvedValue({
        cartItemId: 'i1',
        quantity: 3,
        unitPrice: 800,
      });

      await service.agregarItem('u1', 'd1', 'g1', 2);

      expect(itemTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 5, unitPrice: 1000 }),
      );
    });

    it('no pasa del máximo por ítem', async () => {
      itemTx.findOne.mockResolvedValue({ quantity: 990, unitPrice: 1000 });

      await expect(service.agregarItem('u1', 'd1', 'g1', 10)).rejects.toThrow(
        BadRequestException,
      );
      expect(itemTx.save).not.toHaveBeenCalled();
    });

    it('un tipo dado de baja se rechaza como inexistente', async () => {
      catalogo.findOne.mockResolvedValue(garrafa({ isActive: false }));

      await expect(service.agregarItem('u1', 'd1', 'g1', 1)).rejects.toThrow(
        NotFoundException,
      );
      expect(itemTx.save).not.toHaveBeenCalled();
    });

    it('un tipo de otra distribuidora se rechaza con el 404 del catálogo', async () => {
      catalogo.findOne.mockRejectedValue(new NotFoundException('no existe'));

      await expect(service.agregarItem('u1', 'd1', 'g9', 1)).rejects.toThrow(
        NotFoundException,
      );
      expect(insertar.execute).not.toHaveBeenCalled();
    });
  });

  describe('cambiarCantidad (CU-123) y quitarItem (CU-124)', () => {
    beforeEach(() => {
      carts.findOne.mockResolvedValue(cart);
    });

    it('reemplaza la cantidad del ítem del cliente', async () => {
      const item = { cartItemId: 'i1', cartId: 'c1', quantity: 1 };
      itemTx.findOne.mockResolvedValue(item);

      await service.cambiarCantidad('u1', 'd1', 'i1', 4);

      expect(itemTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 4 }),
      );
      expect(itemTx.findOne).toHaveBeenCalledWith({
        where: { cartItemId: 'i1', cartId: 'c1' },
      });
    });

    it('modificar la cantidad de un tipo dado de baja es 400 y no guarda', async () => {
      itemTx.findOne.mockResolvedValue({
        cartItemId: 'i1',
        gasCylinderId: 'g1',
        quantity: 1,
      });
      catalogo.findOne.mockResolvedValue(garrafa({ isActive: false }));

      await expect(
        service.cambiarCantidad('u1', 'd1', 'i1', 4),
      ).rejects.toThrow(BadRequestException);
      expect(itemTx.save).not.toHaveBeenCalled();
    });

    it('un ítem que no es del carrito del cliente es 404', async () => {
      itemTx.findOne.mockResolvedValue(null);

      await expect(
        service.cambiarCantidad('u1', 'd1', 'ajeno', 4),
      ).rejects.toThrow(NotFoundException);
      await expect(service.quitarItem('u1', 'd1', 'ajeno')).rejects.toThrow(
        NotFoundException,
      );
      expect(itemTx.save).not.toHaveBeenCalled();
      expect(itemTx.remove).not.toHaveBeenCalled();
    });

    it('sin carrito, modificar o quitar es 404', async () => {
      cartTx.findOne.mockResolvedValue(null);

      await expect(service.quitarItem('u1', 'd1', 'i1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('quitar borra el ítem', async () => {
      const item = { cartItemId: 'i1', cartId: 'c1', quantity: 1 };
      itemTx.findOne.mockResolvedValue(item);

      await service.quitarItem('u1', 'd1', 'i1');

      expect(itemTx.remove).toHaveBeenCalledWith(item);
    });
  });

  describe('itemsParaPedido (checkout del carrito)', () => {
    const renglon = (tipo: string, activa = true) => ({
      gasCylinderId: `g-${tipo}`,
      quantity: 2,
      gasCylinder: garrafa({ type: tipo, isActive: activa }),
    });
    const manager = () =>
      ({
        getRepository: (e: unknown) => (e === Cart ? cartTx : itemTx),
      }) as unknown as EntityManager;

    it('devuelve los renglones y bloquea el carrito cuando se lo piden', async () => {
      itemTx.find = jest.fn().mockResolvedValue([renglon('10kg')]);

      const r = await service.itemsParaPedido(manager(), 'u1', 'd1', true);

      expect(r).toEqual([{ gasCylinderId: 'g-10kg', quantity: 2 }]);
      expect(cartTx.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('sin bloquear no pide candado', async () => {
      itemTx.find = jest.fn().mockResolvedValue([renglon('10kg')]);

      await service.itemsParaPedido(manager(), 'u1', 'd1', false);

      expect(
        (cartTx.findOne.mock.calls as unknown[][])[0][0] as object,
      ).not.toHaveProperty('lock');
    });

    it('carrito vacío o inexistente es 400', async () => {
      itemTx.find = jest.fn().mockResolvedValue([]);
      await expect(
        service.itemsParaPedido(manager(), 'u1', 'd1', true),
      ).rejects.toThrow('Tu carrito está vacío');

      cartTx.findOne.mockResolvedValue(null);
      await expect(
        service.itemsParaPedido(manager(), 'u1', 'd1', true),
      ).rejects.toThrow(BadRequestException);
    });

    it('con productos dados de baja es 400 y nombra cuáles', async () => {
      itemTx.find = jest
        .fn()
        .mockResolvedValue([renglon('10kg'), renglon('45kg', false)]);

      await expect(
        service.itemsParaPedido(manager(), 'u1', 'd1', true),
      ).rejects.toThrow(/45kg/);
    });
  });

  describe('vaciar (CU-126)', () => {
    it('borra todos los ítems del carrito', async () => {
      carts.findOne.mockResolvedValue(cart);

      await service.vaciar('u1', 'd1');

      expect(itemTx.delete).toHaveBeenCalledWith({ cartId: 'c1' });
    });

    it('sin carrito no hace nada', async () => {
      cartTx.findOne.mockResolvedValue(null);
      carts.findOne.mockResolvedValue(null);

      const { vista } = await service.vaciar('u1', 'd1');

      expect(itemTx.delete).not.toHaveBeenCalled();
      expect(vista.items).toEqual([]);
    });
  });
});
