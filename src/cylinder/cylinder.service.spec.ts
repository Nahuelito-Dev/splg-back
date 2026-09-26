import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CylinderService } from './cylinder.service';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { Order } from '../order/entities/order.entity';
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
  let orderRepo: jest.Mocked<Pick<Repository<Order>, 'findOne'>>;

  const DIST = 'dist-1';

  const makeCylinder = (over: Partial<Cylinder> = {}): Cylinder =>
    ({
      cylinder_id: 'cyl-1',
      distributor_id: DIST,
      serial: 'SN-001',
      state: CylinderState.IN_DEPOT,
      deposit: 0,
      current_customer_id: null,
      current_order_id: null,
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
    orderRepo = { findOne: jest.fn() } as unknown as typeof orderRepo;

    service = new CylinderService(
      cylinderRepo as unknown as Repository<Cylinder>,
      movementRepo as unknown as Repository<CylinderMovement>,
      orderRepo as unknown as Repository<Order>,
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
          distributor_id: DIST,
          serial: 'SN-001',
          state: CylinderState.IN_DEPOT,
          deposit: 500,
        }),
      );
      // Movimiento de alta: from null → in_depot.
      expect(movementRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          from_state: null,
          to_state: CylinderState.IN_DEPOT,
          distributor_id: DIST,
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
          from_state: CylinderState.IN_DEPOT,
          to_state: CylinderState.FILLED,
          actor_user_id: 'actor-1',
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
      orderRepo.findOne.mockResolvedValue({
        order_id: 'ord-1',
        customer_id: 'cust-9',
      } as Order);

      const result = await service.transition(
        'cyl-1',
        {
          toState: CylinderState.WITH_CUSTOMER,
          orderId: 'ord-1',
        } as TransitionCylinderDto,
        DIST,
      );

      expect(result.current_customer_id).toBe('cust-9');
    });

    it('al pasar a EMPTY_RETURNED limpia el cliente', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({
          state: CylinderState.WITH_CUSTOMER,
          current_customer_id: 'cust-9',
        }),
      );

      const result = await service.transition(
        'cyl-1',
        { toState: CylinderState.EMPTY_RETURNED } as TransitionCylinderDto,
        DIST,
      );

      expect(result.current_customer_id).toBeNull();
    });
  });

  describe('assignToOrder', () => {
    it('despacha cada envase (FILLED→DISPATCHED) y lo vincula al pedido', async () => {
      orderRepo.findOne.mockResolvedValue({
        order_id: 'ord-1',
        customer_id: 'cust-1',
      } as Order);
      cylinderRepo.findOne
        .mockResolvedValueOnce(
          makeCylinder({
            cylinder_id: 'cyl-1',
            serial: 'SN-001',
            state: CylinderState.FILLED,
          }),
        )
        .mockResolvedValueOnce(
          makeCylinder({
            cylinder_id: 'cyl-2',
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
      expect(result.every((c) => c.current_order_id === 'ord-1')).toBe(true);
      expect(movementRepo.save).toHaveBeenCalledTimes(2);
    });

    it('lanza 404 si el pedido no existe', async () => {
      orderRepo.findOne.mockResolvedValue(null);
      await expect(
        service.assignToOrder('nope', ['SN-001'], DIST),
      ).rejects.toThrow(NotFoundException);
    });

    it('propaga el 400 si un envase no está FILLED (no se puede despachar)', async () => {
      orderRepo.findOne.mockResolvedValue({
        order_id: 'ord-1',
        customer_id: 'cust-1',
      } as Order);
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
          cylinder_id: 'cyl-1',
          state: CylinderState.DISPATCHED,
          current_order_id: 'ord-1',
        }),
        makeCylinder({
          cylinder_id: 'cyl-2',
          state: CylinderState.DISPATCHED,
          current_order_id: 'ord-1',
        }),
      ]);
      orderRepo.findOne.mockResolvedValue({
        order_id: 'ord-1',
        customer_id: 'cust-7',
      } as Order);

      const count = await service.onOrderDelivered('ord-1', DIST);

      expect(count).toBe(2);
      expect(cylinderRepo.save).toHaveBeenCalledTimes(2);
      expect(cylinderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          state: CylinderState.WITH_CUSTOMER,
          current_customer_id: 'cust-7',
        }),
      );
    });

    it('es no-op (devuelve 0) si el pedido no tiene envases asignados', async () => {
      cylinderRepo.find.mockResolvedValue([]);

      const count = await service.onOrderDelivered('ord-sin-envases', DIST);

      expect(count).toBe(0);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
      // Ni siquiera consulta el pedido si no hay envases.
      expect(orderRepo.findOne).not.toHaveBeenCalled();
    });
  });
});
