import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CylinderService } from './cylinder.service';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { CreateCylinderDto } from './dto/create-cylinder.dto';
import { TransitionCylinderDto } from './dto/transition-cylinder.dto';

/**
 * CylinderService: ciclo físico del envase. Mockeamos los tres repos (envase,
 * movimientos, pedido). Verificamos el alta con movimiento inicial, el manejo
 * del serial duplicado, las transiciones con su auditoría append-only y los dos
 * hooks del pedido: assignToOrder (despacho) y onOrderDelivered (entrega auto).
 */
describe('CylinderService', () => {
  let service: CylinderService;
  let cylinderRepo: jest.Mocked<
    Pick<Repository<Cylinder>, 'create' | 'save' | 'find' | 'findOne'>
  >;
  let movementRepo: jest.Mocked<
    Pick<Repository<CylinderMovement>, 'create' | 'save' | 'find'>
  >;
  let orderRepo: { findRef: jest.Mock };

  const DIST = 'dist-1';

  const makeCylinder = (over: Partial<Cylinder> = {}): Cylinder =>
    ({
      cylinderId: 'cyl-1',
      distributorId: DIST,
      serial: 'SN-001',
      state: CylinderState.IN_DEPOT,
      deposit: 0,
      currentCustomerId: null,
      currentOrderId: null,
      ...over,
    }) as Cylinder;

  beforeEach(() => {
    // create() devuelve el literal tal cual; save() lo devuelve resuelto.
    cylinderRepo = {
      create: jest.fn().mockImplementation((e: Cylinder) => e),
      save: jest.fn().mockImplementation((e: Cylinder) => Promise.resolve(e)),
      find: jest.fn(),
      findOne: jest.fn(),
    } as unknown as typeof cylinderRepo;
    movementRepo = {
      create: jest.fn().mockImplementation((e: CylinderMovement) => e),
      save: jest
        .fn()
        .mockImplementation((e: CylinderMovement) => Promise.resolve(e)),
      find: jest.fn(),
    } as unknown as typeof movementRepo;
    orderRepo = { findRef: jest.fn() };

    service = new CylinderService(
      cylinderRepo as unknown as Repository<Cylinder>,
      movementRepo as unknown as Repository<CylinderMovement>,
      orderRepo as unknown as OrderLookupService,
    );
  });

  describe('create', () => {
    it('da de alta el envase en IN_DEPOT y registra el movimiento inicial', async () => {
      await service.create(
        { serial: 'SN-001', deposit: 500 } as CreateCylinderDto,
        DIST,
      );

      expect(cylinderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          distributorId: DIST,
          serial: 'SN-001',
          state: CylinderState.IN_DEPOT,
          deposit: 500,
        }),
      );
      // Movimiento de alta: from null → in_depot.
      expect(movementRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fromState: null,
          toState: CylinderState.IN_DEPOT,
          distributorId: DIST,
        }),
      );
    });

    it('traduce el serial duplicado (23505) a 409', async () => {
      cylinderRepo.save.mockRejectedValueOnce({ code: '23505' });
      await expect(
        service.create({ serial: 'SN-001' } as CreateCylinderDto, DIST),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findOne', () => {
    it('lanza 404 si el envase no existe (o no es del tenant)', async () => {
      cylinderRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('nope', DIST)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('transition', () => {
    it('ejecuta una transición válida y audita el movimiento', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.IN_DEPOT }),
      );

      const result = await service.transition(
        'cyl-1',
        { toState: CylinderState.FILLED } as TransitionCylinderDto,
        DIST,
        'actor-1',
      );

      expect(result.state).toBe(CylinderState.FILLED);
      expect(movementRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fromState: CylinderState.IN_DEPOT,
          toState: CylinderState.FILLED,
          actorUserId: 'actor-1',
        }),
      );
    });

    it('rechaza una transición inválida y NO persiste nada', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.IN_DEPOT }),
      );

      await expect(
        service.transition(
          'cyl-1',
          { toState: CylinderState.WITH_CUSTOMER } as TransitionCylinderDto,
          DIST,
        ),
      ).rejects.toThrow(/Transición de envase inválida/);

      expect(cylinderRepo.save).not.toHaveBeenCalled();
      expect(movementRepo.save).not.toHaveBeenCalled();
    });

    it('al pasar a WITH_CUSTOMER con orderId toma el cliente del pedido', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.DISPATCHED }),
      );
      orderRepo.findRef.mockResolvedValue({
        orderId: 'ord-1',
        customerId: 'cust-9',
      });

      const result = await service.transition(
        'cyl-1',
        {
          toState: CylinderState.WITH_CUSTOMER,
          orderId: 'ord-1',
        } as TransitionCylinderDto,
        DIST,
      );

      expect(result.currentCustomerId).toBe('cust-9');
    });

    it('al pasar a EMPTY_RETURNED limpia el cliente', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({
          state: CylinderState.WITH_CUSTOMER,
          currentCustomerId: 'cust-9',
        }),
      );

      const result = await service.transition(
        'cyl-1',
        { toState: CylinderState.EMPTY_RETURNED } as TransitionCylinderDto,
        DIST,
      );

      expect(result.currentCustomerId).toBeNull();
    });
  });

  describe('transition con pedido de otra distribuidora (H-90)', () => {
    it('responde 404 y no toma el cliente del pedido ajeno', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.DISPATCHED }),
      );
      orderRepo.findRef.mockResolvedValue(null);
      await expect(
        service.transition(
          'cyl-1',
          {
            toState: CylinderState.WITH_CUSTOMER,
            orderId: 'ord-de-otra',
          } as TransitionCylinderDto,
          DIST,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(orderRepo.findRef).toHaveBeenCalledWith('ord-de-otra', DIST);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('assignToOrder', () => {
    it('despacha cada envase (FILLED→DISPATCHED) y lo vincula al pedido', async () => {
      orderRepo.findRef.mockResolvedValue({
        orderId: 'ord-1',
        customerId: 'cust-1',
      });
      cylinderRepo.findOne
        .mockResolvedValueOnce(
          makeCylinder({
            cylinderId: 'cyl-1',
            serial: 'SN-001',
            state: CylinderState.FILLED,
          }),
        )
        .mockResolvedValueOnce(
          makeCylinder({
            cylinderId: 'cyl-2',
            serial: 'SN-002',
            state: CylinderState.FILLED,
          }),
        );

      const result = await service.assignToOrder(
        'ord-1',
        ['SN-001', 'SN-002'],
        DIST,
        'chofer-1',
      );

      expect(result).toHaveLength(2);
      expect(result.every((c) => c.state === CylinderState.DISPATCHED)).toBe(
        true,
      );
      expect(result.every((c) => c.currentOrderId === 'ord-1')).toBe(true);
      expect(movementRepo.save).toHaveBeenCalledTimes(2);
    });

    it('lanza 404 si el pedido no existe', async () => {
      orderRepo.findRef.mockResolvedValue(null);
      await expect(
        service.assignToOrder('nope', ['SN-001'], DIST),
      ).rejects.toThrow(NotFoundException);
    });

    it('busca el pedido dentro de la distribuidora del envase (H-90)', async () => {
      orderRepo.findRef.mockResolvedValue(null);
      await expect(
        service.assignToOrder('ord-de-otra', ['SN-001'], DIST),
      ).rejects.toThrow(NotFoundException);
      expect(orderRepo.findRef).toHaveBeenCalledWith('ord-de-otra', DIST);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });

    it('propaga el 400 si un envase no está FILLED (no se puede despachar)', async () => {
      orderRepo.findRef.mockResolvedValue({
        orderId: 'ord-1',
        customerId: 'cust-1',
      });
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.IN_DEPOT }),
      );

      await expect(
        service.assignToOrder('ord-1', ['SN-001'], DIST),
      ).rejects.toThrow(/Transición de envase inválida/);
    });
  });

  describe('onOrderDelivered', () => {
    it('avanza los envases despachados del pedido a WITH_CUSTOMER y devuelve el conteo', async () => {
      cylinderRepo.find.mockResolvedValue([
        makeCylinder({
          cylinderId: 'cyl-1',
          state: CylinderState.DISPATCHED,
          currentOrderId: 'ord-1',
        }),
        makeCylinder({
          cylinderId: 'cyl-2',
          state: CylinderState.DISPATCHED,
          currentOrderId: 'ord-1',
        }),
      ]);
      orderRepo.findRef.mockResolvedValue({
        orderId: 'ord-1',
        customerId: 'cust-7',
      });

      const count = await service.onOrderDelivered('ord-1', DIST);

      expect(count).toBe(2);
      expect(cylinderRepo.save).toHaveBeenCalledTimes(2);
      expect(cylinderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          state: CylinderState.WITH_CUSTOMER,
          currentCustomerId: 'cust-7',
        }),
      );
    });

    it('es no-op (devuelve 0) si el pedido no tiene envases asignados', async () => {
      cylinderRepo.find.mockResolvedValue([]);

      const count = await service.onOrderDelivered('ord-sin-envases', DIST);

      expect(count).toBe(0);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
      // Ni siquiera consulta el pedido si no hay envases.
      expect(orderRepo.findRef).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    const armarQb = (
      entities: Cylinder[] = [],
      raw: Array<Record<string, unknown>> = [],
    ) => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(7),
        getRawAndEntities: jest.fn().mockResolvedValue({ entities, raw }),
      };
      (
        cylinderRepo as unknown as { createQueryBuilder: jest.Mock }
      ).createQueryBuilder = jest.fn().mockReturnValue(qb);
      return qb;
    };

    it('sin filtros ni tenant no agrega condiciones', async () => {
      const qb = armarQb();
      await service.findAll();
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('aplica tenant, estado, cliente y pedido', async () => {
      const qb = armarQb();
      await service.findAll(DIST, {
        state: CylinderState.WITH_CUSTOMER,
        customerUserId: 'u1',
        orderId: 'o1',
      });
      const condiciones = (qb.andWhere.mock.calls as unknown[][]).map(
        (c) => c[0],
      );
      expect(condiciones).toContain('cylinder.distributorId = :distributorId');
      expect(condiciones).toContain('cylinder.state = :state');
      expect(condiciones).toContain(
        'cylinder.currentCustomerId = :customerUserId',
      );
      expect(condiciones).toHaveLength(4);
      expect(qb.andWhere).toHaveBeenCalledWith(expect.anything(), {
        orderId: 'o1',
      });
    });

    it('sin limit no pagina; con limit pagina y devuelve el total sin paginar', async () => {
      const qb = armarQb();
      const [, total] = await service.findAll(DIST);
      expect(qb.limit).not.toHaveBeenCalled();
      expect(total).toBe(7);
      await service.findAll(DIST, { limit: 5, offset: 10 });
      expect(qb.limit).toHaveBeenCalledWith(5);
      expect(qb.offset).toHaveBeenCalledWith(10);
    });

    it('completa lastMovementAt con la fecha del último movimiento', async () => {
      const con = makeCylinder({ cylinderId: 'a' });
      const sin = makeCylinder({ cylinderId: 'b' });
      armarQb(
        [con, sin],
        [
          {
            cylinder_cylinder_id: 'a',
            ultimo_movimiento: '2026-10-01T10:00:00.000Z',
          },
          { cylinder_cylinder_id: 'b', ultimo_movimiento: null },
        ],
      );
      const [r] = await service.findAll(DIST);
      expect(r[0].lastMovementAt).toEqual(new Date('2026-10-01T10:00:00.000Z'));
      expect(r[1].lastMovementAt).toBeNull();
    });
  });
});
