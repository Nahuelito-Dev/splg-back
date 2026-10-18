import { DataSource } from 'typeorm';
import { ExpressDegradeService } from './express-degrade.service';
import { RefundsService } from '../../payments/application/refunds.service';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { NotificationPort } from '../domain/ports/notification.port';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
} from '../entities/order.entity';

describe('ExpressDegradeService (CU-149 pasos 7 y 8)', () => {
  let service: ExpressDegradeService;
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    isTransactionActive: boolean;
    manager: { createQueryBuilder: jest.Mock; save: jest.Mock };
  };
  let locked: Partial<Order> | null;
  let refunds: {
    registrarRecargoExpress: jest.Mock;
    reintegrarRecargoExpress: jest.Mock;
  };
  let realtime: { notifyCustomer: jest.Mock; notifyAdmins: jest.Mock };
  let notifications: { sendOrderNoticePush: jest.Mock };

  const expressPendiente = (): Partial<Order> => ({
    orderId: 'ord-1',
    customerId: 'cus-1',
    distributorId: 'dist-1',
    status: OrderStatus.PENDING,
    deliveryId: null,
    deliveryMode: OrderDeliveryMode.EXPRESS,
    expressSurchargeAmount: 1500,
    totalAmount: 5500,
  });

  beforeEach(() => {
    locked = expressPendiente();
    const qb = {
      setLock: jest.fn().mockReturnThis(),
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
      },
    };
    refunds = {
      // Por omisión es un pedido en efectivo: no hay pago de pasarela que devolver.
      registrarRecargoExpress: jest.fn().mockResolvedValue(false),
      reintegrarRecargoExpress: jest.fn().mockResolvedValue([]),
    };
    realtime = { notifyCustomer: jest.fn(), notifyAdmins: jest.fn() };
    notifications = {
      sendOrderNoticePush: jest.fn().mockResolvedValue(undefined),
    };
    service = new ExpressDegradeService(
      {
        createQueryRunner: jest.fn(() => queryRunner),
      } as unknown as DataSource,
      refunds as unknown as RefundsService,
      realtime as unknown as RealtimeDispatchPort,
      notifications as unknown as NotificationPort,
    );
  });

  it('descuenta el recargo del total, conserva el monto en el pedido y pasa a reparto común', async () => {
    const pase = await service.pasarAlRepartoComun('ord-1');

    expect(pase).toMatchObject({
      surchargeRemoved: 1500,
      total: 4000,
      refundRequested: false,
    });
    const [[guardado]] = queryRunner.manager.save.mock.calls as unknown as [
      [Order],
    ];
    expect(guardado.deliveryMode).toBe(OrderDeliveryMode.STANDARD);
    expect(guardado.totalAmount).toBe(4000);
    expect(guardado.expressSurchargeAmount).toBe(1500);
    expect(guardado.expressDegradedAt).toBeInstanceOf(Date);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('si el cliente pagó en línea registra la solicitud DENTRO de la transacción (outbox) y la ejecuta después del commit', async () => {
    refunds.registrarRecargoExpress.mockResolvedValue(true);
    refunds.reintegrarRecargoExpress.mockResolvedValue([
      { refundId: 'r1', status: 'succeeded' },
    ]);

    const pase = await service.pasarAlRepartoComun('ord-1');

    expect(refunds.registrarRecargoExpress).toHaveBeenCalledWith(
      queryRunner.manager,
      'ord-1',
      1500,
    );
    expect(
      refunds.registrarRecargoExpress.mock.invocationCallOrder[0],
    ).toBeLessThan(queryRunner.commitTransaction.mock.invocationCallOrder[0]);
    expect(refunds.reintegrarRecargoExpress).toHaveBeenCalledWith(
      'ord-1',
      1500,
    );
    expect(
      refunds.reintegrarRecargoExpress.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      queryRunner.commitTransaction.mock.invocationCallOrder[0],
    );
    expect(pase).toMatchObject({ refundRequested: true, refundFailed: false });
  });

  it('en efectivo no pide nada a la pasarela', async () => {
    const pase = await service.pasarAlRepartoComun('ord-1');

    expect(refunds.reintegrarRecargoExpress).not.toHaveBeenCalled();
    expect(pase).toMatchObject({ refundRequested: false, refundFailed: false });
  });

  it('si la pasarela rechaza, el push NO dice "te devolvemos": avisa que está en trámite', async () => {
    refunds.registrarRecargoExpress.mockResolvedValue(true);
    refunds.reintegrarRecargoExpress.mockResolvedValue([
      { refundId: 'r1', status: 'failed' },
    ]);

    const pase = await service.pasarAlRepartoComun('ord-1');

    expect(pase?.refundFailed).toBe(true);
    const [, , aviso] = notifications.sendOrderNoticePush.mock.calls[0] as [
      string,
      string,
      { body: string },
    ];
    expect(aviso.body).toContain('en trámite');
    expect(aviso.body).not.toContain('Te devolvemos');
  });

  it('avisa al cliente en ese momento (socket y push) y al panel', async () => {
    await service.pasarAlRepartoComun('ord-1');

    expect(realtime.notifyCustomer).toHaveBeenCalledWith(
      'cus-1',
      'order:express-degraded',
      expect.objectContaining({
        orderId: 'ord-1',
        surchargeRemoved: 1500,
        total: 4000,
      }),
    );
    expect(realtime.notifyAdmins).toHaveBeenCalledWith(
      'order:express-degraded',
      expect.objectContaining({ distributorId: 'dist-1' }),
      'dist-1',
    );
    expect(notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'cus-1',
      'ord-1',
      expect.objectContaining({ event: 'EXPRESS_DEGRADED' }),
    );
  });

  it('si la pasarela o el aviso fallan, el pase ya confirmado no se deshace', async () => {
    refunds.registrarRecargoExpress.mockResolvedValue(true);
    refunds.reintegrarRecargoExpress.mockRejectedValue(new Error('MP caído'));
    realtime.notifyCustomer.mockImplementation(() => {
      throw new Error('socket caído');
    });

    const pase = await service.pasarAlRepartoComun('ord-1');

    expect(pase).not.toBeNull();
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['ya tiene chofer', { deliveryId: 'del-1' }],
    ['ya fue aceptado', { status: OrderStatus.ACCEPTED }],
    ['se canceló', { status: OrderStatus.CANCELLED }],
    ['ya es común', { deliveryMode: OrderDeliveryMode.STANDARD }],
  ])(
    'si %s no hace nada (dos pases no descuentan dos veces)',
    async (_c, cambio) => {
      locked = { ...expressPendiente(), ...cambio };

      expect(await service.pasarAlRepartoComun('ord-1')).toBeNull();
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(refunds.reintegrarRecargoExpress).not.toHaveBeenCalled();
      expect(realtime.notifyCustomer).not.toHaveBeenCalled();
    },
  );

  it('un pedido inexistente no hace nada', async () => {
    locked = null;
    expect(await service.pasarAlRepartoComun('ord-1')).toBeNull();
  });

  it('si falla el guardado revierte y propaga', async () => {
    queryRunner.manager.save.mockRejectedValue(new Error('db'));

    await expect(service.pasarAlRepartoComun('ord-1')).rejects.toThrow('db');
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });
});
