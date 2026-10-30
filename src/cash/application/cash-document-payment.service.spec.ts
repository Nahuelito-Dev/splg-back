import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  CashBoxKind,
  CashDirection,
  CashMethod,
  CashReferenceType,
  CashSystemCode,
} from '../domain/cash.enums';
import {
  CajaNoEncontradaError,
  MovimientoNoEncontradoError,
} from '../domain/errors/cash.errors';
import { CashMovement } from '../entities/cash-movement.entity';
import { CashCategoryService } from './cash-category.service';
import { CashDocumentPaymentService } from './cash-document-payment.service';
import { CashLedgerService } from './cash-ledger.service';

describe('CashDocumentPaymentService', () => {
  let service: CashDocumentPaymentService;
  let ledger: { registrar: jest.Mock; bloquearCajas: jest.Mock };
  let categorias: { deSistema: jest.Mock };
  let manager: { query: jest.Mock; findOne: jest.Mock; exists: jest.Mock };

  beforeEach(() => {
    ledger = {
      registrar: jest.fn().mockResolvedValue({ movementId: 'mov-nuevo' }),
      bloquearCajas: jest.fn().mockResolvedValue(undefined),
    };
    categorias = {
      deSistema: jest.fn().mockResolvedValue({ categoryId: 'cat1' }),
    };
    manager = {
      query: jest.fn(),
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
    };
    service = new CashDocumentPaymentService(
      ledger as unknown as CashLedgerService,
      categorias as unknown as CashCategoryService,
    );
  });

  const m = () => manager as unknown as EntityManager;

  describe('cajaDelPago', () => {
    it('una caja de efectivo de la distribuidora se acepta', async () => {
      manager.query.mockResolvedValue([{ kind: 'cash' }]);
      await expect(service.cajaDelPago(m(), 'd1', 'c1')).resolves.toBe('c1');
    });

    it('una caja inexistente o de otra distribuidora es 404', async () => {
      manager.query.mockResolvedValue([]);
      await expect(service.cajaDelPago(m(), 'd1', 'c1')).rejects.toBeInstanceOf(
        CajaNoEncontradaError,
      );
    });

    it.each(['bank', 'wallet'])('una caja %s es 400', async (kind) => {
      manager.query.mockResolvedValue([{ kind }]);
      await expect(service.cajaDelPago(m(), 'd1', 'c1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('con las tres clases admitidas aceptan efectivo, banco y billetera', async () => {
      const todas = [CashBoxKind.CASH, CashBoxKind.BANK, CashBoxKind.WALLET];
      for (const kind of todas) {
        manager.query.mockResolvedValue([{ kind }]);
        await expect(service.cajaDelPago(m(), 'd1', 'c1', todas)).resolves.toBe(
          'c1',
        );
      }
    });

    it('una clase fuera de las admitidas es 400 con el mensaje de las tres clases', async () => {
      manager.query.mockResolvedValue([{ kind: 'wallet' }]);
      await expect(
        service.cajaDelPago(m(), 'd1', 'c1', [
          CashBoxKind.CASH,
          CashBoxKind.BANK,
        ]),
      ).rejects.toThrow(/efectivo, de banco o de billetera/);
    });

    it('la caja inexistente sigue siendo 404 con las tres clases', async () => {
      manager.query.mockResolvedValue([]);
      await expect(
        service.cajaDelPago(m(), 'd1', 'c1', [CashBoxKind.BANK]),
      ).rejects.toBeInstanceOf(CajaNoEncontradaError);
    });

    it('sin caja y con cajas de efectivo activas es 400', async () => {
      manager.query.mockResolvedValue([{ n: '2' }]);
      await expect(service.cajaDelPago(m(), 'd1')).rejects.toThrow(/cashBoxId/);
    });

    it('sin caja y sin cajas de efectivo devuelve null: se paga sin movimiento', async () => {
      manager.query.mockResolvedValue([{ n: '0' }]);
      await expect(service.cajaDelPago(m(), 'd1')).resolves.toBeNull();
    });
  });

  describe('pagarDesdeUnaCaja / cobrarEnUnaCaja', () => {
    const mov = {
      distributorId: 'd1',
      cashBoxId: 'c1',
      amount: 100,
      systemCode: CashSystemCode.TIRES,
      referenceType: CashReferenceType.TIRE,
      referenceId: 't1',
      description: 'x',
      userId: 'u1',
    };

    it.each([
      ['cash', CashMethod.CASH],
      ['bank', CashMethod.TRANSFER],
      ['wallet', CashMethod.MERCADOPAGO],
    ])(
      'el pago desde una caja %s sale con el medio %s',
      async (kind, medio) => {
        manager.query.mockResolvedValue([{ kind }]);
        await service.pagarDesdeUnaCaja(m(), mov);
        expect(ledger.registrar).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            direction: CashDirection.OUT,
            method: medio,
            cashBoxId: 'c1',
          }),
        );
      },
    );

    it('el cobro entra a la caja como ingreso', async () => {
      manager.query.mockResolvedValue([{ kind: 'bank' }]);
      await service.cobrarEnUnaCaja(m(), {
        ...mov,
        systemCode: CashSystemCode.INSURANCE_REIMBURSEMENT,
      });
      expect(ledger.registrar).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          direction: CashDirection.IN,
          method: CashMethod.TRANSFER,
        }),
      );
    });

    it('una caja de otra distribuidora es 404 y no registra', async () => {
      manager.query.mockResolvedValue([]);
      await expect(service.pagarDesdeUnaCaja(m(), mov)).rejects.toBeInstanceOf(
        CajaNoEncontradaError,
      );
      expect(ledger.registrar).not.toHaveBeenCalled();
    });
  });

  it('egresar sale de la caja con la categoría de sistema y el documento de origen', async () => {
    await service.egresar(m(), {
      distributorId: 'd1',
      cashBoxId: 'c1',
      amount: 1500.5,
      systemCode: CashSystemCode.PURCHASE,
      referenceType: CashReferenceType.PURCHASE_RECEIPT,
      referenceId: 'r1',
      description: 'Pago',
      userId: 'u1',
    });
    expect(categorias.deSistema).toHaveBeenCalledWith(
      manager,
      'd1',
      CashSystemCode.PURCHASE,
    );
    expect(ledger.registrar).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        direction: CashDirection.OUT,
        categoryId: 'cat1',
        cashBoxId: 'c1',
        referenceType: CashReferenceType.PURCHASE_RECEIPT,
        referenceId: 'r1',
      }),
    );
  });

  describe('medioDeLaCaja', () => {
    it.each([
      ['cash', CashMethod.CASH],
      ['bank', CashMethod.TRANSFER],
      ['wallet', CashMethod.MERCADOPAGO],
    ])('una caja %s paga con %s', async (kind, medio) => {
      manager.query.mockResolvedValue([{ kind }]);
      await expect(service.medioDeLaCaja(m(), 'd1', 'c1')).resolves.toBe(medio);
    });

    it('una caja de otra distribuidora es 404', async () => {
      manager.query.mockResolvedValue([]);
      await expect(
        service.medioDeLaCaja(m(), 'd2', 'c1'),
      ).rejects.toBeInstanceOf(CajaNoEncontradaError);
    });
  });

  it('egresar usa el medio indicado, y efectivo si no se indica', async () => {
    const egreso = {
      distributorId: 'd1',
      cashBoxId: 'c1',
      amount: 100,
      systemCode: CashSystemCode.INSURANCE,
      referenceType: CashReferenceType.INSURANCE_INSTALLMENT,
      referenceId: 'q1',
      description: 'Seguro',
      userId: 'u1',
    };
    await service.egresar(m(), { ...egreso, method: CashMethod.TRANSFER });
    await service.egresar(m(), egreso);
    expect(ledger.registrar).toHaveBeenNthCalledWith(
      1,
      manager,
      expect.objectContaining({ method: CashMethod.TRANSFER }),
    );
    expect(ledger.registrar).toHaveBeenNthCalledWith(
      2,
      manager,
      expect.objectContaining({ method: CashMethod.CASH }),
    );
  });

  describe('revertir', () => {
    const original = {
      movementId: 'mov1',
      cashBoxId: 'c1',
      direction: CashDirection.OUT,
      amount: '500.00',
      categoryId: 'cat1',
      method: 'cash',
    } as unknown as CashMovement;

    it('asienta el contraasiento: mismo importe y categoría, sentido opuesto, ligado al original', async () => {
      manager.findOne.mockResolvedValue(original);
      await service.revertir(m(), 'mov1', 'd1', 'motivo', 'u1');
      expect(ledger.bloquearCajas).toHaveBeenCalledWith(manager, ['c1'], 'd1');
      expect(ledger.registrar).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          direction: CashDirection.IN,
          amount: '500.00',
          categoryId: 'cat1',
          reversesMovementId: 'mov1',
          esContraasiento: true,
        }),
      );
    });

    it('si ya estaba anulado no asienta otra vez', async () => {
      manager.findOne.mockResolvedValue(original);
      manager.exists.mockResolvedValue(true);
      await expect(
        service.revertir(m(), 'mov1', 'd1', 'motivo', 'u1'),
      ).resolves.toBeNull();
      expect(ledger.registrar).not.toHaveBeenCalled();
    });

    it('un movimiento inexistente o ajeno es 404', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.revertir(m(), 'mov1', 'd1', 'motivo', 'u1'),
      ).rejects.toBeInstanceOf(MovimientoNoEncontradoError);
    });
  });
});
