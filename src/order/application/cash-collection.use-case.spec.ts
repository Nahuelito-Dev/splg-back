import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { CashCollectionUseCase } from './cash-collection.use-case';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';

const CHOFER = 'u-chofer';
const ADMIN = 'u-admin';

describe('CashCollectionUseCase', () => {
  let uc: CashCollectionUseCase;
  let save: jest.Mock;
  let getOne: jest.Mock;
  let update: jest.Mock;
  let setLock: jest.Mock;
  let dentro: jest.Mock;

  const pedido = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'ord-1',
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      paymentConfirmedAt: null,
      paymentConfirmedBy: null,
      paymentResolutionNote: null,
      paymentResolvedAt: null,
      paymentResolvedBy: null,
      delivery: { userId: CHOFER },
      ...over,
    }) as unknown as Order;

  const con = (o: Order | null) => getOne.mockResolvedValue(o);

  beforeEach(() => {
    dentro = jest.fn().mockResolvedValue('extra');
    save = jest.fn((o: Order) => Promise.resolve(o));
    getOne = jest.fn();
    setLock = jest.fn();
    const qb = {
      setLock: setLock.mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne,
    };
    update = jest.fn().mockResolvedValue({ affected: 1 });
    const manager = { createQueryBuilder: jest.fn(() => qb), save, update };
    const dataSource = {
      transaction: jest.fn((fn: (m: unknown) => Promise<unknown>) =>
        fn(manager),
      ),
    } as unknown as DataSource;
    uc = new CashCollectionUseCase(dataSource);
  });

  describe('confirmReceived', () => {
    it('pasa a PAID y registra quién y cuándo', async () => {
      con(pedido());
      const r = await uc.confirmReceived('ord-1', CHOFER);
      expect(r.changed).toBe(true);
      expect(r.order.paymentStatus).toBe(PaymentStatus.PAID);
      expect(r.order.paymentConfirmedBy).toBe(CHOFER);
      expect(r.order.paymentConfirmedAt).toBeInstanceOf(Date);
      expect(save).toHaveBeenCalledTimes(1);
      expect(setLock).toHaveBeenCalledWith('pessimistic_write', undefined, [
        'ord',
      ]);
    });

    it('es idempotente: ya PAID no guarda de nuevo', async () => {
      con(pedido({ paymentStatus: PaymentStatus.PAID }));
      const r = await uc.confirmReceived('ord-1', CHOFER);
      expect(r.changed).toBe(false);
      expect(save).not.toHaveBeenCalled();
    });

    it('otro chofer: 403 y no toca nada', async () => {
      con(pedido());
      await expect(uc.confirmReceived('ord-1', 'u-otro')).rejects.toThrow(
        ForbiddenException,
      );
      expect(save).not.toHaveBeenCalled();
    });

    it('pedido sin chofer asignado: 403', async () => {
      con(pedido({ delivery: null as unknown as Order['delivery'] }));
      await expect(uc.confirmReceived('ord-1', CHOFER)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it.each([
      OrderStatus.PENDING,
      OrderStatus.ACCEPTED,
      OrderStatus.ON_THE_WAY,
      OrderStatus.CANCELLED,
    ])('pedido %s (no entregado): 400', async (status) => {
      con(pedido({ status }));
      await expect(uc.confirmReceived('ord-1', CHOFER)).rejects.toThrow(
        BadRequestException,
      );
      expect(save).not.toHaveBeenCalled();
    });

    it.each([PaymentMethod.MERCADOPAGO, PaymentMethod.TRANSFER])(
      'pago %s (no efectivo): 400',
      async (paymentMethod) => {
        con(pedido({ paymentMethod }));
        await expect(uc.confirmReceived('ord-1', CHOFER)).rejects.toThrow(
          BadRequestException,
        );
        expect(save).not.toHaveBeenCalled();
      },
    );

    it('ya informado como impago: 409', async () => {
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      await expect(uc.confirmReceived('ord-1', CHOFER)).rejects.toThrow(
        ConflictException,
      );
    });

    it('pedido inexistente: 404', async () => {
      con(null);
      await expect(uc.confirmReceived('x', CHOFER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('markUnpaid', () => {
    it('pasa a UNPAID', async () => {
      con(pedido());
      const r = await uc.markUnpaid('ord-1', CHOFER, dentro);
      expect(r.changed).toBe(true);
      expect(r.order.paymentStatus).toBe(PaymentStatus.UNPAID);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('es idempotente: ya UNPAID no guarda, pero igual corre el trabajo de la transacción', async () => {
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      const r = await uc.markUnpaid('ord-1', CHOFER, dentro);
      expect(r.changed).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect(dentro).toHaveBeenCalledTimes(1);
      expect(r.extra).toBe('extra');
    });

    it('el trabajo adicional corre en la misma transacción, con el pedido ya impago', async () => {
      con(pedido());
      await uc.markUnpaid('ord-1', CHOFER, dentro);
      const [manager, order] = dentro.mock.calls[0] as [
        { save: jest.Mock },
        Order,
      ];
      expect(manager.save).toBe(save);
      expect(order.paymentStatus).toBe(PaymentStatus.UNPAID);
    });

    it('si el trabajo adicional falla, falla todo (la transacción se revierte)', async () => {
      con(pedido());
      dentro.mockRejectedValue(new Error('boom'));
      await expect(uc.markUnpaid('ord-1', CHOFER, dentro)).rejects.toThrow(
        'boom',
      );
    });

    it('si no pasan los chequeos no corre el trabajo adicional', async () => {
      con(pedido());
      await expect(uc.markUnpaid('ord-1', 'u-otro', dentro)).rejects.toThrow();
      expect(dentro).not.toHaveBeenCalled();
    });

    it('otro chofer: 403', async () => {
      con(pedido());
      await expect(uc.markUnpaid('ord-1', 'u-otro', dentro)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('no entregado: 400', async () => {
      con(pedido({ status: OrderStatus.ON_THE_WAY }));
      await expect(uc.markUnpaid('ord-1', CHOFER, dentro)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('no efectivo: 400', async () => {
      con(pedido({ paymentMethod: PaymentMethod.TRANSFER }));
      await expect(uc.markUnpaid('ord-1', CHOFER, dentro)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('ya cobrado (PAID): 409, no se pisa un cobro', async () => {
      con(pedido({ paymentStatus: PaymentStatus.PAID }));
      await expect(uc.markUnpaid('ord-1', CHOFER, dentro)).rejects.toThrow(
        ConflictException,
      );
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('resolveUnpaid', () => {
    it('paid: cobrado después, con motivo y responsable', async () => {
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      const r = await uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'transfirió');
      expect(r.order.paymentStatus).toBe(PaymentStatus.PAID);
      expect(r.order.paymentConfirmedBy).toBe(ADMIN);
      expect(r.order.paymentResolutionNote).toBe('transfirió');
      expect(r.order.paymentConfirmedAt).toBeInstanceOf(Date);
      expect(r.order.paymentResolvedBy).toBe(ADMIN);
      expect(r.order.paymentResolvedAt).toBeInstanceOf(Date);
    });

    it('cierra la incidencia abierta de cobro impago con la misma nota, en la misma transacción', async () => {
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      await uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'transfirió');
      expect(update).toHaveBeenCalledTimes(1);
      const [, donde, cambios] = update.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(donde).toMatchObject({
        orderId: 'ord-1',
        type: 'unpaid_collection',
        status: 'open',
      });
      expect(cambios).toMatchObject({
        status: 'resolved',
        resolutionNote: 'transfirió',
      });
      expect(cambios.resolvedAt).toBeInstanceOf(Date);
    });

    it('written_off: pérdida', async () => {
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      const r = await uc.resolveUnpaid('ord-1', ADMIN, 'written_off', 'no hay');
      expect(r.order.paymentStatus).toBe(PaymentStatus.WRITTEN_OFF);
      // Una pérdida no es un cobro: no llena paymentConfirmed*.
      expect(r.order.paymentConfirmedAt).toBeNull();
      expect(r.order.paymentConfirmedBy).toBeNull();
      expect(r.order.paymentResolvedBy).toBe(ADMIN);
      expect(r.order.paymentResolvedAt).toBeInstanceOf(Date);
    });

    it('un PAID confirmado por el chofer no es un impago resuelto: 409', async () => {
      con(pedido({ paymentStatus: PaymentStatus.PAID }));
      await expect(
        uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'x'),
      ).rejects.toThrow(ConflictException);
      expect(save).not.toHaveBeenCalled();
    });

    it('repetir la misma resolución es no-op', async () => {
      con(
        pedido({
          paymentStatus: PaymentStatus.WRITTEN_OFF,
          paymentResolutionNote: 'no hay',
        }),
      );
      const r = await uc.resolveUnpaid('ord-1', ADMIN, 'written_off', 'x');
      expect(r.changed).toBe(false);
      expect(r.order.paymentResolutionNote).toBe('no hay');
      expect(save).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('un pedido que no está impago: 409', async () => {
      con(pedido({ paymentStatus: PaymentStatus.PENDING }));
      await expect(
        uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'x'),
      ).rejects.toThrow(ConflictException);
    });

    it('una resolución contraria a la ya tomada: 409', async () => {
      con(
        pedido({
          paymentStatus: PaymentStatus.WRITTEN_OFF,
          paymentResolutionNote: 'no hay',
        }),
      );
      await expect(
        uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'x'),
      ).rejects.toThrow(ConflictException);
    });
  });
});
