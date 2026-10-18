import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { CashCollectionUseCase } from './cash-collection.use-case';
import type { CashCategoryService } from '../../cash/application/cash-category.service';
import type { CashLedgerService } from '../../cash/application/cash-ledger.service';
import {
  CashDirection,
  CashMethod,
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';
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
  let andWhere: jest.Mock;
  let findOne: jest.Mock;
  let insert: jest.Mock;
  let query: jest.Mock;
  let exists: jest.Mock;
  let registrar: jest.Mock;
  let deSistema: jest.Mock;

  const pedido = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'ord-1',
      distributorId: 'd1',
      totalAmount: 4500,
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
    andWhere = jest.fn();
    findOne = jest.fn().mockResolvedValue(null);
    insert = jest.fn().mockResolvedValue(undefined);
    exists = jest.fn().mockResolvedValue(false);
    // El conteo de cajas de efectivo y la lectura del tipo de la caja elegida.
    query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('count(*)') ? [{ n: '0' }] : [{ kind: 'cash' }],
      ),
    );
    registrar = jest.fn().mockResolvedValue({ movementId: 'mov-1' });
    deSistema = jest.fn().mockResolvedValue({ categoryId: 'cat-1' });
    dentro = jest.fn().mockResolvedValue('extra');
    save = jest.fn((o: Order) => Promise.resolve(o));
    getOne = jest.fn();
    setLock = jest.fn();
    const qb = {
      setLock: setLock.mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: andWhere.mockReturnThis(),
      getOne,
    };
    update = jest.fn().mockResolvedValue({ affected: 1 });
    const manager = {
      createQueryBuilder: jest.fn(() => qb),
      save,
      update,
      insert,
      findOne,
      query,
      exists,
    };
    const dataSource = {
      transaction: jest.fn((fn: (m: unknown) => Promise<unknown>) =>
        fn(manager),
      ),
    } as unknown as DataSource;
    uc = new CashCollectionUseCase(
      dataSource,
      { registrar } as unknown as CashLedgerService,
      { deSistema } as unknown as CashCategoryService,
    );
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

    it('un cobro registrado por el admin (register-cash) NO es un impago resuelto: resolve-unpaid da 409', async () => {
      con(
        pedido({
          paymentStatus: PaymentStatus.PAID,
          paymentResolutionNote: 'El chofer renunció',
          paymentResolvedBy: ADMIN,
        }),
      );
      await expect(
        uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'x'),
      ).rejects.toThrow(/impago/);
      expect(save).not.toHaveBeenCalled();
    });

    it('una transferencia confirmada tampoco: resolve-unpaid da 409', async () => {
      con(
        pedido({
          paymentMethod: PaymentMethod.TRANSFER,
          paymentStatus: PaymentStatus.PAID,
          paymentResolutionNote: 'Figura en el banco',
        }),
      );
      await expect(
        uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'x'),
      ).rejects.toThrow(ConflictException);
    });

    it('un impago realmente resuelto como cobrado (con su incidencia resuelta) repite como no-op', async () => {
      con(
        pedido({
          paymentStatus: PaymentStatus.PAID,
          paymentResolutionNote: 'pagó el lunes',
        }),
      );
      findOne.mockResolvedValue({ incidentId: 'i1' });
      const r = await uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'otra');
      expect(r.changed).toBe(false);
      expect(save).not.toHaveBeenCalled();
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

  describe('filtro por distribuidora en el lock', () => {
    it('con distribuidora, el lock filtra por ella en las cuatro operaciones del efectivo', async () => {
      con(pedido());
      await uc.confirmReceived('ord-1', CHOFER, 'd1');
      con(pedido());
      await uc.markUnpaid('ord-1', CHOFER, dentro, 'd1');
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      await uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'ok', 'd1');
      con(pedido());
      await uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo', 'd1');
      expect(andWhere).toHaveBeenCalledTimes(4);
      expect(andWhere).toHaveBeenCalledWith(
        'ord.distributorId = :distributorId',
        {
          distributorId: 'd1',
        },
      );
    });

    it('sin distribuidora (cliente) no agrega filtro', async () => {
      con(pedido());
      await uc.confirmReceived('ord-1', CHOFER);
      expect(andWhere).not.toHaveBeenCalled();
    });

    it('un pedido de otra distribuidora no se encuentra: 404 y no se toca', async () => {
      con(null);
      await expect(
        uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'ok', 'otra'),
      ).rejects.toThrow(NotFoundException);
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('registerCashByAdmin', () => {
    it('pasa a PAID con el admin como responsable, motivo e historial', async () => {
      con(pedido({ delivery: null as unknown as Order['delivery'] }));
      const r = await uc.registerCashByAdmin(
        'ord-1',
        ADMIN,
        'El chofer ya no trabaja',
        'd1',
      );
      expect(r.changed).toBe(true);
      expect(r.order).toMatchObject({
        paymentStatus: PaymentStatus.PAID,
        paymentConfirmedBy: ADMIN,
        paymentResolvedBy: ADMIN,
        paymentResolutionNote: 'El chofer ya no trabaja',
      });
      expect(insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orderId: 'ord-1',
          changedByUserId: ADMIN,
          reason: expect.stringContaining('El chofer ya no trabaja') as string,
        }),
      );
    });

    it('repetirlo no guarda ni asienta de nuevo', async () => {
      con(pedido({ paymentStatus: PaymentStatus.PAID }));
      const r = await uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo');
      expect(r.changed).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    });

    it('no entregado o no efectivo: 400; impago: 409', async () => {
      con(pedido({ status: OrderStatus.ON_THE_WAY }));
      await expect(
        uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo'),
      ).rejects.toThrow(BadRequestException);
      con(pedido({ paymentMethod: PaymentMethod.TRANSFER }));
      await expect(
        uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo'),
      ).rejects.toThrow(BadRequestException);
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      await expect(
        uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo'),
      ).rejects.toThrow(ConflictException);
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('registerUnpaidByAdmin', () => {
    it('pasa a UNPAID, corre el trabajo de la transacción y deja el historial', async () => {
      con(pedido());
      const r = await uc.registerUnpaidByAdmin(
        'ord-1',
        ADMIN,
        'El chofer no informó',
        dentro,
        'd1',
      );
      expect(r.order.paymentStatus).toBe(PaymentStatus.UNPAID);
      expect(r.extra).toBe('extra');
      expect(insert).toHaveBeenCalledTimes(1);
    });

    it('deja el motivo, quién y cuándo en el pedido, como register-cash', async () => {
      con(pedido());
      const r = await uc.registerUnpaidByAdmin(
        'ord-1',
        ADMIN,
        'El chofer no informó',
        dentro,
        'd1',
      );
      expect(r.order).toMatchObject({
        paymentStatus: PaymentStatus.UNPAID,
        paymentResolvedBy: ADMIN,
        paymentResolutionNote: 'El chofer no informó',
      });
      expect(r.order.paymentResolvedAt).toBeInstanceOf(Date);
      expect(r.order.paymentConfirmedBy).toBeNull();
    });

    it('si ya estaba impago no pisa la anotación existente', async () => {
      const antes = new Date('2026-10-01T10:00:00Z');
      con(
        pedido({
          paymentStatus: PaymentStatus.UNPAID,
          paymentResolvedAt: antes,
          paymentResolvedBy: 'otro-admin',
          paymentResolutionNote: 'motivo original',
        }),
      );
      const r = await uc.registerUnpaidByAdmin(
        'ord-1',
        ADMIN,
        'motivo nuevo largo',
        dentro,
      );
      expect(r.order).toMatchObject({
        paymentResolvedAt: antes,
        paymentResolvedBy: 'otro-admin',
        paymentResolutionNote: 'motivo original',
      });
    });

    it('ya impago: no asienta de nuevo pero corre el trabajo (incidencia única)', async () => {
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      const r = await uc.registerUnpaidByAdmin(
        'ord-1',
        ADMIN,
        'motivo largo',
        dentro,
      );
      expect(r.changed).toBe(false);
      expect(insert).not.toHaveBeenCalled();
      expect(dentro).toHaveBeenCalled();
    });

    it('ya cobrado: 409', async () => {
      con(pedido({ paymentStatus: PaymentStatus.PAID }));
      await expect(
        uc.registerUnpaidByAdmin('ord-1', ADMIN, 'motivo largo', dentro),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('confirmTransfer', () => {
    const transferencia = (over: Partial<Order> = {}) =>
      pedido({ paymentMethod: PaymentMethod.TRANSFER, ...over });

    it('received: true pasa a PAID, cuenta como cobrado y deja motivo e historial', async () => {
      con(transferencia());
      const r = await uc.confirmTransfer(
        'ord-1',
        ADMIN,
        true,
        'Figura en el banco',
        'd1',
      );
      expect(r.changed).toBe(true);
      expect(r.order).toMatchObject({
        paymentStatus: PaymentStatus.PAID,
        paymentConfirmedBy: ADMIN,
        paymentResolutionNote: 'Figura en el banco',
      });
      expect(insert).toHaveBeenCalledTimes(1);
    });

    it('received: false pasa a FAILED sin llenar paymentConfirmed*', async () => {
      con(transferencia());
      const r = await uc.confirmTransfer(
        'ord-1',
        ADMIN,
        false,
        'No figura en el banco',
      );
      expect(r.order.paymentStatus).toBe(PaymentStatus.FAILED);
      expect(r.order.paymentConfirmedBy).toBeNull();
      expect(r.order.paymentResolvedBy).toBe(ADMIN);
    });

    it('un pedido marcado "no recibida" puede confirmarse después, con motivo', async () => {
      con(transferencia({ paymentStatus: PaymentStatus.FAILED }));
      const r = await uc.confirmTransfer(
        'ord-1',
        ADMIN,
        true,
        'Llegó el lunes',
      );
      expect(r.changed).toBe(true);
      expect(r.order.paymentStatus).toBe(PaymentStatus.PAID);
      expect(r.order.paymentConfirmedBy).toBe(ADMIN);
    });

    it('"no recibida" sólo se marca sobre un pedido entregado', async () => {
      con(transferencia({ status: OrderStatus.ON_THE_WAY }));
      await expect(
        uc.confirmTransfer('ord-1', ADMIN, false, 'No figura en el banco'),
      ).rejects.toThrow(ConflictException);
      expect(save).not.toHaveBeenCalled();
    });

    it('una transferencia confirmada no pasa a "no recibida" (409)', async () => {
      con(transferencia({ paymentStatus: PaymentStatus.PAID }));
      await expect(
        uc.confirmTransfer('ord-1', ADMIN, false, 'ahora dicen que no'),
      ).rejects.toThrow(ConflictException);
    });

    it('es idempotente con la misma decisión y 409 con la contraria', async () => {
      con(transferencia({ paymentStatus: PaymentStatus.PAID }));
      expect(
        (await uc.confirmTransfer('ord-1', ADMIN, true, 'motivo largo'))
          .changed,
      ).toBe(false);
      await expect(
        uc.confirmTransfer('ord-1', ADMIN, false, 'motivo largo'),
      ).rejects.toThrow(ConflictException);
      expect(save).not.toHaveBeenCalled();
    });

    it('un pedido que no es transferencia o está cancelado: 400', async () => {
      con(pedido());
      await expect(
        uc.confirmTransfer('ord-1', ADMIN, true, 'motivo largo'),
      ).rejects.toThrow(BadRequestException);
      con(transferencia({ status: OrderStatus.CANCELLED }));
      await expect(
        uc.confirmTransfer('ord-1', ADMIN, true, 'motivo largo'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('cobro del admin a caja', () => {
    const CAJA = 'caja-1';

    it('register-cash asienta la entrada en la caja por el total del pedido, con la referencia al pedido', async () => {
      con(pedido());
      const r = await uc.registerCashByAdmin(
        'ord-1',
        ADMIN,
        'El chofer ya no trabaja',
        'd1',
        CAJA,
      );
      expect(r.changed).toBe(true);
      expect(deSistema).toHaveBeenCalledWith(
        expect.anything(),
        'd1',
        CashSystemCode.ORDER_PAYMENT,
      );
      expect(registrar).toHaveBeenCalledTimes(1);
      expect(registrar).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          distributorId: 'd1',
          cashBoxId: CAJA,
          direction: CashDirection.IN,
          categoryId: 'cat-1',
          method: CashMethod.CASH,
          referenceType: CashReferenceType.ORDER_PAYMENT,
          referenceId: 'ord-1',
          userId: ADMIN,
        }),
      );
      const [, entrada] = registrar.mock.calls[0] as [
        unknown,
        { amount: { toString(): string } },
      ];
      expect(entrada.amount.toString()).toBe('4500');
    });

    it('register-cash sin caja con la distribuidora teniendo cajas: 400 y no toca nada', async () => {
      query.mockResolvedValue([{ n: '2' }]);
      con(pedido());
      await expect(
        uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo', 'd1'),
      ).rejects.toThrow(BadRequestException);
      expect(save).not.toHaveBeenCalled();
      expect(registrar).not.toHaveBeenCalled();
    });

    it('register-cash sin caja y sin cajas en la distribuidora: cobra sin movimiento', async () => {
      con(pedido());
      const r = await uc.registerCashByAdmin(
        'ord-1',
        ADMIN,
        'motivo largo',
        'd1',
      );
      expect(r.order.paymentStatus).toBe(PaymentStatus.PAID);
      expect(registrar).not.toHaveBeenCalled();
    });

    it('repetir register-cash no asienta otra entrada', async () => {
      con(pedido({ paymentStatus: PaymentStatus.PAID }));
      const r = await uc.registerCashByAdmin(
        'ord-1',
        ADMIN,
        'motivo largo',
        'd1',
        CAJA,
      );
      expect(r.changed).toBe(false);
      expect(registrar).not.toHaveBeenCalled();
    });

    it('si el libro rechaza el movimiento (caja sin sesión), la operación falla con ese error', async () => {
      registrar.mockRejectedValue(new ConflictException('sin sesión'));
      con(pedido());
      await expect(
        uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo', 'd1', CAJA),
      ).rejects.toThrow(ConflictException);
    });

    it('register-cash: un pedido que la rendición del chofer ya tomó es 409 y no asienta nada', async () => {
      exists.mockResolvedValue(true);
      con(pedido());
      await expect(
        uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo', 'd1', CAJA),
      ).rejects.toThrow(ConflictException);
      expect(save).not.toHaveBeenCalled();
      expect(registrar).not.toHaveBeenCalled();
    });

    it('register-unpaid: un pedido ya rendido por el chofer también es 409', async () => {
      exists.mockResolvedValue(true);
      con(pedido());
      await expect(
        uc.registerUnpaidByAdmin('ord-1', ADMIN, 'motivo largo', dentro, 'd1'),
      ).rejects.toThrow(ConflictException);
      expect(save).not.toHaveBeenCalled();
      expect(dentro).not.toHaveBeenCalled();
    });

    it('asienta el saldo a cobrar: el total menos la seña paga', async () => {
      con(
        pedido({ totalAmount: 15800, depositPaid: true, depositAmount: 5000 }),
      );
      await uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo', 'd1', CAJA);
      const [, entrada] = registrar.mock.calls[0] as [
        unknown,
        { amount: { toString(): string } },
      ];
      expect(entrada.amount.toString()).toBe('10800');
    });

    it('si el saldo a cobrar es 0 (la seña cubrió todo) cobra sin asentar', async () => {
      con(
        pedido({ totalAmount: 5000, depositPaid: true, depositAmount: 5000 }),
      );
      const r = await uc.registerCashByAdmin(
        'ord-1',
        ADMIN,
        'motivo largo',
        'd1',
        CAJA,
      );
      expect(r.order.paymentStatus).toBe(PaymentStatus.PAID);
      expect(registrar).not.toHaveBeenCalled();
    });

    it('la obligatoriedad cuenta sólo cajas de efectivo activas', async () => {
      con(pedido());
      await uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo', 'd1');
      const [sql] = query.mock.calls[0] as [string];
      expect(sql).toContain(`"kind" = 'cash'`);
    });

    it('una caja que no es de efectivo se rechaza con 400 antes de tocar el pedido', async () => {
      query.mockResolvedValue([{ kind: 'bank' }]);
      con(pedido());
      await expect(
        uc.registerCashByAdmin('ord-1', ADMIN, 'motivo largo', 'd1', CAJA),
      ).rejects.toThrow(BadRequestException);
      expect(save).not.toHaveBeenCalled();
    });

    it('resolve-unpaid paid asienta la entrada en la caja', async () => {
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      await uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'transfirió', 'd1', CAJA);
      expect(registrar).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          cashBoxId: CAJA,
          direction: CashDirection.IN,
          referenceType: CashReferenceType.ORDER_PAYMENT,
          referenceId: 'ord-1',
        }),
      );
    });

    it('resolve-unpaid paid sin caja con la distribuidora teniendo cajas: 400', async () => {
      query.mockResolvedValue([{ n: '1' }]);
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      await expect(
        uc.resolveUnpaid('ord-1', ADMIN, 'paid', 'transfirió', 'd1'),
      ).rejects.toThrow(BadRequestException);
      expect(save).not.toHaveBeenCalled();
    });

    it('resolve-unpaid written_off no pide caja ni asienta nada', async () => {
      query.mockResolvedValue([{ n: '3' }]);
      con(pedido({ paymentStatus: PaymentStatus.UNPAID }));
      const r = await uc.resolveUnpaid(
        'ord-1',
        ADMIN,
        'written_off',
        'no hay',
        'd1',
        CAJA,
      );
      expect(r.order.paymentStatus).toBe(PaymentStatus.WRITTEN_OFF);
      expect(registrar).not.toHaveBeenCalled();
    });
  });
});
