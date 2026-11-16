import Decimal from 'decimal.js';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CashDocumentPaymentService } from '../../cash/application/cash-document-payment.service';
import {
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';
import {
  CompraInvalidaError,
  RecepcionNoEncontradaError,
} from '../domain/errors/purchase.errors';
import {
  PaymentStatus,
  PurchaseReceiptStatus,
  SupplierDocumentType,
} from '../domain/purchase.enums';
import { PurchaseOrder } from '../entities/purchase-order.entity';
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
    pagarDesdeUnaCaja: jest.Mock;
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
      pagarDesdeUnaCaja: jest.fn().mockResolvedValue({ movementId: 'mov7' }),
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
    await expect(pagar({ cashBoxId: 'caja1' })).rejects.toThrow(
      'Caja: sólo se indica cuando el pago es en efectivo',
    );
  });

  it('paidInCash al marcarla impaga es 400', async () => {
    await expect(
      service.cambiarEstadoDePago(
        'r1',
        { paymentStatus: PaymentStatus.UNPAID, paidInCash: true },
        'd1',
        'u1',
      ),
    ).rejects.toThrow(
      'Pagado en efectivo: sólo se indica al marcar la recepción como pagada',
    );
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

describe('PurchaseReceiptService.pagar (v2)', () => {
  let service: PurchaseReceiptService;
  let recepcion: PurchaseReceipt | null;
  let guardadas: PurchaseReceipt[];
  let pagos: { pagarDesdeUnaCaja: jest.Mock };

  const base = (over: Partial<PurchaseReceipt> = {}): PurchaseReceipt =>
    ({
      receiptId: 'r1',
      number: 7,
      totalAmount: 130000,
      status: PurchaseReceiptStatus.CONFIRMED,
      paymentStatus: PaymentStatus.UNPAID,
      cashMovementId: null,
      paidAt: null,
      receivedAt: new Date('2026-10-01T12:00:00.000Z'),
      ...over,
    }) as PurchaseReceipt;
  const dto = { cashBoxId: 'caja1', paidAt: '2026-10-28T12:00:00-03:00' };

  beforeEach(() => {
    guardadas = [];
    recepcion = base();
    pagos = {
      pagarDesdeUnaCaja: jest.fn().mockResolvedValue({ movementId: 'mov7' }),
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
    service = new PurchaseReceiptService(
      {
        transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
      } as unknown as DataSource,
      pagos as unknown as CashDocumentPaymentService,
    );
  });

  it('el total sale de la caja elegida y la recepción queda paga con su fecha', async () => {
    await service.pagar('r1', dto, 'd1', 'u1');
    expect(pagos.pagarDesdeUnaCaja).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cashBoxId: 'caja1',
        amount: new Decimal(130000),
        systemCode: CashSystemCode.PURCHASE,
        referenceType: CashReferenceType.PURCHASE_RECEIPT,
      }),
    );
    expect(guardadas[0]).toMatchObject({
      paymentStatus: PaymentStatus.PAID,
      cashMovementId: 'mov7',
      paidAt: new Date('2026-10-28T15:00:00.000Z'),
    });
  });

  it('paidAt anterior a la recepción es 400', async () => {
    await expect(
      service.pagar('r1', { ...dto, paidAt: '2026-09-15' }, 'd1', 'u1'),
    ).rejects.toThrow(/anterior a la recepción/);
    expect(pagos.pagarDesdeUnaCaja).not.toHaveBeenCalled();
  });

  it('ya pagada es 409 y no asienta', async () => {
    recepcion = base({ paymentStatus: PaymentStatus.PAID });
    await expect(service.pagar('r1', dto, 'd1', 'u1')).rejects.toThrow(
      /ya está pagada/,
    );
    expect(pagos.pagarDesdeUnaCaja).not.toHaveBeenCalled();
  });

  it('anulada es 400 y otra distribuidora 404', async () => {
    recepcion = base({ status: PurchaseReceiptStatus.VOIDED });
    await expect(service.pagar('r1', dto, 'd1', 'u1')).rejects.toBeInstanceOf(
      CompraInvalidaError,
    );
    recepcion = null;
    await expect(service.pagar('r1', dto, 'd2', 'u1')).rejects.toBeInstanceOf(
      RecepcionNoEncontradaError,
    );
  });

  it('paidAt futuro es 400', async () => {
    const manana = new Date(Date.now() + 86400000).toISOString();
    await expect(
      service.pagar('r1', { ...dto, paidAt: manana }, 'd1', 'u1'),
    ).rejects.toThrow(/Fecha de pago: no puede ser posterior a hoy/);
  });

  it('marcarla impaga (v1) borra la fecha de pago', async () => {
    recepcion = base({
      paymentStatus: PaymentStatus.PAID,
      cashMovementId: 'mov7',
      paidAt: new Date(),
    });
    // la reversión la hace el servicio de cajas; acá sólo se mira la marca
    (pagos as unknown as { revertir: jest.Mock }).revertir = jest.fn();
    await service.cambiarEstadoDePago(
      'r1',
      { paymentStatus: PaymentStatus.UNPAID },
      'd1',
      'u1',
    );
    expect(guardadas[0]).toMatchObject({ paidAt: null, cashMovementId: null });
  });
});

describe('PurchaseReceiptService.registrarFacturaDesdeLectura', () => {
  const datos = {
    numero: 'F-1',
    total: '100.00',
    tolerancePct: 1,
    expected: {},
  };
  const correr = (
    recepcion: Partial<PurchaseReceipt> | null,
    orden: object | null = null,
    extra: object = {},
  ) => {
    const qb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(recepcion)),
    };
    const manager = {
      getRepository: jest.fn(() => ({ createQueryBuilder: () => qb })),
      findOne: jest.fn((entidad: unknown) =>
        Promise.resolve(
          entidad === PurchaseOrder ? orden : { cuit: '20123456786' },
        ),
      ),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const service = new PurchaseReceiptService(
      {} as DataSource,
      {} as CashDocumentPaymentService,
    );
    return {
      manager,
      promesa: service.registrarFacturaDesdeLectura(
        manager as unknown as EntityManager,
        'r1',
        'd1',
        { ...datos, ...extra },
      ),
    };
  };
  const remito = (over: Partial<PurchaseReceipt> = {}) =>
    ({
      status: PurchaseReceiptStatus.CONFIRMED,
      totalAmount: 100,
      purchaseOrderId: null,
      supplierDocumentType: SupplierDocumentType.DELIVERY_NOTE,
      supplierDocumentNumber: 'R-1',
      ...over,
    }) as PurchaseReceipt;

  it('registra la factura y sólo cambia tipo y número', async () => {
    const recepcion = remito();
    const { promesa, manager } = correr(recepcion);
    await promesa;
    expect(recepcion.supplierDocumentType).toBe(SupplierDocumentType.INVOICE);
    expect(recepcion.supplierDocumentNumber).toBe('F-1');
    expect(recepcion.totalAmount).toBe(100);
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  it('sin total propio usa el de la orden, igual que la conciliación', async () => {
    const { promesa } = correr(
      remito({ totalAmount: 0, purchaseOrderId: 'o1' }),
      { totalAmount: 100 },
    );
    await expect(promesa).resolves.toBeUndefined();
  });

  it('total fuera de tolerancia es 400; dentro pasa', async () => {
    await expect(
      correr(remito(), null, { total: '102.00' }).promesa,
    ).rejects.toThrow(BadRequestException);
    await expect(
      correr(remito(), null, { total: '100.90' }).promesa,
    ).resolves.toBeUndefined();
  });

  it('anulada, o con otra factura, es 409; la misma factura no escribe', async () => {
    await expect(
      correr(remito({ status: PurchaseReceiptStatus.VOIDED })).promesa,
    ).rejects.toThrow(ConflictException);
    const factura = {
      supplierDocumentType: SupplierDocumentType.INVOICE,
      supplierDocumentNumber: 'F-9',
    };
    await expect(correr(remito(factura)).promesa).rejects.toThrow(
      ConflictException,
    );
    const misma = correr(remito({ ...factura, supplierDocumentNumber: 'F-1' }));
    await misma.promesa;
    expect(misma.manager.save).not.toHaveBeenCalled();
  });

  it('dueño cambiado es 409 y otra distribuidora no se encuentra', async () => {
    await expect(
      correr(remito(), null, { expected: { total: '250.00' } }).promesa,
    ).rejects.toThrow(ConflictException);
    await expect(correr(null).promesa).rejects.toThrow(
      RecepcionNoEncontradaError,
    );
  });
});
