import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { CashDocumentPaymentService } from '../../cash/application/cash-document-payment.service';
import {
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';
import {
  CompraInvalidaError,
  RecepcionNoEncontradaError,
} from '../domain/errors/purchase.errors';
import { PaymentStatus, PurchaseReceiptStatus } from '../domain/purchase.enums';
import { PurchaseReceipt } from '../entities/purchase-receipt.entity';
import { PurchaseReceiptService } from './purchase-receipt.service';

describe('PurchaseReceiptService.cambiarEstadoDePago', () => {
  let service: PurchaseReceiptService;
  let recepcion: PurchaseReceipt | null;
  let guardadas: PurchaseReceipt[];
  let pagos: {
    cajaDelPago: jest.Mock;
    egresar: jest.Mock;
    revertir: jest.Mock;
  };

  const base = (over: Partial<PurchaseReceipt> = {}): PurchaseReceipt =>
    ({
      receiptId: 'r1',
      number: 7,
      totalAmount: 130000,
      status: PurchaseReceiptStatus.CONFIRMED,
      paymentStatus: PaymentStatus.UNPAID,
      cashMovementId: null,
      ...over,
    }) as PurchaseReceipt;

  beforeEach(() => {
    guardadas = [];
    recepcion = base();
    pagos = {
      cajaDelPago: jest.fn().mockResolvedValue('caja1'),
      egresar: jest.fn().mockResolvedValue({ movementId: 'mov1' }),
      revertir: jest.fn().mockResolvedValue({}),
    };
    const qb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(recepcion)),
    };
    const manager = {
      getRepository: () => ({ createQueryBuilder: () => qb }),
      save: jest.fn((r: PurchaseReceipt) => {
        guardadas.push({ ...r });
        return Promise.resolve(r);
      }),
    };
    const dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    service = new PurchaseReceiptService(
      dataSource as unknown as DataSource,
      pagos as unknown as CashDocumentPaymentService,
    );
  });

  const pagar = (extra: object = {}) =>
    service.cambiarEstadoDePago(
      'r1',
      { paymentStatus: PaymentStatus.PAID, ...extra },
      'd1',
      'u1',
    );

  it('pagada en efectivo: el total sale de la caja y la recepción guarda el movimiento', async () => {
    await pagar({ paidInCash: true, cashBoxId: 'caja1' });
    expect(pagos.egresar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cashBoxId: 'caja1',
        amount: new Decimal(130000),
        systemCode: CashSystemCode.PURCHASE,
        referenceType: CashReferenceType.PURCHASE_RECEIPT,
        referenceId: 'r1',
        userId: 'u1',
      }),
    );
    expect(guardadas[0]).toMatchObject({
      paymentStatus: PaymentStatus.PAID,
      cashMovementId: 'mov1',
    });
  });

  it('pagada sin efectivo es sólo la marca', async () => {
    await pagar();
    expect(pagos.cajaDelPago).not.toHaveBeenCalled();
    expect(pagos.egresar).not.toHaveBeenCalled();
    expect(guardadas[0]).toMatchObject({ paymentStatus: PaymentStatus.PAID });
  });

  it('sin cajas de efectivo en la distribuidora se paga sin movimiento', async () => {
    pagos.cajaDelPago.mockResolvedValue(null);
    await pagar({ paidInCash: true });
    expect(pagos.egresar).not.toHaveBeenCalled();
    expect(guardadas[0].cashMovementId).toBeNull();
  });

  it('repetir «pagada» no asienta dos veces', async () => {
    recepcion = base({
      paymentStatus: PaymentStatus.PAID,
      cashMovementId: 'mov1',
    });
    await pagar({ paidInCash: true, cashBoxId: 'caja1' });
    expect(pagos.egresar).not.toHaveBeenCalled();
    expect(guardadas).toHaveLength(0);
  });

  it('una recepción ya pagada sin movimiento no se paga en efectivo después (409)', async () => {
    recepcion = base({ paymentStatus: PaymentStatus.PAID });
    await expect(
      pagar({ paidInCash: true, cashBoxId: 'caja1' }),
    ).rejects.toThrow(/impaga/);
    expect(pagos.egresar).not.toHaveBeenCalled();
  });

  it('marcarla impaga asienta el contraasiento y libera el movimiento', async () => {
    recepcion = base({
      paymentStatus: PaymentStatus.PAID,
      cashMovementId: 'mov1',
    });
    await service.cambiarEstadoDePago(
      'r1',
      { paymentStatus: PaymentStatus.UNPAID },
      'd1',
      'u1',
    );
    expect(pagos.revertir).toHaveBeenCalledWith(
      expect.anything(),
      'mov1',
      'd1',
      expect.any(String),
      'u1',
    );
    expect(guardadas[0]).toMatchObject({
      paymentStatus: PaymentStatus.UNPAID,
      cashMovementId: null,
    });
  });

  it('marcarla impaga sin pago en efectivo no toca la caja', async () => {
    recepcion = base({ paymentStatus: PaymentStatus.PAID });
    await service.cambiarEstadoDePago(
      'r1',
      { paymentStatus: PaymentStatus.UNPAID },
      'd1',
      'u1',
    );
    expect(pagos.revertir).not.toHaveBeenCalled();
  });

  it('una caja de la que no sale el efectivo corta sin guardar nada', async () => {
    pagos.cajaDelPago.mockRejectedValue(new CompraInvalidaError('caja'));
    await expect(pagar({ paidInCash: true })).rejects.toThrow('caja');
    expect(guardadas).toHaveLength(0);
  });

  it('cashBoxId sin paidInCash es 400', async () => {
    await expect(pagar({ cashBoxId: 'caja1' })).rejects.toThrow(/cashBoxId/);
  });

  it('paidInCash al marcarla impaga es 400', async () => {
    await expect(
      service.cambiarEstadoDePago(
        'r1',
        { paymentStatus: PaymentStatus.UNPAID, paidInCash: true },
        'd1',
        'u1',
      ),
    ).rejects.toThrow(/paidInCash/);
  });

  it('una recepción anulada no cambia de estado de pago', async () => {
    recepcion = base({ status: PurchaseReceiptStatus.VOIDED });
    await expect(pagar({ paidInCash: true })).rejects.toThrow(/anulada/);
    expect(pagos.egresar).not.toHaveBeenCalled();
  });

  it('una recepción de otra distribuidora es 404', async () => {
    recepcion = null;
    await expect(pagar()).rejects.toBeInstanceOf(RecepcionNoEncontradaError);
  });
});
