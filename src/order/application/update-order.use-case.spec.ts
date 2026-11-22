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
import { OrderStatusHistory } from '../entities/order-status-history.entity';
import { RedisService } from '../../redis/redis.service';
import { conRespuestaVigilada } from '../../common/interceptors/respuesta-incompleta';
import { RoleType } from '../../common/constants/role-type.enum';

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
      insert: jest.Mock;
    };
  };
  let ofertasVivas: Array<{ driverId: string }>;
  let orquestador: { offerToNextDriver: jest.Mock };
  let redis: { withLock: jest.Mock };
  let locked: Order | null;
  let create: {
    resolverZona: jest.Mock;
    reservarRenglones: jest.Mock;
    calcularTotales: jest.Mock;
    porcentajeDeRecargoDelPedido: jest.Mock;
  };
  let addresses: { buscarDelUsuario: jest.Mock };
  let slots: {
    assertSlotAvailableTx: jest.Mock;
    assertSlotUsableTx: jest.Mock;
  };
  let stock: { reajustarReserva: jest.Mock; bloquearEnOrden: jest.Mock };
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
        insert: jest.fn().mockResolvedValue(undefined),
      },
    };
    create = {
      resolverZona: jest.fn().mockResolvedValue(null),
      reservarRenglones: jest.fn().mockResolvedValue({
        orderItems: [{ gasCylinderId: 'g2', quantity: 3 }] as OrderItem[],
        checkoutItems: [],
        subtotalItems: new Decimal(3000),
        containerCandidates: [],
      }),
      porcentajeDeRecargoDelPedido: jest.fn().mockResolvedValue(0),
      calcularTotales: jest.fn((sub: number | Decimal) => ({
        totalAmount: new Decimal(sub),
        zoneSurchargeAmount: new Decimal(0),
        paymentSurchargeAmount: new Decimal(0),
      })),
    };
    addresses = { buscarDelUsuario: jest.fn() };
    slots = {
      assertSlotAvailableTx: jest.fn().mockResolvedValue(undefined),
      assertSlotUsableTx: jest.fn().mockResolvedValue(undefined),
    };
    stock = {
      reajustarReserva: jest.fn().mockResolvedValue(undefined),
      bloquearEnOrden: jest.fn().mockResolvedValue(undefined),
    };
    orders = { findByIdFull: jest.fn((id: string) => Promise.resolve({ id })) };
    ofertasVivas = [];
    orquestador = { offerToNextDriver: jest.fn().mockResolvedValue(null) };
    redis = {
      withLock: jest.fn(async (_k: string, _t: number, fn: () => unknown) => ({
        obtenido: true,
        valor: await fn(),
      })),
    };
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
      redis as unknown as RedisService,
      { envasesACobrar: jest.fn().mockResolvedValue([]) } as never,
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
    expect(stock.reajustarReserva).not.toHaveBeenCalled();
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('un pedido pendiente pero con chofer asignado no se edita (409)', async () => {
    locked = makeOrder({ deliveryId: 'del-1' });
    await expect(
      useCase.execute('o1', { notes: 'x' }, 'u1', 'd1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('pasar un pedido a transferencia es 400 PAYMENT_METHOD_NOT_ACCEPTED; el que ya la tiene la conserva', async () => {
    locked = makeOrder({ paymentMethod: PaymentMethod.CASH });
    const error = await useCase
      .execute('o1', { paymentMethod: PaymentMethod.TRANSFER }, 'u1', 'd1')
      .then(
        () => null,
        (e: unknown) => e as BadRequestException,
      );
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error?.getResponse()).toMatchObject({
      message:
        'La distribuidora ya no acepta transferencias. Elegí efectivo o Mercado Pago.',
      code: 'PAYMENT_METHOD_NOT_ACCEPTED',
    });
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();

    // Un pedido viejo con transferencia se sigue editando sin tocar el medio.
    locked = makeOrder({ paymentMethod: PaymentMethod.TRANSFER });
    await expect(
      useCase.execute('o1', { notes: 'x' }, 'u1', 'd1'),
    ).resolves.toBeDefined();
    locked = makeOrder({ paymentMethod: PaymentMethod.TRANSFER });
    await expect(
      useCase.execute(
        'o1',
        { paymentMethod: PaymentMethod.TRANSFER, notes: 'y' },
        'u1',
        'd1',
      ),
    ).resolves.toBeDefined();
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

  it('con renglones nuevos ajusta la reserva por la diferencia neta, repondera los renglones sin volver a reservar y recalcula', async () => {
    await useCase.execute(
      'o1',
      { items: [{ gasCylinderId: 'g2', quantity: 3 }] },
      'u1',
      'd1',
    );
    expect(stock.reajustarReserva).toHaveBeenCalledWith(
      queryRunner.manager,
      [{ gasCylinderId: 'g1', quantity: 1 }],
      [{ gasCylinderId: 'g2', quantity: 3 }],
    );
    // los renglones reemplazados se borran con `remove` (queda en la auditoría)
    expect(queryRunner.manager.remove).toHaveBeenCalledWith(OrderItem, [
      { gasCylinderId: 'g1', quantity: 1 },
    ]);
    expect(create.reservarRenglones).toHaveBeenCalledWith(
      queryRunner.manager,
      [{ gasCylinderId: 'g2', quantity: 3 }],
      'd1',
      true,
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
    expect(stock.reajustarReserva).not.toHaveBeenCalled();
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

  describe('espera de chofer (available_since)', () => {
    const viejo = new Date('2026-01-01T10:00:00Z');
    const guardado = () =>
      (queryRunner.manager.save.mock.calls.at(-1) as [Order])[0];

    it('editar sólo las notas no la reinicia', async () => {
      locked = makeOrder({ availableSince: viejo });
      await useCase.execute('o1', { notes: 'otra nota' }, 'u1', 'd1');
      expect(guardado().availableSince).toBe(viejo);
    });

    it('cambiar la fecha agendada la reinicia', async () => {
      locked = makeOrder({ availableSince: viejo });
      await useCase.execute('o1', { scheduledDate: '2099-01-01' }, 'u1', 'd1');
      expect(guardado().scheduledDate).toBe('2099-01-01');
      expect(guardado().availableSince).not.toBe(viejo);
      expect(guardado().availableSince).toBeInstanceOf(Date);
    });
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
      0,
      0,
      0,
    );
  });

  it('una fecha nueva pasada es 400 aunque no haya franja', async () => {
    await expect(
      useCase.execute('o1', { scheduledDate: '2020-01-01' }, 'u1', 'd1'),
    ).rejects.toThrow('La fecha de entrega agendada no puede ser pasada');
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
  });

  it('cambiar sólo la franja de una fecha ya pasada pide fecha nueva (400)', async () => {
    locked = makeOrder({ timeSlotId: 's1', scheduledDate: '2020-01-01' });
    await expect(
      useCase.execute('o1', { timeSlotId: 's2' }, 'u1', 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(slots.assertSlotAvailableTx).not.toHaveBeenCalled();
  });

  describe('a las 22:30 ART (ya es el día siguiente en UTC)', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-10-11T01:30:00Z') });
    });
    afterEach(() => jest.useRealTimers());

    it('cambiar sólo la franja de un pedido agendado para HOY argentino es válido', async () => {
      locked = makeOrder({ timeSlotId: 's1', scheduledDate: '2026-10-10' });
      await expect(
        useCase.execute('o1', { timeSlotId: 's2' }, 'u1', 'd1'),
      ).resolves.toBeDefined();
      expect(slots.assertSlotAvailableTx).toHaveBeenCalled();
    });

    it('un pedido agendado para AYER argentino sigue pidiendo fecha nueva (400)', async () => {
      locked = makeOrder({ timeSlotId: 's1', scheduledDate: '2026-10-09' });
      await expect(
        useCase.execute('o1', { timeSlotId: 's2' }, 'u1', 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
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
      stock.reajustarReserva.mock.invocationCallOrder[0],
    );
    expect(stock.reajustarReserva.mock.invocationCallOrder[0]).toBeLessThan(
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

  describe('el cliente dueño edita su pedido', () => {
    const comoCliente = (dto: Parameters<UpdateOrderUseCase['execute']>[1]) =>
      useCase.execute('o1', dto, 'c1', null, RoleType.CUSTOMER);

    it('un pedido de otro cliente es 404 y no toca nada', async () => {
      await expect(
        useCase.execute(
          'o1',
          { notes: 'x' },
          'otro-cliente',
          null,
          RoleType.CUSTOMER,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('con chofer asignado responde 409 con el mensaje del repartidor', async () => {
      locked = makeOrder({ deliveryId: 'del-1' });
      await expect(comoCliente({ notes: 'x' })).rejects.toThrow(
        'El pedido ya fue tomado por un repartidor: no se puede modificar',
      );
      expect(stock.reajustarReserva).not.toHaveBeenCalled();
    });

    it('un pedido aceptado también es 409 por repartidor', async () => {
      locked = makeOrder({ status: OrderStatus.ACCEPTED });
      await expect(comoCliente({ notes: 'x' })).rejects.toThrow(
        'El pedido ya fue tomado por un repartidor: no se puede modificar',
      );
    });

    it('con un pago online generado responde 409 (medio de pago)', async () => {
      locked = makeOrder({ paymentMethod: PaymentMethod.MERCADOPAGO });
      await expect(
        comoCliente({ paymentMethod: PaymentMethod.CASH }),
      ).rejects.toThrow(/pago online/);
    });

    it('recalcula el total en el servidor y deja la anotación en el historial', async () => {
      const dto = {
        items: [{ gasCylinderId: 'g2', quantity: 3 }],
        precio: 1,
        totalAmount: 1,
      } as Parameters<UpdateOrderUseCase['execute']>[1];
      await comoCliente(dto);
      expect(create.reservarRenglones).toHaveBeenCalled();
      expect(locked?.totalAmount).toBe(3000);
      expect(queryRunner.manager.insert).toHaveBeenCalledWith(
        OrderStatusHistory,
        expect.objectContaining({
          fromStatus: OrderStatus.PENDING,
          toStatus: OrderStatus.PENDING,
          changedByUserId: 'c1',
          reason: expect.stringContaining(
            'Pedido modificado por el cliente: renglones. Total: 1000 → 3000',
          ) as string,
        }),
      );
    });

    it('guarda el recargo por medio de pago que calcula el servidor, junto con el total', async () => {
      create.calcularTotales.mockReturnValue({
        totalAmount: new Decimal(3300),
        zoneSurchargeAmount: new Decimal(0),
        paymentSurchargeAmount: new Decimal(300),
      });
      await comoCliente({
        items: [{ gasCylinderId: 'g2', quantity: 3 }],
      } as Parameters<UpdateOrderUseCase['execute']>[1]);
      expect(locked?.totalAmount).toBe(3300);
      expect(locked?.paymentSurchargeAmount).toBe(300);
    });

    it('guarda con el pedido el % que usó para recalcular (el del pedido o el vigente, según el medio)', async () => {
      create.porcentajeDeRecargoDelPedido.mockResolvedValue(7.5);
      await comoCliente({
        items: [{ gasCylinderId: 'g2', quantity: 3 }],
      } as Parameters<UpdateOrderUseCase['execute']>[1]);
      expect(create.porcentajeDeRecargoDelPedido).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: 'o1' }),
        PaymentMethod.CASH,
      );
      expect(create.calcularTotales).toHaveBeenCalledWith(
        expect.anything(),
        null,
        7.5,
        0,
        0,
      );
      expect(locked?.paymentSurchargePercentage).toBe(7.5);
    });

    it('el admin no deja anotación de cliente en el historial', async () => {
      await useCase.execute('o1', { notes: 'x' }, 'u1', 'd1');
      expect(queryRunner.manager.insert).not.toHaveBeenCalled();
    });
  });

  describe('despacho, repetidos, seña, sin cambios y relectura', () => {
    it('toma el lock del despacho del pedido y, si el despacho lo tiene, responde 409 sin escribir', async () => {
      await useCase.execute('o1', { notes: 'x' }, 'u1', 'd1');
      expect(redis.withLock).toHaveBeenCalledWith(
        'dispatch:offer:o1',
        expect.any(Number) as number,
        expect.any(Function) as () => unknown,
        expect.any(Number) as number,
      );
      redis.withLock.mockResolvedValueOnce({ obtenido: false });
      queryRunner.manager.save.mockClear();
      await expect(
        useCase.execute('o1', { notes: 'y' }, 'u1', 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('con la seña paga, un total por debajo de la seña es 409; por encima se permite', async () => {
      locked = makeOrder({ depositPaid: true, depositAmount: 2000 });
      await expect(
        useCase.execute(
          'o1',
          { items: [{ gasCylinderId: 'g2', quantity: 1 }] },
          'u1',
          'd1',
        ),
      ).resolves.toBeDefined();
      locked = makeOrder({ depositPaid: true, depositAmount: 5000 });
      await expect(
        useCase.execute(
          'o1',
          { items: [{ gasCylinderId: 'g2', quantity: 1 }] },
          'u1',
          'd1',
        ),
      ).rejects.toThrow(
        'El total no puede quedar por debajo de la seña ya pagada',
      );
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('el borde de la seña paga se compara con el total redondeado a 2 decimales, como la cotización', async () => {
      locked = makeOrder({ depositPaid: true, depositAmount: 100.09 });
      create.calcularTotales.mockReturnValueOnce({
        totalAmount: new Decimal('100.089'),
        zoneSurchargeAmount: new Decimal(0),
        paymentSurchargeAmount: new Decimal(0),
      });
      await expect(
        useCase.execute(
          'o1',
          { items: [{ gasCylinderId: 'g2', quantity: 1 }] },
          'u1',
          'd1',
        ),
      ).resolves.toBeDefined();
      locked = makeOrder({ depositPaid: true, depositAmount: 100.1 });
      create.calcularTotales.mockReturnValueOnce({
        totalAmount: new Decimal('100.089'),
        zoneSurchargeAmount: new Decimal(0),
        paymentSurchargeAmount: new Decimal(0),
      });
      await expect(
        useCase.execute(
          'o1',
          { items: [{ gasCylinderId: 'g2', quantity: 1 }] },
          'u1',
          'd1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('un PATCH sin cambios (vacío o con los mismos valores) no escribe, no anota ni avisa', async () => {
      locked = makeOrder({ notes: 'igual' });
      for (const dto of [
        {},
        { notes: 'igual' },
        { items: [{ gasCylinderId: 'g1', quantity: 1 }] },
        { paymentMethod: PaymentMethod.CASH, addressId: 'a1' },
      ]) {
        await useCase.execute('o1', dto, 'c1', null, RoleType.CUSTOMER);
      }
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(queryRunner.manager.insert).not.toHaveBeenCalled();
      expect(stock.reajustarReserva).not.toHaveBeenCalled();
      expect(realtime.notifyAdmins).not.toHaveBeenCalled();
      expect(orquestador.offerToNextDriver).not.toHaveBeenCalled();
    });

    it('si falla la relectura después del commit responde con lo guardado y marca la respuesta incompleta', async () => {
      orders.findByIdFull.mockRejectedValueOnce(new Error('base caída'));
      const { valor, incompleta } = await conRespuestaVigilada(() =>
        useCase.execute('o1', { notes: 'x' }, 'u1', 'd1'),
      );
      expect(valor).toBe(locked);
      expect(incompleta).toBe(true);
    });
  });
});
