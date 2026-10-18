import { DataSource, EntityManager } from 'typeorm';
import {
  CashLedgerService,
  RegistrarMovimiento,
} from '../../cash/application/cash-ledger.service';
import { CashCategoryService } from '../../cash/application/cash-category.service';
import { CashDirection, CashReferenceType } from '../../cash/domain/cash.enums';
import { DocumentSequenceService } from '../../document-sequence/document-sequence.service';
import { LiquidationStatus } from '../domain/commission.enums';
import { DriverLiquidation } from '../entities/driver-liquidation.entity';
import { DriverLiquidationService } from './driver-liquidation.service';

describe('DriverLiquidationService.anularPago', () => {
  let liquidacion: DriverLiquidation;
  let registrados: RegistrarMovimiento[];
  let bloqueos: string[][];
  let servicio: DriverLiquidationService;

  beforeEach(() => {
    registrados = [];
    bloqueos = [];
    liquidacion = {
      liquidationId: 'liq-1',
      distributorId: 'dist-1',
      number: 7,
      employeeId: 'emp-1',
      net: 5000,
      status: LiquidationStatus.PAID,
      cashMovementId: 'mov-pago',
      paidAt: new Date(),
      paidByUserId: 'u-1',
    } as DriverLiquidation;
    const pago = {
      movementId: 'mov-pago',
      cashBoxId: 'caja-1',
      direction: CashDirection.OUT,
      amount: 5000,
      categoryId: 'cat-com',
      method: 'cash',
    };
    const manager = {
      findOne: jest.fn((entidad: { name: string }) =>
        Promise.resolve(
          entidad.name === 'DriverLiquidation' ? liquidacion : pago,
        ),
      ),
      save: jest.fn((l: DriverLiquidation) => Promise.resolve(l)),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
      query: jest.fn(() => Promise.resolve([])),
    } as unknown as DataSource;
    const ledger = {
      bloquearCajas: jest.fn((_m: unknown, ids: string[]) => {
        bloqueos.push(ids);
        return Promise.resolve();
      }),
      registrar: jest.fn((_m: unknown, e: RegistrarMovimiento) => {
        registrados.push(e);
        return Promise.resolve({});
      }),
    } as unknown as CashLedgerService;
    servicio = new DriverLiquidationService(
      dataSource,
      {} as unknown as DocumentSequenceService,
      ledger,
      {} as unknown as CashCategoryService,
    );
  });

  it('asienta el contraasiento del pago en su caja y deja la liquidación aprobada', async () => {
    const r = await servicio.anularPago(
      'liq-1',
      'Caja equivocada',
      'dist-1',
      'u-2',
    );
    expect(bloqueos).toEqual([['caja-1']]);
    expect(registrados).toHaveLength(1);
    expect(registrados[0]).toMatchObject({
      cashBoxId: 'caja-1',
      direction: CashDirection.IN,
      amount: 5000,
      reversesMovementId: 'mov-pago',
      referenceType: CashReferenceType.REVERSAL,
      esContraasiento: true,
    });
    expect(r.liquidacion.status).toBe(LiquidationStatus.APPROVED);
    expect(r.liquidacion.cashMovementId).toBeNull();
    expect(r.liquidacion.paidAt).toBeNull();
  });

  it.each([
    LiquidationStatus.DRAFT,
    LiquidationStatus.APPROVED,
    LiquidationStatus.VOIDED,
  ])('409 si está %s y no asienta nada', async (estado) => {
    liquidacion.status = estado;
    await expect(
      servicio.anularPago('liq-1', 'x', 'dist-1', 'u-2'),
    ).rejects.toThrow('La liquidación está');
    expect(registrados).toHaveLength(0);
  });
});
