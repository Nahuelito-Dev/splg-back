import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CashDocumentPaymentService } from '../cash/application/cash-document-payment.service';
import { CashReferenceType, CashSystemCode } from '../cash/domain/cash.enums';
import { Tire } from './entities/tire.entity';
import { VehicleAccident } from './entities/vehicle-accident.entity';
import { FleetExpensePaymentService } from './fleet-expense-payment.service';

const CAJA = '0b0f5f0e-6a53-4a39-8f0d-0c5ad4b6f003';

describe('FleetExpensePaymentService (caja completa, etapa 2)', () => {
  let service: FleetExpensePaymentService;
  let pagos: { pagarDesdeUnaCaja: jest.Mock; cobrarEnUnaCaja: jest.Mock };
  let neumatico: Tire | null;
  let siniestro: VehicleAccident | null;
  let guardados: unknown[];
  let transaction: jest.Mock;

  const tire = (over: Partial<Tire> = {}) =>
    ({
      tireId: 't1',
      distributorId: 'd1',
      brand: 'Pirelli',
      size: '205/55R16',
      serialNumber: 'S-1',
      cost: 120000,
      createdAt: new Date('2026-10-01T12:00:00.000Z'),
      cashMovementId: null,
      paidAt: null,
      ...over,
    }) as Tire;
  const accident = (over: Partial<VehicleAccident> = {}) =>
    ({
      accidentId: 's1',
      distributorId: 'd1',
      carId: 'c1',
      occurredAt: new Date('2026-10-10T15:00:00.000Z'),
      closedAt: null,
      repairCost: null,
      deductibleAmount: null,
      insurerReimbursement: null,
      paymentCashMovementId: null,
      reimbursementCashMovementId: null,
      ...over,
    }) as VehicleAccident;

  beforeEach(() => {
    neumatico = tire();
    siniestro = accident();
    guardados = [];
    pagos = {
      pagarDesdeUnaCaja: jest.fn().mockResolvedValue({ movementId: 'mov1' }),
      cobrarEnUnaCaja: jest.fn().mockResolvedValue({ movementId: 'mov2' }),
    };
    const manager = {
      getRepository: (entidad: unknown) => ({
        findOne: () =>
          Promise.resolve(entidad === Tire ? neumatico : siniestro),
        save: (x: unknown) => {
          guardados.push(x);
          return Promise.resolve(x);
        },
      }),
      query: jest.fn().mockResolvedValue([{ patente: 'AB123CD' }]),
    };
    transaction = jest.fn((cb: (m: unknown) => unknown) => cb(manager));
    service = new FleetExpensePaymentService(
      { transaction } as unknown as DataSource,
      pagos as unknown as CashDocumentPaymentService,
    );
  });

  const dto = { cashBoxId: CAJA, paidAt: '2026-10-28T12:00:00-03:00' };

  describe('neumático', () => {
    it('egresa el costo con la categoría «Neumáticos» y lo deja pago', async () => {
      await service.pagarNeumatico('t1', dto, 'd1', 'u1');
      expect(pagos.pagarDesdeUnaCaja).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          cashBoxId: CAJA,
          amount: 120000,
          systemCode: CashSystemCode.TIRES,
          referenceType: CashReferenceType.TIRE,
          referenceId: 't1',
        }),
      );
      expect(neumatico).toMatchObject({
        cashMovementId: 'mov1',
        paidAt: new Date('2026-10-28T15:00:00.000Z'),
      });
      expect(guardados).toHaveLength(1);
    });

    it('ya pago es 409 y no asienta', async () => {
      neumatico = tire({ cashMovementId: 'm0' });
      await expect(
        service.pagarNeumatico('t1', dto, 'd1', 'u1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(pagos.pagarDesdeUnaCaja).not.toHaveBeenCalled();
    });

    it('paidAt anterior a la compra del neumático es 400', async () => {
      await expect(
        service.pagarNeumatico(
          't1',
          { ...dto, paidAt: '2026-09-15' },
          'd1',
          'u1',
        ),
      ).rejects.toThrow(/anterior a la compra/);
      expect(pagos.pagarDesdeUnaCaja).not.toHaveBeenCalled();
    });

    it('otra distribuidora es 404', async () => {
      neumatico = null;
      await expect(
        service.pagarNeumatico('t1', dto, 'd2', 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sin costo es 409', async () => {
      neumatico = tire({ cost: 0 });
      await expect(
        service.pagarNeumatico('t1', dto, 'd1', 'u1'),
      ).rejects.toThrow(/costo/);
    });

    it('paidAt futuro es 400 sin abrir transacción', async () => {
      const manana = new Date(Date.now() + 86400000).toISOString();
      await expect(
        service.pagarNeumatico('t1', { ...dto, paidAt: manana }, 'd1', 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transaction).not.toHaveBeenCalled();
    });

    it('si la caja rechaza (sin sesión), no queda pago', async () => {
      pagos.pagarDesdeUnaCaja.mockRejectedValue(
        new ConflictException('La caja exige una sesión abierta'),
      );
      await expect(
        service.pagarNeumatico('t1', dto, 'd1', 'u1'),
      ).rejects.toThrow(/sesión abierta/);
      expect(guardados).toHaveLength(0);
    });
  });

  describe('siniestro: pago de la empresa', () => {
    const pago = { ...dto, amount: 85000 };

    it('egresa con la categoría «Siniestros» y guarda movimiento, fecha e importe', async () => {
      await service.pagarSiniestro('s1', pago, 'd1', 'u1');
      expect(pagos.pagarDesdeUnaCaja).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          amount: 85000,
          systemCode: CashSystemCode.VEHICLE_ACCIDENT,
          referenceType: CashReferenceType.VEHICLE_ACCIDENT,
        }),
      );
      expect(siniestro).toMatchObject({
        paymentCashMovementId: 'mov1',
        paymentAmount: 85000,
      });
    });

    it('uno solo por siniestro (409)', async () => {
      siniestro = accident({ paymentCashMovementId: 'm0' });
      await expect(
        service.pagarSiniestro('s1', pago, 'd1', 'u1'),
      ).rejects.toThrow(/ya tiene su pago/);
    });

    it('cerrado, no supera la reparación ni la franquicia (400)', async () => {
      siniestro = accident({
        closedAt: new Date(),
        repairCost: 80000,
        deductibleAmount: 10000,
      });
      await expect(
        service.pagarSiniestro('s1', pago, 'd1', 'u1'),
      ).rejects.toThrow(/amount/);
      expect(pagos.pagarDesdeUnaCaja).not.toHaveBeenCalled();
    });

    it('no puede ser anterior al siniestro (400)', async () => {
      await expect(
        service.pagarSiniestro(
          's1',
          { ...pago, paidAt: '2026-10-01' },
          'd1',
          'u1',
        ),
      ).rejects.toThrow(/anterior/);
    });

    it('otra distribuidora es 404', async () => {
      siniestro = null;
      await expect(
        service.pagarSiniestro('s1', pago, 'd2', 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('siniestro: reintegro del seguro', () => {
    const cobro = {
      cashBoxId: CAJA,
      receivedAt: '2026-10-28',
      amount: 60000,
    };

    it('ingresa a la caja con la categoría «Reintegros de seguros»', async () => {
      await service.registrarReintegro('s1', cobro, 'd1', 'u1');
      expect(pagos.cobrarEnUnaCaja).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          amount: 60000,
          systemCode: CashSystemCode.INSURANCE_REIMBURSEMENT,
          referenceType: CashReferenceType.INSURANCE_REIMBURSEMENT,
        }),
      );
      expect(pagos.pagarDesdeUnaCaja).not.toHaveBeenCalled();
      expect(siniestro).toMatchObject({
        reimbursementCashMovementId: 'mov2',
        reimbursementAmount: 60000,
      });
    });

    it('uno solo por siniestro (409)', async () => {
      siniestro = accident({ reimbursementCashMovementId: 'm0' });
      await expect(
        service.registrarReintegro('s1', cobro, 'd1', 'u1'),
      ).rejects.toThrow(/ya tiene su reintegro/);
    });

    it('cerrado sin reintegro es 409; con reintegro menor es 400', async () => {
      siniestro = accident({ closedAt: new Date(), insurerReimbursement: 0 });
      await expect(
        service.registrarReintegro('s1', cobro, 'd1', 'u1'),
      ).rejects.toBeInstanceOf(ConflictException);
      siniestro = accident({
        closedAt: new Date(),
        insurerReimbursement: 50000,
      });
      await expect(
        service.registrarReintegro('s1', cobro, 'd1', 'u1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
