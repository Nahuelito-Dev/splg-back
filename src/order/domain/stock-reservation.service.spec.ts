import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { StockReservationService } from './stock-reservation.service';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';

/**
 * StockReservationService opera SOBRE el EntityManager de la transacción del
 * caller (no abre la suya). Acá mockeamos ese manager: el query builder devuelve
 * la garrafa bloqueada y `save` registra las escrituras. Verificamos el lock
 * pesimista, el descuento, el oversell y la restitución.
 */
describe('StockReservationService', () => {
  let service: StockReservationService;
  let manager: jest.Mocked<Pick<EntityManager, 'save' | 'createQueryBuilder'>>;
  let qb: {
    setLock: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };

  /** Arma un query builder encadenable que resuelve `getOne` con `cylinder`. */
  const mockQueryBuilderReturning = (cylinder: GasCylinder | null) => {
    qb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(cylinder),
    };
    manager.createQueryBuilder.mockReturnValue(qb as any);
  };

  const makeCylinder = (over: Partial<GasCylinder> = {}): GasCylinder =>
    ({
      gas_cylinder_id: 'gc-1',
      type: 'Garrafa 10kg',
      stock: 10,
      ...over,
    }) as GasCylinder;

  beforeEach(() => {
    service = new StockReservationService();
    manager = {
      save: jest.fn().mockImplementation(async (e) => e),
      createQueryBuilder: jest.fn(),
    } as any;
  });

  describe('reserve', () => {
    it('toma lock pesimista y descuenta el stock de la garrafa', async () => {
      const cylinder = makeCylinder({ stock: 10 });
      mockQueryBuilderReturning(cylinder);

      const result = await service.reserve(manager as any, 'gc-1', 3);

      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(result.stock).toBe(7); // 10 - 3
      expect(manager.save).toHaveBeenCalledWith(cylinder);
    });

    it('permite reservar exactamente todo el stock disponible (borde)', async () => {
      const cylinder = makeCylinder({ stock: 5 });
      mockQueryBuilderReturning(cylinder);

      const result = await service.reserve(manager as any, 'gc-1', 5);

      expect(result.stock).toBe(0);
      expect(manager.save).toHaveBeenCalled();
    });

    it('lanza NotFoundException si la garrafa no existe (y no guarda)', async () => {
      mockQueryBuilderReturning(null);

      await expect(service.reserve(manager as any, 'gc-x', 1)).rejects.toThrow(
        NotFoundException,
      );
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('lanza BadRequestException por oversell y NO descuenta ni guarda', async () => {
      const cylinder = makeCylinder({ stock: 2 });
      mockQueryBuilderReturning(cylinder);

      await expect(service.reserve(manager as any, 'gc-1', 3)).rejects.toThrow(
        BadRequestException,
      );
      expect(cylinder.stock).toBe(2); // intacto
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    it('devuelve el stock de cada ítem (suma la cantidad) con lock', async () => {
      const cylinder = makeCylinder({ stock: 4 });
      mockQueryBuilderReturning(cylinder);

      await service.restore(manager as any, [
        { gas_cylinder_id: 'gc-1', quantity: 3 },
      ]);

      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(cylinder.stock).toBe(7); // 4 + 3
      expect(manager.save).toHaveBeenCalledWith(cylinder);
    });

    it('ignora silenciosamente ítems cuya garrafa ya no existe', async () => {
      mockQueryBuilderReturning(null);

      await expect(
        service.restore(manager as any, [
          { gas_cylinder_id: 'baja', quantity: 2 },
        ]),
      ).resolves.toBeUndefined();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('procesa múltiples ítems en un mismo pedido', async () => {
      const c1 = makeCylinder({ gas_cylinder_id: 'gc-1', stock: 0 });
      const c2 = makeCylinder({ gas_cylinder_id: 'gc-2', stock: 1 });
      // cada getOne devuelve la garrafa correspondiente en orden
      qb = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValueOnce(c1).mockResolvedValueOnce(c2),
      };
      manager.createQueryBuilder.mockReturnValue(qb as any);

      await service.restore(manager as any, [
        { gas_cylinder_id: 'gc-1', quantity: 2 },
        { gas_cylinder_id: 'gc-2', quantity: 4 },
      ]);

      expect(c1.stock).toBe(2);
      expect(c2.stock).toBe(5);
      expect(manager.save).toHaveBeenCalledTimes(2);
    });
  });
});
