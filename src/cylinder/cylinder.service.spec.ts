import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityManager, Repository } from 'typeorm';
import { EnvasesVencidosException } from './cylinder-vencido.exception';
import { EVENTO_DESPACHO_BLOQUEADO } from './events/despacho-bloqueado.event';
import {
  EnvaseDevueltoEvent,
  EVENTO_ENVASE_DEVUELTO,
} from './events/envase-devuelto.event';
import { CylinderService } from './cylinder.service';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { DeliveryService } from '../delivery/delivery.service';
import { OrderStatus } from '../order/entities/order.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { CreateCylinderDto } from './dto/create-cylinder.dto';
import { InvalidCylinderTransitionError } from './domain/errors/invalid-cylinder-transition.error';
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
  let orderRepo: { findRef: jest.Mock; findParaDespacho: jest.Mock };
  let deliveries: { buscarPorIdOUsuario: jest.Mock };
  let gasCylinders: { findOne: jest.Mock };
  let lockQb: { getOne: jest.Mock; getMany: jest.Mock; [k: string]: jest.Mock };
  let eventos: { emit: jest.Mock };

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
    orderRepo = { findRef: jest.fn(), findParaDespacho: jest.fn() };
    deliveries = { buscarPorIdOUsuario: jest.fn() };
    gasCylinders = { findOne: jest.fn().mockResolvedValue({}) };

    // Transacción con el envase bloqueado: el "SELECT ... FOR UPDATE" devuelve
    // lo que se configure en `cylinderRepo.findOne`, y los repos son los mismos.
    lockQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => cylinderRepo.findOne({})),
      getMany: jest.fn(),
    };
    eventos = { emit: jest.fn() };
    const manager = {
      createQueryBuilder: jest.fn(() => lockQb),
      getRepository: jest.fn((entity: unknown) =>
        entity === Cylinder ? cylinderRepo : movementRepo,
      ),
      save: (e: unknown) => cylinderRepo.save(e as Cylinder),
    };
    (cylinderRepo as unknown as { manager: unknown }).manager = {
      transaction: (fn: (m: unknown) => unknown) => fn(manager),
    };

    service = new CylinderService(
      cylinderRepo as unknown as Repository<Cylinder>,
      movementRepo as unknown as Repository<CylinderMovement>,
      orderRepo as unknown as OrderLookupService,
      gasCylinders as unknown as GasCylinderService,
      eventos as unknown as EventEmitter2,
      deliveries as unknown as DeliveryService,
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

    it('guarda el serial en su forma canónica (sin espacios en los bordes y en mayúsculas)', async () => {
      await service.create(
        { serial: '  sn-abc 1 ' } as CreateCylinderDto,
        DIST,
      );
      expect(cylinderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ serial: 'SN-ABC 1' }),
      );
    });

    it.each(['', '   '])(
      'un serial %j es 400 y no guarda nada',
      async (serial) => {
        await expect(
          service.create({ serial } as CreateCylinderDto, DIST),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(cylinderRepo.save).not.toHaveBeenCalled();
      },
    );

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

      orderRepo.findParaDespacho.mockResolvedValue({
        status: OrderStatus.ACCEPTED,
        deliveryId: null,
        orderId: 'ord-1',
        customerId: 'cust-9',
      });

      await expect(
        service.transition(
          'cyl-1',
          {
            toState: CylinderState.WITH_CUSTOMER,
            orderId: 'ord-1',
          } as TransitionCylinderDto,
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
      orderRepo.findParaDespacho.mockResolvedValue({
        status: OrderStatus.ACCEPTED,
        deliveryId: null,
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

    it('with_customer sin orderId es 400 y no toca nada', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.DISPATCHED }),
      );
      await expect(
        service.transition(
          'cyl-1',
          { toState: CylinderState.WITH_CUSTOMER } as TransitionCylinderDto,
          DIST,
        ),
      ).rejects.toThrow(/requiere indicar el pedido/);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
      expect(movementRepo.save).not.toHaveBeenCalled();
    });

    it('dispatched → in_depot limpia el pedido del envase', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({
          state: CylinderState.DISPATCHED,
          currentOrderId: 'ord-A',
        }),
      );
      const r = await service.transition(
        'cyl-1',
        { toState: CylinderState.IN_DEPOT } as TransitionCylinderDto,
        DIST,
      );
      expect(r.currentOrderId).toBeNull();
    });

    it('despachar por /transition con pedido fija el pedido del envase', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.FILLED, currentOrderId: 'ord-A' }),
      );
      orderRepo.findParaDespacho.mockResolvedValue({
        status: OrderStatus.ACCEPTED,
        deliveryId: null,
        orderId: 'ord-B',
        customerId: 'cust-B',
      });
      const r = await service.transition(
        'cyl-1',
        {
          toState: CylinderState.DISPATCHED,
          orderId: 'ord-B',
        } as TransitionCylinderDto,
        DIST,
      );
      expect(r.currentOrderId).toBe('ord-B');
    });

    it('despachar por /transition sin pedido deja el envase sin pedido', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.FILLED, currentOrderId: 'ord-A' }),
      );
      const r = await service.transition(
        'cyl-1',
        { toState: CylinderState.DISPATCHED } as TransitionCylinderDto,
        DIST,
      );
      expect(r.currentOrderId).toBeNull();
    });

    describe('con pedido (mismo control que assign)', () => {
      const ped = (over: object = {}) => ({
        orderId: 'ord-B',
        customerId: 'cust-B',
        status: OrderStatus.ACCEPTED,
        deliveryId: 'del-1',
        ...over,
      });
      const filled = () =>
        cylinderRepo.findOne.mockResolvedValue(
          makeCylinder({ state: CylinderState.FILLED }),
        );

      it.each([
        OrderStatus.DELIVERED,
        OrderStatus.CANCELLED,
        OrderStatus.RESERVED,
      ])('despachar a un pedido %s es 409 y no escribe', async (status) => {
        filled();
        orderRepo.findParaDespacho.mockResolvedValue(ped({ status }));
        await expect(
          service.transition(
            'cyl-1',
            { toState: CylinderState.DISPATCHED, orderId: 'ord-B' },
            DIST,
            'admin-1',
            RoleType.ADMIN,
          ),
        ).rejects.toThrow(ConflictException);
        expect(cylinderRepo.save).not.toHaveBeenCalled();
      });

      it('un chofer no despacha a un pedido de otro chofer: 404', async () => {
        filled();
        orderRepo.findParaDespacho.mockResolvedValue(
          ped({ deliveryId: 'del-2' }),
        );
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'del-1',
        });
        await expect(
          service.transition(
            'cyl-1',
            { toState: CylinderState.DISPATCHED, orderId: 'ord-B' },
            DIST,
            'user-chofer',
            RoleType.DELIVERY,
          ),
        ).rejects.toThrow(NotFoundException);
        expect(cylinderRepo.save).not.toHaveBeenCalled();
      });

      it('un chofer no entrega (with_customer) a un pedido ajeno: 404', async () => {
        cylinderRepo.findOne.mockResolvedValue(
          makeCylinder({ state: CylinderState.DISPATCHED }),
        );
        orderRepo.findParaDespacho.mockResolvedValue(ped({ deliveryId: null }));
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'del-1',
        });
        await expect(
          service.transition(
            'cyl-1',
            { toState: CylinderState.WITH_CUSTOMER, orderId: 'ord-B' },
            DIST,
            'user-chofer',
            RoleType.DELIVERY,
          ),
        ).rejects.toThrow(NotFoundException);
        expect(cylinderRepo.save).not.toHaveBeenCalled();
      });

      it('un chofer no se apropia (with_customer) de un envase despachado a un pedido de otro chofer', async () => {
        cylinderRepo.findOne.mockResolvedValue(
          makeCylinder({
            state: CylinderState.DISPATCHED,
            currentOrderId: 'ord-A',
          }),
        );
        orderRepo.findParaDespacho.mockImplementation((id: string) =>
          Promise.resolve(
            id === 'ord-A'
              ? ped({ orderId: 'ord-A', deliveryId: 'del-2' })
              : ped({ status: OrderStatus.CANCELLED }),
          ),
        );
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'del-1',
        });
        await expect(
          service.transition(
            'cyl-1',
            { toState: CylinderState.WITH_CUSTOMER, orderId: 'ord-B' },
            DIST,
            'user-chofer',
            RoleType.DELIVERY,
          ),
        ).rejects.toThrow(/Envase no encontrado/);
        expect(cylinderRepo.save).not.toHaveBeenCalled();
      });

      it('un chofer no libera (in_depot sin orderId) un envase atado a un pedido ajeno', async () => {
        cylinderRepo.findOne.mockResolvedValue(
          makeCylinder({
            state: CylinderState.DISPATCHED,
            currentOrderId: 'ord-A',
          }),
        );
        orderRepo.findParaDespacho.mockResolvedValue(
          ped({ orderId: 'ord-A', deliveryId: 'del-2' }),
        );
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'del-1',
        });
        await expect(
          service.transition(
            'cyl-1',
            { toState: CylinderState.IN_DEPOT },
            DIST,
            'user-chofer',
            RoleType.DELIVERY,
          ),
        ).rejects.toThrow(NotFoundException);
        expect(cylinderRepo.save).not.toHaveBeenCalled();
      });

      it('un chofer con un envase atado a su pedido A no puede indicar otro pedido B: 409', async () => {
        cylinderRepo.findOne.mockResolvedValue(
          makeCylinder({
            state: CylinderState.DISPATCHED,
            currentOrderId: 'ord-A',
          }),
        );
        orderRepo.findParaDespacho.mockImplementation((id: string) =>
          Promise.resolve(ped({ orderId: id })),
        );
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'del-1',
        });
        await expect(
          service.transition(
            'cyl-1',
            { toState: CylinderState.WITH_CUSTOMER, orderId: 'ord-B' },
            DIST,
            'user-chofer',
            RoleType.DELIVERY,
          ),
        ).rejects.toThrow(ConflictException);
        expect(cylinderRepo.save).not.toHaveBeenCalled();
      });

      it('un chofer puede devolver a depósito su propio envase despachado (sin orderId)', async () => {
        cylinderRepo.findOne.mockResolvedValue(
          makeCylinder({
            state: CylinderState.DISPATCHED,
            currentOrderId: 'ord-A',
          }),
        );
        orderRepo.findParaDespacho.mockResolvedValue(ped({ orderId: 'ord-A' }));
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'del-1',
        });
        const r = await service.transition(
          'cyl-1',
          { toState: CylinderState.IN_DEPOT },
          DIST,
          'user-chofer',
          RoleType.DELIVERY,
        );
        expect(r.state).toBe(CylinderState.IN_DEPOT);
        expect(r.currentOrderId).toBeNull();
      });

      it('un chofer sin orderId sobre un envase sin pedido: 403 (tarea de depósito)', async () => {
        filled();
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'del-1',
        });
        await expect(
          service.transition(
            'cyl-1',
            { toState: CylinderState.IN_DEPOT },
            DIST,
            'user-chofer',
            RoleType.DELIVERY,
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('si el envase cambió de pedido entre la lectura y el bloqueo: 409', async () => {
        cylinderRepo.findOne
          .mockResolvedValueOnce(
            makeCylinder({
              state: CylinderState.DISPATCHED,
              currentOrderId: 'ord-A',
            }),
          )
          .mockResolvedValueOnce(
            makeCylinder({
              state: CylinderState.DISPATCHED,
              currentOrderId: 'ord-C',
            }),
          );
        orderRepo.findParaDespacho.mockResolvedValue(ped());
        await expect(
          service.transition(
            'cyl-1',
            { toState: CylinderState.IN_DEPOT },
            DIST,
            'admin-1',
            RoleType.ADMIN,
          ),
        ).rejects.toThrow(/cambió de pedido/);
        expect(cylinderRepo.save).not.toHaveBeenCalled();
      });

      it('valida el pedido bloqueándolo dentro de la transacción, antes que el envase', async () => {
        filled();
        orderRepo.findParaDespacho.mockResolvedValue(ped());
        await service.transition(
          'cyl-1',
          { toState: CylinderState.DISPATCHED, orderId: 'ord-B' },
          DIST,
          'admin-1',
          RoleType.ADMIN,
        );
        expect(orderRepo.findParaDespacho).toHaveBeenCalledWith(
          'ord-B',
          DIST,
          expect.anything(),
        );
        expect(
          orderRepo.findParaDespacho.mock.invocationCallOrder[0],
        ).toBeLessThan(lockQb.setLock.mock.invocationCallOrder[0]);
      });

      it('el chofer del pedido despacha y entrega', async () => {
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: 'del-1',
        });
        orderRepo.findParaDespacho.mockResolvedValue(ped());
        filled();
        const d = await service.transition(
          'cyl-1',
          { toState: CylinderState.DISPATCHED, orderId: 'ord-B' },
          DIST,
          'user-chofer',
          RoleType.DELIVERY,
        );
        expect(d.currentOrderId).toBe('ord-B');
        const e = await service.transition(
          'cyl-1',
          { toState: CylinderState.WITH_CUSTOMER, orderId: 'ord-B' },
          DIST,
          'user-chofer',
          RoleType.DELIVERY,
        );
        expect(e.currentCustomerId).toBe('cust-B');
      });
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

  describe('devolución del envase (recupero de envases, CU-108)', () => {
    it('al volver de un cliente avisa con el cliente que lo tenía, ya con la transacción cerrada', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({
          state: CylinderState.WITH_CUSTOMER,
          currentCustomerId: 'cust-1',
        }),
      );

      await service.transition(
        'cyl-1',
        { toState: CylinderState.EMPTY_RETURNED } as TransitionCylinderDto,
        DIST,
        'chofer-1',
      );

      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_ENVASE_DEVUELTO,
        new EnvaseDevueltoEvent(DIST, 'cyl-1', 'cust-1', null),
      );
    });

    it('otras transiciones no avisan devolución', async () => {
      cylinderRepo.findOne.mockResolvedValue(makeCylinder());
      await service.transition(
        'cyl-1',
        { toState: CylinderState.FILLED } as TransitionCylinderDto,
        DIST,
      );
      expect(eventos.emit).not.toHaveBeenCalledWith(
        EVENTO_ENVASE_DEVUELTO,
        expect.anything(),
      );
    });

    it('si la transición falla no avisa devolución', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.IN_DEPOT }),
      );
      await expect(
        service.transition(
          'cyl-1',
          { toState: CylinderState.EMPTY_RETURNED } as TransitionCylinderDto,
          DIST,
        ),
      ).rejects.toBeInstanceOf(InvalidCylinderTransitionError);
      expect(eventos.emit).not.toHaveBeenCalled();
    });
  });

  describe('retireLost (envase perdido, decisión del administrador)', () => {
    const manager = () =>
      ({
        createQueryBuilder: jest.fn(() => lockQb),
        getRepository: jest.fn((entity: unknown) =>
          entity === Cylinder ? cylinderRepo : movementRepo,
        ),
      }) as unknown as EntityManager;

    it('da de baja el envase que sigue con un cliente, lo libera y deja el motivo', async () => {
      const envase = makeCylinder({
        state: CylinderState.WITH_CUSTOMER,
        currentCustomerId: 'cust-1',
      });
      cylinderRepo.findOne.mockResolvedValue(envase);

      await service.retireLost(
        'cyl-1',
        'extraviado',
        DIST,
        'admin-1',
        manager(),
      );

      expect(cylinderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          state: CylinderState.RETIRED,
          currentCustomerId: null,
        }),
      );
      expect(movementRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fromState: CylinderState.WITH_CUSTOMER,
          toState: CylinderState.RETIRED,
          actorUserId: 'admin-1',
          note: 'Baja por pérdida: extraviado',
        }),
      );
    });

    it('si el envase ya no está con un cliente es 409 y no persiste', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.EMPTY_RETURNED }),
      );
      await expect(
        service.retireLost('cyl-1', 'x', DIST, 'admin-1', manager()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });

    it('la baja común sigue rechazando un envase en poder de un cliente', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({
          state: CylinderState.WITH_CUSTOMER,
          currentCustomerId: 'cust-1',
        }),
      );
      await expect(service.retire('cyl-1', 'x', DIST)).rejects.toBeInstanceOf(
        InvalidCylinderTransitionError,
      );
    });
  });

  describe('transition con pedido de otra distribuidora (H-90)', () => {
    it('responde 404 y no toma el cliente del pedido ajeno', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.DISPATCHED }),
      );
      orderRepo.findParaDespacho.mockResolvedValue(null);
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
      expect(orderRepo.findParaDespacho).toHaveBeenCalledWith(
        'ord-de-otra',
        DIST,
        expect.anything(),
      );
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('assignToOrder', () => {
    const PEDIDO = {
      orderId: 'ord-1',
      customerId: 'cust-1',
      status: OrderStatus.ACCEPTED,
      deliveryId: 'del-1',
    };
    const filled = (serial: string, over: Partial<Cylinder> = {}) =>
      makeCylinder({
        cylinderId: `cyl-${serial}`,
        serial,
        state: CylinderState.FILLED,
        ...over,
      });
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const manana = new Date(Date.now() + 24 * 60 * 60 * 1000);

    it('despacha cada envase (FILLED→DISPATCHED) y lo vincula al pedido', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      lockQb.getMany.mockResolvedValue([filled('SN-001'), filled('SN-002')]);

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
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('encuentra un envase cuyo serial quedó guardado sin normalizar, y busca por la forma canónica', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      lockQb.getMany.mockResolvedValue([filled(' sn-001 ')]);

      const result = await service.assignToOrder(
        'ord-1',
        [' sn-001'],
        DIST,
        'chofer-1',
      );

      expect(result).toHaveLength(1);
      expect(result[0].state).toBe(CylinderState.DISPATCHED);
      expect(lockQb.where).toHaveBeenCalledWith(
        expect.stringContaining('upper(btrim(cylinder.serial)) IN'),
        { serials: [' sn-001'] },
      );
    });

    it('lanza 404 si el pedido no existe', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(null);
      await expect(
        service.assignToOrder('nope', ['SN-001'], DIST),
      ).rejects.toThrow(NotFoundException);
    });

    it('busca el pedido dentro de la distribuidora del envase (H-90)', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(null);
      await expect(
        service.assignToOrder('ord-de-otra', ['SN-001'], DIST),
      ).rejects.toThrow(NotFoundException);
      expect(orderRepo.findParaDespacho).toHaveBeenCalledWith(
        'ord-de-otra',
        DIST,
        expect.anything(),
      );
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });

    it('propaga el 400 si un envase no está FILLED (no se puede despachar)', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      lockQb.getMany.mockResolvedValue([
        makeCylinder({ state: CylinderState.IN_DEPOT }),
      ]);

      await expect(
        service.assignToOrder('ord-1', ['SN-001'], DIST),
      ).rejects.toThrow(/Transición de envase inválida/);
    });

    it.each([
      OrderStatus.DELIVERED,
      OrderStatus.CANCELLED,
      OrderStatus.RESERVED,
    ])('409 si el pedido está %s, sin tocar ningún envase', async (status) => {
      orderRepo.findParaDespacho.mockResolvedValue({ ...PEDIDO, status });
      lockQb.getMany.mockResolvedValue([filled('SN-001')]);

      const error: unknown = await service
        .assignToOrder('ord-1', ['SN-001'], DIST, 'admin-1', RoleType.ADMIN)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toMatch(
        /no se le pueden asignar envases/,
      );
      expect(lockQb.getMany).not.toHaveBeenCalled();
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });

    it.each([
      OrderStatus.PENDING,
      OrderStatus.ACCEPTED,
      OrderStatus.ON_THE_WAY,
    ])('el admin asigna a un pedido %s', async (status) => {
      orderRepo.findParaDespacho.mockResolvedValue({ ...PEDIDO, status });
      lockQb.getMany.mockResolvedValue([filled('SN-001')]);
      const r = await service.assignToOrder(
        'ord-1',
        ['SN-001'],
        DIST,
        'admin-1',
        RoleType.ADMIN,
      );
      expect(r).toHaveLength(1);
    });

    it('el chofer asignado al pedido carga los envases', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      deliveries.buscarPorIdOUsuario.mockResolvedValue({ deliveryId: 'del-1' });
      lockQb.getMany.mockResolvedValue([filled('SN-001')]);
      const r = await service.assignToOrder(
        'ord-1',
        ['SN-001'],
        DIST,
        'user-chofer',
        RoleType.DELIVERY,
      );
      expect(r).toHaveLength(1);
      expect(deliveries.buscarPorIdOUsuario).toHaveBeenCalledWith(
        'user-chofer',
      );
    });

    it.each([
      ['otro chofer', { deliveryId: 'del-2' }, 'del-1'],
      ['sin chofer asignado', { deliveryId: null }, 'del-1'],
    ])(
      '404 si el chofer no es el del pedido (%s) y no revela que existe',
      async (_caso, over, propio) => {
        orderRepo.findParaDespacho.mockResolvedValue({ ...PEDIDO, ...over });
        deliveries.buscarPorIdOUsuario.mockResolvedValue({
          deliveryId: propio,
        });
        const error: unknown = await service
          .assignToOrder(
            'ord-1',
            ['SN-001'],
            DIST,
            'user-chofer',
            RoleType.DELIVERY,
          )
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as Error).message).toBe('Pedido no encontrado');
        expect(lockQb.getMany).not.toHaveBeenCalled();
      },
    );

    it('404 si el usuario DELIVERY no tiene perfil de chofer', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      deliveries.buscarPorIdOUsuario.mockResolvedValue(null);
      await expect(
        service.assignToOrder(
          'ord-1',
          ['SN-001'],
          DIST,
          'u',
          RoleType.DELIVERY,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('un chofer con el pedido ajeno y entregado ve 404 (no el estado)', async () => {
      orderRepo.findParaDespacho.mockResolvedValue({
        ...PEDIDO,
        deliveryId: 'del-2',
        status: OrderStatus.DELIVERED,
      });
      deliveries.buscarPorIdOUsuario.mockResolvedValue({ deliveryId: 'del-1' });
      await expect(
        service.assignToOrder(
          'ord-1',
          ['SN-001'],
          DIST,
          'u',
          RoleType.DELIVERY,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('bloquea el pedido dentro de la transacción antes que los envases', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      lockQb.getMany.mockResolvedValue([filled('SN-001')]);
      await service.assignToOrder('ord-1', ['SN-001'], DIST);
      expect(orderRepo.findParaDespacho).toHaveBeenCalledWith(
        'ord-1',
        DIST,
        expect.anything(),
      );
      expect(
        orderRepo.findParaDespacho.mock.invocationCallOrder[0],
      ).toBeLessThan(lockQb.getMany.mock.invocationCallOrder[0]);
    });

    it('404 si algún serial no existe o es de otra distribuidora, sin escribir', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      lockQb.getMany.mockResolvedValue([filled('SN-001')]);

      await expect(
        service.assignToOrder('ord-1', ['SN-001', 'SN-AJENO'], DIST),
      ).rejects.toThrow(NotFoundException);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });

    it('400 si repite un serial', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      await expect(
        service.assignToOrder('ord-1', ['SN-001', 'SN-001'], DIST),
      ).rejects.toThrow(BadRequestException);
      expect(lockQb.getMany).not.toHaveBeenCalled();
    });

    it('CU-135: un envase vencido rechaza la asignación completa, informa los seriales y avisa al panel', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      lockQb.getMany.mockResolvedValue([
        filled('SN-001', { expiresAt: manana }),
        filled('SN-002', { expiresAt: ayer }),
        filled('SN-003', { expiresAt: ayer }),
      ]);

      const error: unknown = await service
        .assignToOrder('ord-1', ['SN-001', 'SN-002', 'SN-003'], DIST)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EnvasesVencidosException);
      expect((error as EnvasesVencidosException).serials).toEqual([
        'SN-002',
        'SN-003',
      ]);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
      expect(movementRepo.save).not.toHaveBeenCalled();
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_DESPACHO_BLOQUEADO,
        expect.objectContaining({
          distributorId: DIST,
          orderId: 'ord-1',
          serials: ['SN-002', 'SN-003'],
        }),
      );
    });

    it('un despacho inválido (no está lleno) es 400 aunque otro envase esté vencido, y no avisa', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      lockQb.getMany.mockResolvedValue([
        filled('SN-001', { expiresAt: ayer }),
        makeCylinder({ serial: 'SN-002', state: CylinderState.IN_DEPOT }),
      ]);

      await expect(
        service.assignToOrder('ord-1', ['SN-001', 'SN-002'], DIST),
      ).rejects.toBeInstanceOf(InvalidCylinderTransitionError);
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('CU-135: un envase sin vencimiento cargado pasa y queda anotado', async () => {
      orderRepo.findParaDespacho.mockResolvedValue(PEDIDO);
      lockQb.getMany.mockResolvedValue([
        filled('SN-001', { expiresAt: null }),
        filled('SN-002', { expiresAt: manana }),
      ]);

      await service.assignToOrder('ord-1', ['SN-001', 'SN-002'], DIST);

      const notas = movementRepo.save.mock.calls.map(
        ([m]) => (m as unknown as { note: string }).note,
      );
      expect(notas[0]).toContain('sin revisión registrada');
      expect(notas[1]).not.toContain('sin revisión registrada');
    });
  });

  describe('transition a DISPATCHED (cualquier puerta al despacho)', () => {
    it('un envase vencido no se despacha por /transition: 409 y avisa', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({
          state: CylinderState.FILLED,
          expiresAt: new Date(Date.now() - 86400000),
        }),
      );

      await expect(
        service.transition(
          'cyl-1',
          { toState: CylinderState.DISPATCHED },
          DIST,
        ),
      ).rejects.toBeInstanceOf(EnvasesVencidosException);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_DESPACHO_BLOQUEADO,
        expect.objectContaining({ serials: ['SN-001'], orderId: null }),
      );
    });

    it('vigente o sin fecha se despacha', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.FILLED, expiresAt: null }),
      );
      const r = await service.transition(
        'cyl-1',
        { toState: CylinderState.DISPATCHED },
        DIST,
      );
      expect(r.state).toBe(CylinderState.DISPATCHED);
    });

    it('un vencido sí puede volver al depósito (no es un despacho)', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({
          state: CylinderState.FILLED,
          expiresAt: new Date(Date.now() - 86400000),
        }),
      );
      const r = await service.transition(
        'cyl-1',
        { toState: CylinderState.IN_DEPOT },
        DIST,
      );
      expect(r.state).toBe(CylinderState.IN_DEPOT);
    });
  });

  describe('onOrderDelivered', () => {
    it('avanza los envases despachados del pedido a WITH_CUSTOMER y devuelve el conteo', async () => {
      lockQb.getMany.mockResolvedValue([
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

    it('con manager, lee y escribe envases y movimientos SOLO por él (la tx tiene el pedido bloqueado)', async () => {
      const txCylinders = {
        save: jest.fn((e: Cylinder) => Promise.resolve(e)),
      };
      const txQb = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
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
        ]),
      };
      const txMovements = {
        create: jest.fn((e: CylinderMovement) => e),
        save: jest.fn((e: CylinderMovement) => Promise.resolve(e)),
      };
      const manager = {
        createQueryBuilder: jest.fn(() => txQb),
        getRepository: jest.fn((entity: unknown) =>
          entity === Cylinder ? txCylinders : txMovements,
        ),
      } as unknown as EntityManager;
      orderRepo.findRef.mockResolvedValue({
        orderId: 'ord-1',
        customerId: 'cust-7',
      });

      const count = await service.onOrderDelivered('ord-1', DIST, manager);

      expect(count).toBe(2);
      expect(txCylinders.save).toHaveBeenCalledTimes(2);
      expect(txMovements.save).toHaveBeenCalledTimes(2);
      expect(cylinderRepo.find).not.toHaveBeenCalled();
      expect(cylinderRepo.save).not.toHaveBeenCalled();
      expect(movementRepo.save).not.toHaveBeenCalled();
      // Relee con el envase bloqueado y sólo los despachados de ese pedido.
      expect(txQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(txQb.where).toHaveBeenCalledWith(
        'cylinder.currentOrderId = :orderId',
        { orderId: 'ord-1' },
      );
      expect(txQb.andWhere).toHaveBeenCalledWith('cylinder.state = :state', {
        state: CylinderState.DISPATCHED,
      });
    });

    it('es no-op (devuelve 0) si el pedido no tiene envases asignados', async () => {
      lockQb.getMany.mockResolvedValue([]);

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
        addOrderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
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

  describe('update', () => {
    it('edita sólo datos maestros y no toca el estado', async () => {
      const c = makeCylinder({ state: CylinderState.WITH_CUSTOMER });
      cylinderRepo.findOne.mockResolvedValue(c);
      await service.update('cyl-1', { serial: 'SN-NEW', deposit: 10 }, DIST);
      expect(cylinderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          serial: 'SN-NEW',
          deposit: 10,
          state: CylinderState.WITH_CUSTOMER,
        }),
      );
      expect(movementRepo.save).not.toHaveBeenCalled();
    });

    it('al editar también se normaliza el serial, y uno en blanco es 400', async () => {
      cylinderRepo.findOne.mockResolvedValue(makeCylinder());
      await service.update('cyl-1', { serial: ' sn-nuevo ' }, DIST);
      expect(cylinderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ serial: 'SN-NUEVO' }),
      );

      cylinderRepo.save.mockClear();
      await expect(
        service.update('cyl-1', { serial: '  ' }, DIST),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });

    it('la fabricación no puede ser posterior al vencimiento del envase (400)', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ expiresAt: new Date('2026-01-01T00:00:00Z') }),
      );
      await expect(
        service.update(
          'cyl-1',
          { manufacturedAt: new Date('2026-06-01T00:00:00Z') },
          DIST,
        ),
      ).rejects.toThrow('fabricación no puede ser posterior al vencimiento');
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });

    it('serial duplicado => 409', async () => {
      cylinderRepo.findOne.mockResolvedValue(makeCylinder());
      cylinderRepo.save.mockRejectedValue({ code: '23505' });
      await expect(
        service.update('cyl-1', { serial: 'SN-X' }, DIST),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('un envase dado de baja no se edita (409)', async () => {
      cylinderRepo.findOne.mockResolvedValue(
        makeCylinder({ state: CylinderState.RETIRED }),
      );
      await expect(
        service.update('cyl-1', { serial: 'SN-X' }, DIST),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('retire', () => {
    it('desde IN_DEPOT pasa a RETIRED y registra el motivo en el movimiento', async () => {
      cylinderRepo.findOne.mockResolvedValue(makeCylinder());
      await service.retire('cyl-1', 'prueba vencida', DIST, 'admin-1');
      expect(cylinderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ state: CylinderState.RETIRED }),
      );
      expect(movementRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fromState: CylinderState.IN_DEPOT,
          toState: CylinderState.RETIRED,
          actorUserId: 'admin-1',
          note: 'Baja: prueba vencida',
        }),
      );
    });

    it.each([
      CylinderState.WITH_CUSTOMER,
      CylinderState.DISPATCHED,
      CylinderState.FILLED,
      CylinderState.RETIRED,
    ])('desde %s se rechaza y no persiste', async (state) => {
      cylinderRepo.findOne.mockResolvedValue(makeCylinder({ state }));
      await expect(service.retire('cyl-1', 'x', DIST)).rejects.toBeInstanceOf(
        InvalidCylinderTransitionError,
      );
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });

    it('/transition no admite RETIRED (la baja exige motivo)', async () => {
      await expect(
        service.transition('cyl-1', { toState: CylinderState.RETIRED }, DIST),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un envase dado de baja no se asigna a pedidos', async () => {
      orderRepo.findParaDespacho.mockResolvedValue({
        customerId: 'c',
        status: OrderStatus.ACCEPTED,
        deliveryId: null,
      });
      lockQb.getMany.mockResolvedValue([
        makeCylinder({ state: CylinderState.RETIRED }),
      ]);
      await expect(
        service.assignToOrder('o1', ['SN-001'], DIST),
      ).rejects.toBeInstanceOf(InvalidCylinderTransitionError);
    });
  });

  describe('concurrencia y producto', () => {
    it('retire y transition leen el envase con lock pesimista', async () => {
      cylinderRepo.findOne.mockImplementation(() =>
        Promise.resolve(makeCylinder()),
      );
      await service.retire('cyl-1', 'x', DIST);
      await service.transition(
        'cyl-1',
        { toState: CylinderState.FILLED } as TransitionCylinderDto,
        DIST,
      );
      expect(lockQb.setLock).toHaveBeenCalledTimes(2);
      expect(lockQb.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('alta y edición validan que el producto sea de la distribuidora', async () => {
      gasCylinders.findOne.mockRejectedValue(new NotFoundException('x'));
      await expect(
        service.create(
          { serial: 'S', gasCylinderId: 'g-ajena' } as CreateCylinderDto,
          DIST,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.update('cyl-1', { gasCylinderId: 'g-ajena' }, DIST),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(gasCylinders.findOne).toHaveBeenCalledWith('g-ajena', DIST);
      expect(cylinderRepo.save).not.toHaveBeenCalled();
    });
  });
});
