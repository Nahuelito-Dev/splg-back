import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import {
  ChangeOrderAddressUseCase,
  MENSAJE_EXPRESS_NO_CAMBIA,
  MENSAJE_MISMA_DIRECCION,
  MENSAJE_PEDIDO_YA_SALIO,
  MENSAJE_RECARGO_DISTINTO,
} from './change-order-address.use-case';
import { CreateOrderUseCase } from './create-order.use-case';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { UserAddressService } from '../../user-address/user-address.service';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentType,
} from '../entities/order.entity';
import { OrderAddressChange } from '../entities/order-address-change.entity';
import { OrderStatusHistory } from '../entities/order-status-history.entity';
import { RedisService } from '../../redis/redis.service';

/**
 * CU-127: el cliente dueño cambia la dirección de un pedido pendiente o
 * aceptado. Cobertura y recargo se revalidan; en línea con recargo distinto se
 * rechaza, en efectivo se recalcula; el cambio queda asentado.
 */
describe('ChangeOrderAddressUseCase', () => {
  let useCase: ChangeOrderAddressUseCase;
  let manager: {
    createQueryBuilder: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
  };
  let locked: Order | null;
  let ofertasVivas: Array<{ driverId: string }>;
  let create: {
    resolverZona: jest.Mock;
    calcularTotales: jest.Mock;
    porcentajeDeRecargoDelPedido: jest.Mock;
  };
  let addresses: { buscarDelUsuario: jest.Mock };
  let orders: { findByIdFull: jest.Mock };
  let realtime: {
    notifyAdmins: jest.Mock;
    notifyDriverOrderAddressChanged: jest.Mock;
    notifyDriverOrderCancelled: jest.Mock;
  };
  let orquestador: { offerToNextDriver: jest.Mock };

  const direccionNueva = {
    addressId: 'a2',
    location: { type: 'Point', coordinates: [-55.9, -27.3] },
  };

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'o1',
      customerId: 'c1',
      distributorId: 'd1',
      addressId: 'a1',
      status: OrderStatus.PENDING,
      deliveryId: null,
      delivery: null,
      paymentMethod: PaymentMethod.CASH,
      paymentType: PaymentType.CASH,
      subtotalItems: 1000,
      totalAmount: 1000,
      zoneSurchargeAmount: 0,
      depositAmount: 0,
      depositPaid: false,
      ...over,
    }) as unknown as Order;

  /** `calcularTotales` con un recargo fijo de zona. */
  const conRecargo = (monto: number) =>
    create.calcularTotales.mockImplementation((sub: number) => ({
      totalAmount: new Decimal(sub).plus(monto),
      zoneSurchargeAmount: new Decimal(monto),
      paymentSurchargeAmount: new Decimal(0),
    }));

  beforeEach(() => {
    locked = makeOrder();
    ofertasVivas = [];
    const qb = {
      setLock: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(locked)),
    };
    manager = {
      createQueryBuilder: jest.fn(() => qb),
      save: jest.fn((o: unknown) => Promise.resolve(o)),
      create: jest.fn((_: unknown, o: unknown) => o),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn(() => Promise.resolve(ofertasVivas)),
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    create = {
      resolverZona: jest.fn().mockResolvedValue(null),
      porcentajeDeRecargoDelPedido: jest.fn().mockResolvedValue(0),
      calcularTotales: jest.fn((sub: number) => ({
        totalAmount: new Decimal(sub),
        zoneSurchargeAmount: new Decimal(0),
        paymentSurchargeAmount: new Decimal(0),
      })),
    };
    addresses = {
      buscarDelUsuario: jest.fn().mockResolvedValue(direccionNueva),
    };
    orders = { findByIdFull: jest.fn((id: string) => Promise.resolve({ id })) };
    realtime = {
      notifyAdmins: jest.fn(),
      notifyDriverOrderAddressChanged: jest.fn(),
      notifyDriverOrderCancelled: jest.fn(),
    };
    orquestador = { offerToNextDriver: jest.fn().mockResolvedValue(null) };
    useCase = new ChangeOrderAddressUseCase(
      {
        transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)),
      } as unknown as DataSource,
      create as unknown as CreateOrderUseCase,
      addresses as unknown as UserAddressService,
      orders as unknown as OrderRepositoryPort,
      realtime as unknown as RealtimeDispatchPort,
      orquestador as unknown as DispatchOrchestratorService,
      {
        withLock: jest.fn(
          async (_k: string, _t: number, fn: () => unknown) => ({
            obtenido: true,
            valor: await fn(),
          }),
        ),
      } as unknown as RedisService,
    );
  });

  const cambiar = (distributorId: string | null = 'd1') =>
    useCase.execute(
      'o1',
      { addressId: 'a2', reason: 'me mudé' },
      'c1',
      distributorId,
    );

  describe('pedido express (CU-149)', () => {
    it('no cambia de dirección: 409 claro y no escribe nada', async () => {
      locked = makeOrder({
        deliveryMode: OrderDeliveryMode.EXPRESS,
        expressSurchargeAmount: 1500,
      });

      await expect(cambiar()).rejects.toThrow(MENSAJE_EXPRESS_NO_CAMBIA);
      await expect(cambiar()).rejects.toBeInstanceOf(ConflictException);
      expect(addresses.buscarDelUsuario).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
      expect(orquestador.offerToNextDriver).not.toHaveBeenCalled();
    });

    it('el pedido que ya pasó al reparto común sí cambia, sin arrastrar el recargo descontado', async () => {
      locked = makeOrder({
        deliveryMode: OrderDeliveryMode.STANDARD,
        expressSurchargeAmount: 1500,
      });

      await cambiar();

      expect(create.calcularTotales).toHaveBeenCalledWith(1000, null, 0, 0);
    });

    it('recalcula con el % del pedido, no con el vigente: un cambio del parámetro no altera pedidos existentes', async () => {
      create.porcentajeDeRecargoDelPedido.mockResolvedValue(7.5);
      locked = makeOrder({ deliveryMode: OrderDeliveryMode.STANDARD });

      await cambiar();

      expect(create.porcentajeDeRecargoDelPedido).toHaveBeenCalledWith(
        locked,
        PaymentMethod.CASH,
      );
      expect(create.calcularTotales).toHaveBeenCalledWith(1000, null, 7.5, 0);
      expect(locked?.paymentSurchargePercentage).toBe(7.5);
    });
  });

  it('pendiente: guarda la dirección y el punto, asienta el cambio y vuelve a ofrecer', async () => {
    await cambiar();

    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        addressId: 'a2',
        deliveryPoint: direccionNueva.location,
      }),
    );
    expect(manager.create).toHaveBeenCalledWith(OrderAddressChange, {
      orderId: 'o1',
      fromAddressId: 'a1',
      toAddressId: 'a2',
      changedByUserId: 'c1',
      reason: 'me mudé',
    });
    expect(manager.insert).toHaveBeenCalledWith(
      OrderStatusHistory,
      expect.objectContaining({
        orderId: 'o1',
        reason: expect.stringContaining('me mudé') as unknown as string,
      }),
    );
    expect(realtime.notifyAdmins).toHaveBeenCalledWith(
      'order:address-changed',
      expect.objectContaining({ orderId: 'o1', toAddressId: 'a2' }),
      'd1',
    );
    expect(orquestador.offerToNextDriver).toHaveBeenCalled();
    expect(realtime.notifyDriverOrderAddressChanged).not.toHaveBeenCalled();
  });

  it('pendiente: vence las ofertas vivas y avisa a esos choferes', async () => {
    ofertasVivas = [{ driverId: 'chofer-1' }];
    await cambiar();
    expect(manager.update).toHaveBeenCalled();
    expect(realtime.notifyDriverOrderCancelled).toHaveBeenCalledWith(
      'chofer-1',
      expect.objectContaining({ orderId: 'o1' }),
    );
  });

  it('aceptado: avisa al chofer asignado por su id de usuario y no vuelve a ofrecer', async () => {
    locked = makeOrder({
      status: OrderStatus.ACCEPTED,
      deliveryId: 'del-1',
    });
    manager.findOne.mockResolvedValue({ userId: 'chofer-user' });
    await cambiar();
    expect(realtime.notifyDriverOrderAddressChanged).toHaveBeenCalledWith(
      'chofer-user',
      expect.objectContaining({ orderId: 'o1' }),
    );
    expect(orquestador.offerToNextDriver).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.ON_THE_WAY, OrderStatus.DELIVERED])(
    'un pedido %s ya salió: 409 sin escribir',
    async (status) => {
      locked = makeOrder({ status });
      await expect(cambiar()).rejects.toThrow(
        new ConflictException(MENSAJE_PEDIDO_YA_SALIO),
      );
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it.each([OrderStatus.CANCELLED, OrderStatus.RESERVED])(
    'un pedido %s tampoco admite el cambio (409)',
    async (status) => {
      locked = makeOrder({ status });
      await expect(cambiar()).rejects.toBeInstanceOf(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it('un pedido de otro cliente o de otra distribuidora es 404', async () => {
    locked = makeOrder({ customerId: 'otro' });
    await expect(cambiar()).rejects.toBeInstanceOf(NotFoundException);
    locked = makeOrder();
    await expect(cambiar('otra')).rejects.toBeInstanceOf(NotFoundException);
    locked = null;
    await expect(cambiar()).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('una dirección que no es del cliente es 404 y no escribe', async () => {
    addresses.buscarDelUsuario.mockResolvedValue(null);
    await expect(cambiar()).rejects.toBeInstanceOf(NotFoundException);
    expect(addresses.buscarDelUsuario).toHaveBeenCalledWith('a2', 'c1');
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('la misma dirección que ya tiene es 400', async () => {
    addresses.buscarDelUsuario.mockResolvedValue({ addressId: 'a1' });
    await expect(cambiar()).rejects.toThrow(
      new BadRequestException(MENSAJE_MISMA_DIRECCION),
    );
  });

  it('fuera de cobertura: el error de la zona sube y no se escribe nada', async () => {
    create.resolverZona.mockRejectedValue(
      new BadRequestException('fuera de la zona de cobertura'),
    );
    await expect(cambiar()).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  describe('recargo de la zona nueva', () => {
    const zona = { id: 'z2', name: 'Norte', type: 'fixed', value: 300 };

    it('efectivo: recalcula el total y actualiza el snapshot de la zona', async () => {
      create.resolverZona.mockResolvedValue(zona);
      conRecargo(300);
      await cambiar();
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 1300,
          zoneSurchargeAmount: 300,
          coverageZoneId: 'z2',
          zoneName: 'Norte',
        }),
      );
    });

    it('efectivo: con seña paga el total no puede quedar por debajo de la seña', async () => {
      locked = makeOrder({
        depositPaid: true,
        depositAmount: 900,
        zoneSurchargeAmount: 500,
        totalAmount: 1500,
      });
      conRecargo(0);
      create.calcularTotales.mockReturnValue({
        totalAmount: new Decimal(800),
        zoneSurchargeAmount: new Decimal(0),
        paymentSurchargeAmount: new Decimal(0),
      });
      await expect(cambiar()).rejects.toBeInstanceOf(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('en línea con el recargo distinto: 409 y no cambia nada', async () => {
      locked = makeOrder({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentType: PaymentType.ONLINE,
      });
      create.resolverZona.mockResolvedValue(zona);
      conRecargo(300);
      await expect(cambiar()).rejects.toThrow(
        new ConflictException(MENSAJE_RECARGO_DISTINTO),
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('en línea con el mismo recargo: cambia la dirección y conserva el total', async () => {
      locked = makeOrder({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentType: PaymentType.ONLINE,
        zoneSurchargeAmount: 300,
        totalAmount: 1300,
      });
      create.resolverZona.mockResolvedValue(zona);
      conRecargo(300);
      await cambiar();
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          addressId: 'a2',
          totalAmount: 1300,
          coverageZoneId: 'z2',
        }),
      );
    });
  });

  it('si otro proceso tiene el pedido tomado, 409', async () => {
    const sinLock = new ChangeOrderAddressUseCase(
      {} as DataSource,
      create as unknown as CreateOrderUseCase,
      addresses as unknown as UserAddressService,
      orders as unknown as OrderRepositoryPort,
      realtime as unknown as RealtimeDispatchPort,
      orquestador as unknown as DispatchOrchestratorService,
      {
        withLock: jest.fn().mockResolvedValue({ obtenido: false }),
      } as unknown as RedisService,
    );
    await expect(
      sinLock.execute('o1', { addressId: 'a2' }, 'c1', 'd1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
