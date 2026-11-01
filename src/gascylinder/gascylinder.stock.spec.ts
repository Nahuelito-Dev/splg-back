import { EntityManager, Repository } from 'typeorm';
import { GasCylinderService } from './gascylinder.service';
import { GasCylinder } from './entities/gascylinder.entity';
import { GasCylinderNotFoundError } from './domain/errors/gas-cylinder-not-found.error';
import { InsufficientStockError } from './domain/errors/insufficient-stock.error';
import { VendibleInsuficienteError } from './domain/errors/vendible-insuficiente.error';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DistributorService } from '../distributor/distributor.service';

/**
 * La reserva y la devolución de stock corren sobre el EntityManager de la
 * transacción del pedido (no abren la suya). Se simula ese manager: el query
 * builder devuelve el producto bloqueado y `save` registra las escrituras.
 */
describe('GasCylinderService — stock en la transacción del pedido', () => {
  let service: GasCylinderService;
  let save: jest.Mock;
  let find: jest.Mock;
  let lecturas: (GasCylinder | null)[];
  let qb: { setLock: jest.Mock; where: jest.Mock; getOne: jest.Mock };
  let manager: EntityManager;

  const producto = (id: string, stock: number): GasCylinder =>
    ({
      gasCylinderId: id,
      type: `Garrafa ${id}`,
      stock,
      reservationDeficit: 0,
      isActive: true,
    }) as GasCylinder;

  beforeEach(() => {
    lecturas = [];
    qb = {
      setLock: jest.fn(() => qb),
      where: jest.fn(() => qb),
      getOne: jest.fn(() => Promise.resolve(lecturas.shift() ?? null)),
    };
    save = jest.fn((e: GasCylinder) => Promise.resolve(e));
    find = jest.fn().mockResolvedValue([]);
    manager = {
      save,
      find,
      createQueryBuilder: jest.fn(() => qb),
    } as unknown as EntityManager;
    service = new GasCylinderService(
      {} as Repository<GasCylinder>,
      {} as DistributorService,
      { emitAsync: jest.fn() } as unknown as EventEmitter2,
      {} as never,
    );
  });

  describe('reservarStock', () => {
    it('toma lock pesimista y descuenta', async () => {
      const g = producto('a', 10);
      lecturas.push(g);
      const r = await service.reservarStock(manager, 'a', 3);
      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(r.stock).toBe(7);
      expect(save).toHaveBeenCalledWith(g);
    });

    it('devuelve el producto con sus promociones, leídas después del lock', async () => {
      lecturas.push(producto('a', 10));
      const promo = { quantity: 3, discountPercentage: 10 };
      find.mockResolvedValue([promo]);
      const r = await service.reservarStock(manager, 'a', 1);
      expect(r.promotions).toEqual([promo]);
    });

    it('permite reservar exactamente todo el stock', async () => {
      lecturas.push(producto('a', 3));
      await expect(service.reservarStock(manager, 'a', 3)).resolves.toEqual(
        expect.objectContaining({ stock: 0 }),
      );
    });

    it('un producto inexistente es GasCylinderNotFoundError y no guarda', async () => {
      await expect(
        service.reservarStock(manager, 'x', 1),
      ).rejects.toBeInstanceOf(GasCylinderNotFoundError);
      expect(save).not.toHaveBeenCalled();
    });

    it('una garrafa desactivada es GasCylinderNotFoundError y no descuenta', async () => {
      const g = { ...producto('a', 10), isActive: false } as GasCylinder;
      lecturas.push(g);
      await expect(
        service.reservarStock(manager, 'a', 1),
      ).rejects.toBeInstanceOf(GasCylinderNotFoundError);
      expect(g.stock).toBe(10);
      expect(save).not.toHaveBeenCalled();
    });

    it('sin stock suficiente es InsufficientStockError y no descuenta', async () => {
      const g = producto('a', 2);
      lecturas.push(g);
      await expect(
        service.reservarStock(manager, 'a', 3),
      ).rejects.toBeInstanceOf(InsufficientStockError);
      expect(g.stock).toBe(2);
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('restituirStock con déficit de reservas', () => {
    it('llenas 20, reservadas 15, merma de 10 y cancelación de 5: el vendible sigue en 0 (no 5)', async () => {
      // vendible 5 -> la merma de 10 lo recorta a 0 y deja 5 de déficit
      const g = { ...producto('a', 5), distributorId: 'd1' } as GasCylinder;
      lecturas.push(g);
      await service.ajustarVendible(
        manager,
        'd1',
        [{ gasCylinderId: 'a', delta: -10 }],
        { recortarEnCero: true },
      );
      expect(g.stock).toBe(0);
      expect(g.reservationDeficit).toBe(5);

      lecturas.push(g);
      await service.restituirStock(manager, [
        { gasCylinderId: 'a', quantity: 5 },
      ]);
      // llenas 10, reservadas 10
      expect(g.stock).toBe(0);
      expect(g.reservationDeficit).toBe(0);

      lecturas.push(g);
      await service.restituirStock(manager, [
        { gasCylinderId: 'a', quantity: 3 },
      ]);
      // llenas 10, reservadas 7
      expect(g.stock).toBe(3);
    });

    it('una cancelación parcial sobre el déficit sólo libera el resto', async () => {
      const g = { ...producto('a', 0), reservationDeficit: 2 } as GasCylinder;
      lecturas.push(g);
      await service.restituirStock(manager, [
        { gasCylinderId: 'a', quantity: 5 },
      ]);
      expect(g.reservationDeficit).toBe(0);
      expect(g.stock).toBe(3);
    });
  });

  describe('reajustarReserva (edición de un pedido)', () => {
    const conDeficit = (stock: number, reservationDeficit: number) =>
      ({
        ...producto('a', stock),
        distributorId: 'd1',
        reservationDeficit,
      }) as GasCylinder;

    it('llenas 7, reservadas 10 (vendible 0, déficit 3): editar de 2 a 1 NO falla y libera sólo lo que sobra cubriendo el déficit', async () => {
      const g = conDeficit(0, 3);
      lecturas.push(g);
      await service.reajustarReserva(
        manager,
        [{ gasCylinderId: 'a', quantity: 2 }],
        [{ gasCylinderId: 'a', quantity: 1 }],
      );
      expect(g.reservationDeficit).toBe(2);
      expect(g.stock).toBe(0);
    });

    it('sumar unidades de una garrafa dada de baja da 404 y no toca el stock', async () => {
      const g = { ...conDeficit(10, 0), isActive: false } as GasCylinder;
      lecturas.push(g);
      await expect(
        service.reajustarReserva(
          manager,
          [{ gasCylinderId: 'a', quantity: 1 }],
          [{ gasCylinderId: 'a', quantity: 3 }],
        ),
      ).rejects.toBeInstanceOf(GasCylinderNotFoundError);
      expect(g.stock).toBe(10);
    });

    it('devolver unidades de una garrafa dada de baja sí se permite', async () => {
      const g = { ...conDeficit(10, 0), isActive: false } as GasCylinder;
      lecturas.push(g);
      await service.reajustarReserva(
        manager,
        [{ gasCylinderId: 'a', quantity: 3 }],
        [{ gasCylinderId: 'a', quantity: 1 }],
      );
      expect(g.stock).toBe(12);
    });

    it('pedir más reserva sólo el aumento', async () => {
      const g = conDeficit(10, 0);
      lecturas.push(g);
      await service.reajustarReserva(
        manager,
        [{ gasCylinderId: 'a', quantity: 2 }],
        [{ gasCylinderId: 'a', quantity: 5 }],
      );
      expect(g.stock).toBe(7);
    });

    it('el aumento que no alcanza es InsufficientStock y no toca nada', async () => {
      const g = conDeficit(2, 0);
      lecturas.push(g);
      await expect(
        service.reajustarReserva(
          manager,
          [{ gasCylinderId: 'a', quantity: 2 }],
          [{ gasCylinderId: 'a', quantity: 5 }],
        ),
      ).rejects.toBeInstanceOf(InsufficientStockError);
      expect(g.stock).toBe(2);
      expect(save).not.toHaveBeenCalled();
    });

    it('pedir menos sin déficit devuelve la diferencia al vendible', async () => {
      const g = conDeficit(4, 0);
      lecturas.push(g);
      await service.reajustarReserva(
        manager,
        [{ gasCylinderId: 'a', quantity: 5 }],
        [{ gasCylinderId: 'a', quantity: 2 }],
      );
      expect(g.stock).toBe(7);
    });

    it('pedir menos que cubre todo el déficit sube el vendible sólo con el resto', async () => {
      const g = conDeficit(0, 2);
      lecturas.push(g);
      await service.reajustarReserva(
        manager,
        [{ gasCylinderId: 'a', quantity: 5 }],
        [{ gasCylinderId: 'a', quantity: 1 }],
      );
      expect(g.reservationDeficit).toBe(0);
      expect(g.stock).toBe(2);
    });

    it('si queda igual no toca nada (ni siquiera lo bloquea)', async () => {
      await service.reajustarReserva(
        manager,
        [{ gasCylinderId: 'a', quantity: 3 }],
        [{ gasCylinderId: 'a', quantity: 3 }],
      );
      expect(qb.getOne).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    it('cambiar de garrafa devuelve la vieja y reserva la nueva, en orden de id', async () => {
      const a = conDeficit(1, 0);
      const b = { ...conDeficit(9, 0), gasCylinderId: 'b' } as GasCylinder;
      lecturas.push(a, b);
      await service.reajustarReserva(
        manager,
        [{ gasCylinderId: 'b', quantity: 4 }],
        [{ gasCylinderId: 'a', quantity: 1 }],
      );
      expect(a.stock).toBe(0);
      expect(b.stock).toBe(13);
    });
  });

  describe('restituirStock', () => {
    it('devuelve la cantidad de cada ítem, con lock', async () => {
      const a = producto('a', 5);
      const b = producto('b', 1);
      lecturas.push(a, b);
      await service.restituirStock(manager, [
        { gasCylinderId: 'a', quantity: 2 },
        { gasCylinderId: 'b', quantity: 4 },
      ]);
      expect(a.stock).toBe(7);
      expect(b.stock).toBe(5);
      expect(qb.setLock).toHaveBeenCalledTimes(2);
    });

    it('ignora el ítem de un producto que ya no existe', async () => {
      lecturas.push(null);
      await service.restituirStock(manager, [
        { gasCylinderId: 'x', quantity: 2 },
      ]);
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('ajustarVendible (el vendible sigue al físico)', () => {
    const delProducto = (id: string, stock: number, distributorId = 'd1') =>
      ({
        gasCylinderId: id,
        distributorId,
        type: `Garrafa ${id}`,
        stock,
        reservationDeficit: 0,
      }) as GasCylinder;

    it('suma y resta con lock pesimista y por id ascendente', async () => {
      const a = delProducto('a', 5);
      const b = delProducto('b', 5);
      lecturas.push(a, b);
      await service.ajustarVendible(manager, 'd1', [
        { gasCylinderId: 'b', delta: -2 },
        { gasCylinderId: 'a', delta: 4 },
      ]);
      expect(a.stock).toBe(9);
      expect(b.stock).toBe(3);
      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
      const ids = (qb.where.mock.calls as unknown[][]).map(
        (c) => (c[1] as { id: string }).id,
      );
      expect(ids).toEqual(['a', 'b']);
    });

    it('nunca deja el vendible negativo: lo que falta está reservado por pedidos', async () => {
      const g = delProducto('a', 3);
      lecturas.push(g);
      await expect(
        service.ajustarVendible(manager, 'd1', [
          { gasCylinderId: 'a', delta: -4 },
        ]),
      ).rejects.toBeInstanceOf(VendibleInsuficienteError);
      expect(g.stock).toBe(3);
      expect(save).not.toHaveBeenCalled();
    });

    it('con recortarEnCero la pérdida se registra: el vendible queda en 0 (no negativo) y se informa cuánto faltó', async () => {
      const g = delProducto('a', 3);
      lecturas.push(g);
      const recortes = await service.ajustarVendible(
        manager,
        'd1',
        [{ gasCylinderId: 'a', delta: -5 }],
        { recortarEnCero: true },
      );
      expect(g.stock).toBe(0);
      expect(recortes).toEqual([
        { gasCylinderId: 'a', type: 'Garrafa a', faltante: 2 },
      ]);
      expect(save).toHaveBeenCalledWith(g);
    });

    it('con recortarEnCero y vendible suficiente no recorta nada', async () => {
      const g = delProducto('a', 3);
      lecturas.push(g);
      const recortes = await service.ajustarVendible(
        manager,
        'd1',
        [{ gasCylinderId: 'a', delta: -3 }],
        { recortarEnCero: true },
      );
      expect(g.stock).toBe(0);
      expect(recortes).toEqual([]);
    });

    it('el recorte suma lo que faltó al déficit de reservas', async () => {
      const g = delProducto('a', 3);
      lecturas.push(g);
      await service.ajustarVendible(
        manager,
        'd1',
        [{ gasCylinderId: 'a', delta: -5 }],
        { recortarEnCero: true },
      );
      expect(g.stock).toBe(0);
      expect(g.reservationDeficit).toBe(2);
    });

    it('una entrada de llenas cubre primero el déficit y sólo el resto sube el vendible', async () => {
      const g = {
        ...delProducto('a', 0),
        reservationDeficit: 5,
      } as GasCylinder;
      lecturas.push(g);
      await service.ajustarVendible(
        manager,
        'd1',
        [{ gasCylinderId: 'a', delta: 8 }],
        { recortarEnCero: true },
      );
      expect(g.reservationDeficit).toBe(0);
      expect(g.stock).toBe(3);
    });

    it('una entrada menor que el déficit no sube el vendible', async () => {
      const g = {
        ...delProducto('a', 0),
        reservationDeficit: 5,
      } as GasCylinder;
      lecturas.push(g);
      await service.ajustarVendible(
        manager,
        'd1',
        [{ gasCylinderId: 'a', delta: 2 }],
        { recortarEnCero: true },
      );
      expect(g.reservationDeficit).toBe(3);
      expect(g.stock).toBe(0);
    });

    it('sin recortarEnCero el cambio es exacto y no toca el déficit', async () => {
      const g = {
        ...delProducto('a', 4),
        reservationDeficit: 5,
      } as GasCylinder;
      lecturas.push(g);
      await service.ajustarVendible(manager, 'd1', [
        { gasCylinderId: 'a', delta: 2 },
      ]);
      expect(g.stock).toBe(6);
      expect(g.reservationDeficit).toBe(5);
    });

    it('con exactamente el vendible alcanza', async () => {
      const g = delProducto('a', 3);
      lecturas.push(g);
      await service.ajustarVendible(manager, 'd1', [
        { gasCylinderId: 'a', delta: -3 },
      ]);
      expect(g.stock).toBe(0);
    });

    it('un producto de otra distribuidora es 404 y no se toca', async () => {
      const g = delProducto('a', 3, 'otra');
      lecturas.push(g);
      await expect(
        service.ajustarVendible(manager, 'd1', [
          { gasCylinderId: 'a', delta: 1 },
        ]),
      ).rejects.toBeInstanceOf(GasCylinderNotFoundError);
      expect(g.stock).toBe(3);
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('bloquearEnOrden', () => {
    it('bloquea la unión sin repetidos, por id ascendente', async () => {
      await service.bloquearEnOrden(manager, ['c', 'a', 'b', 'a']);
      const ids = (qb.where.mock.calls as unknown[][]).map(
        (c) => (c[1] as { id: string }).id,
      );
      expect(ids).toEqual(['a', 'b', 'c']);
      expect(qb.setLock).toHaveBeenCalledTimes(3);
    });
  });
});
