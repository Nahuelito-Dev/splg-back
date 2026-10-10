import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { UpdateOrderUseCase } from './update-order.use-case';
import { CreateOrderUseCase } from './create-order.use-case';
import { UserAddressService } from '../../user-address/user-address.service';
import { TimeSlotService } from '../../time-slot/time-slot.service';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { OrderItem } from '../entities/order-item.entity';

/**
 * Edición de un pedido pendiente: sólo en `pending` sin chofer y sin pago
 * online (409 si no), dentro de la transacción con lock; los renglones nuevos
 * devuelven el stock viejo y reservan el nuevo por el camino del alta.
 */
describe('UpdateOrderUseCase', () => {
  let useCase: UpdateOrderUseCase;
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    isTransactionActive: boolean;
    manager: {
      createQueryBuilder: jest.Mock;
      save: jest.Mock;
      remove: jest.Mock;
      create: jest.Mock;
      find: jest.Mock;
      update: jest.Mock;
    };
  };
  let ofertasVivas: Array<{ driverId: string }>;
  let orquestador: { offerToNextDriver: jest.Mock };
  let locked: Order | null;
  let create: {
    resolverZona: jest.Mock;
    reservarRenglones: jest.Mock;
    calcularTotales: jest.Mock;
  };
  let addresses: { buscarDelUsuario: jest.Mock };
  let slots: {
    assertSlotAvailableTx: jest.Mock;
    assertSlotUsableTx: jest.Mock;
  };
  let stock: { restituirStock: jest.Mock; bloquearEnOrden: jest.Mock };
  let orders: { findByIdFull: jest.Mock };
  let realtime: {
    notifyAdmins: jest.Mock;
    notifyCustomer: jest.Mock;
    notifyDriverOrderCancelled: jest.Mock;
  };

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'o1',
      customerId: 'c1',
      distributorId: 'd1',
      addressId: 'a1',
      status: OrderStatus.PENDING,
      deliveryId: null,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      timeSlotId: null,
      scheduledDate: null,
      zoneSurchargeType: null,
      zoneSurchargeValue: null,
      subtotalItems: 1000,
      totalAmount: 1000,
      zoneSurchargeAmount: 0,
      items: [{ gasCylinderId: 'g1', quantity: 1 }],
      ...over,
    }) as unknown as Order;

  beforeEach(() => {
    locked = makeOrder();
    const qb = {
      setLock: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(locked)),
    };
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: true,
      manager: {
        createQueryBuilder: jest.fn(() => qb),
        save: jest.fn((o: unknown) => Promise.resolve(o)),
        remove: jest.fn().mockResolvedValue(undefined),
        create: jest.fn((_: unknown, o: unknown) => o),
        find: jest.fn((entidad: unknown) =>
          Promise.resolve(entidad === OrderItem ? locked?.items : ofertasVivas),
        ),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    create = {
      resolverZona: jest.fn().mockResolvedValue(null),
      reservarRenglones: jest.fn().mockResolvedValue({
        orderItems: [{ gasCylinderId: 'g2', quantity: 3 }] as OrderItem[],
        checkoutItems: [],
        subtotalItems: new Decimal(3000),
      }),
      calcularTotales: jest.fn((sub: number | Decimal) => ({
        totalAmount: new Decimal(sub),
        zoneSurchargeAmount: new Decimal(0),
      })),
    };
    addresses = { buscarDelUsuario: jest.fn() };
    slots = {
      assertSlotAvailableTx: jest.fn().mockResolvedValue(undefined),
      assertSlotUsableTx: jest.fn().mockResolvedValue(undefined),
    };
    stock = {
      restituirStock: jest.fn().mockResolvedValue(undefined),
      bloquearEnOrden: jest.fn().mockResolvedValue(undefined),
    };
    orders = { findByIdFull: jest.fn((id: string) => Promise.resolve({ id })) };
    ofertasVivas = [];
    orquestador = { offerToNextDriver: jest.fn().mockResolvedValue(null) };
    realtime = {
      notifyAdmins: jest.fn(),
      notifyCustomer: jest.fn(),
      notifyDriverOrderCancelled: jest.fn(),
    };
    useCase = new UpdateOrderUseCase(
      {
        createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      } as unknown as DataSource,
      create as unknown as CreateOrderUseCase,
      addresses as unknown as UserAddressService,
      slots as unknown as TimeSlotService,
      stock as unknown as GasCylinderService,
      orders as unknown as OrderRepositoryPort,
      realtime as unknown as RealtimeDispatchPort,
      orquestador as unknown as DispatchOrchestratorService,
    );
  });

  it.each([
    OrderStatus.ACCEPTED,
    OrderStatus.ON_THE_WAY,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
    OrderStatus.RESERVED,
  ])('un pedido %s no se edita (409) y no toca stock', async (status) => {
    locked = makeOrder({ status });
    await expect(
      useCase.execute('o1', { notes: 'x', items: [] }, 'u1', 'd1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(stock.restituirStock).not.toHaveBeenCalled();
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('un pedido pendiente pero con chofer asignado no se edita (409)', async () => {
    locked = makeOrder({ deliveryId: 'del-1' });
    await expect(
      useCase.execute('o1', { notes: 'x' }, 'u1', 'd1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('un pedido con pago online no se edita (409) ni se pasa a MercadoPago (400)', async () => {
    locked = makeOrder({ paymentMethod: PaymentMethod.MERCADOPAGO });
    await expect(
      useCase.execute('o1', { notes: 'x' }, 'u1', 'd1'),
    ).rejects.toBeInstanceOf(ConflictException);
    locked = makeOrder();
    await expect(
      useCase.execute(
        'o1',
        { paymentMethod: PaymentMethod.MERCADOPAGO },
        'u1',
        'd1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un pedido de otra distribuidora es 404', async () => {
    await expect(
      useCase.execute('o1', { notes: 'x' }, 'u1', 'otra'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('con renglones nuevos devuelve el stock viejo, reserva el nuevo y recalcula', async () => {
    await useCase.execute(
      'o1',
      { items: [{ gasCylinderId: 'g2', quantity: 3 }] },
      'u1',
      'd1',
    );
    expect(stock.restituirStock).toHaveBeenCalledWith(queryRunner.manager, [
      { gasCylinderId: 'g1', quantity: 1 },
    ]);
    // los renglones reemplazados se borran con `remove` (queda en la auditoría)
    expect(queryRunner.manager.remove).toHaveBeenCalledWith(OrderItem, [
      { gasCylinderId: 'g1', quantity: 1 },
    ]);
    expect(create.reservarRenglones).toHaveBeenCalledWith(
      queryRunner.manager,
      [{ gasCylinderId: 'g2', quantity: 3 }],
      'd1',
    );
    expect(queryRunner.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ subtotalItems: 3000, totalAmount: 3000 }),
    );
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(realtime.notifyAdmins).toHaveBeenCalledWith(
      'order:updated',
      expect.objectContaining({ orderId: 'o1' }),
      'd1',
    );
  });

  it('sin renglones no toca el stock', async () => {
    await useCase.execute('o1', { notes: 'nueva' }, 'u1', 'd1');
    expect(stock.restituirStock).not.toHaveBeenCalled();
    expect(queryRunner.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'nueva' }),
    );
  });

  it('una dirección ajena al cliente es 404', async () => {
    addresses.buscarDelUsuario.mockResolvedValue(null);
    await expect(
      useCase.execute('o1', { addressId: 'a2' }, 'u1', 'd1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(addresses.buscarDelUsuario).toHaveBeenCalledWith('a2', 'c1');
  });

  it('valida el cupo sólo si cambia la franja o la fecha', async () => {
    locked = makeOrder({ timeSlotId: 's1', scheduledDate: '2030-01-01' });
    await useCase.execute('o1', { notes: 'x' }, 'u1', 'd1');
    expect(slots.assertSlotAvailableTx).not.toHaveBeenCalled();
    await useCase.execute('o1', { scheduledDate: '2030-01-02' }, 'u1', 'd1');
    expect(slots.assertSlotAvailableTx).toHaveBeenCalledWith(
      queryRunner.manager,
      's1',
      '2030-01-02',
      'd1',
    );
  });

  it('releyó los renglones después del lock: devuelve el stock de los vigentes', async () => {
    await useCase.execute(
      'o1',
      { items: [{ gasCylinderId: 'g2', quantity: 3 }] },
      'u1',
      'd1',
    );
    expect(queryRunner.manager.find).toHaveBeenCalledWith(OrderItem, {
      where: { orderId: 'o1' },
    });
  });

  it('editar sólo notas o franja no recalcula el total', async () => {
    await useCase.execute('o1', { notes: 'a' }, 'u1', 'd1');
    await useCase.execute('o1', { timeSlotId: null }, 'u1', 'd1');
    expect(create.calcularTotales).not.toHaveBeenCalled();
    expect(queryRunner.manager.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeSlotId: null, totalAmount: 1000 }),
    );
  });

  it('sin snapshot de zona pero con recargo guardado, lo conserva como fijo', async () => {
    locked = makeOrder({ zoneSurchargeAmount: 300 });
    await useCase.execute(
      'o1',
      { items: [{ gasCylinderId: 'g2', quantity: 1 }] },
      'u1',
      'd1',
    );
    expect(create.calcularTotales).toHaveBeenCalledWith(
      expect.anything(),
      { type: 'fixed', value: 300 },
      PaymentMethod.CASH,
    );
  });

  it('cambiar sólo la franja de una fecha ya pasada pide fecha nueva (400)', async () => {
    locked = makeOrder({ timeSlotId: 's1', scheduledDate: '2020-01-01' });
    await expect(
      useCase.execute('o1', { timeSlotId: 's2' }, 'u1', 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(slots.assertSlotAvailableTx).not.toHaveBeenCalled();
  });

  it('con una oferta viva: la vence en la transacción, avisa al chofer, al cliente y vuelve a ofrecer', async () => {
    ofertasVivas = [{ driverId: 'chofer-1' }];
    await useCase.execute(
      'o1',
      { items: [{ gasCylinderId: 'g2', quantity: 3 }] },
      'u1',
      'd1',
    );
    expect(queryRunner.manager.update).toHaveBeenCalled();
    expect(realtime.notifyDriverOrderCancelled).toHaveBeenCalledWith(
      'chofer-1',
      expect.objectContaining({ orderId: 'o1' }),
    );
    expect(realtime.notifyCustomer).toHaveBeenCalledWith(
      'c1',
      'order:updated',
      expect.objectContaining({ totalAmount: 3000, previousTotalAmount: 1000 }),
    );
    expect(orquestador.offerToNextDriver).toHaveBeenCalledTimes(1);
  });

  it('editar sólo notas no toca las ofertas ni vuelve a despachar', async () => {
    ofertasVivas = [{ driverId: 'chofer-1' }];
    await useCase.execute('o1', { notes: 'x' }, 'u1', 'd1');
    expect(queryRunner.manager.update).not.toHaveBeenCalled();
    expect(orquestador.offerToNextDriver).not.toHaveBeenCalled();
  });

  it('R3-3: toma el lock de la unión de ids viejos y nuevos ANTES de devolver y reservar', async () => {
    await useCase.execute(
      'o1',
      { items: [{ gasCylinderId: 'g2', quantity: 3 }] },
      'u1',
      'd1',
    );
    expect(stock.bloquearEnOrden).toHaveBeenCalledWith(queryRunner.manager, [
      'g1',
      'g2',
    ]);
    expect(stock.bloquearEnOrden.mock.invocationCallOrder[0]).toBeLessThan(
      stock.restituirStock.mock.invocationCallOrder[0],
    );
    expect(stock.restituirStock.mock.invocationCallOrder[0]).toBeLessThan(
      create.reservarRenglones.mock.invocationCallOrder[0],
    );
  });

  it('R3-2: una franja nueva sin fecha igual se valida (existencia, distribuidora, activa)', async () => {
    slots.assertSlotUsableTx.mockRejectedValue(new BadRequestException('x'));
    await expect(
      useCase.execute('o1', { timeSlotId: 'ajena' }, 'u1', 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(slots.assertSlotUsableTx).toHaveBeenCalledWith(
      queryRunner.manager,
      'ajena',
      'd1',
    );
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
  });
});
