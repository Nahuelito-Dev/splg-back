import { EntityManager, Repository } from 'typeorm';
import { GasCylinderService } from './gascylinder.service';
import { GasCylinder } from './entities/gascylinder.entity';
import { GasCylinderNotFoundError } from './domain/errors/gas-cylinder-not-found.error';
import { InsufficientStockError } from './domain/errors/insufficient-stock.error';
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
    ({ gasCylinderId: id, type: `Garrafa ${id}`, stock }) as GasCylinder;

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
