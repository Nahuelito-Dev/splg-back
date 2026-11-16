import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { CashCategoryService } from '../../cash/application/cash-category.service';
import type { CashLedgerService } from '../../cash/application/cash-ledger.service';
import type { SalesCashService } from '../../cash/application/sales-cash.service';
import {
  CashDirection,
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';
import { CashBox } from '../../cash/entities/cash-box.entity';
import { CashCollectionSettings } from '../../cash/entities/cash-collection-settings.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import {
  MpDifferenceKind,
  MpItemStatus,
  MpReconciliationStatus,
} from '../domain/mp-reconciliation.enums';
import { MpReconciliationItem } from '../entities/mp-reconciliation-item.entity';
import { MpReconciliation } from '../entities/mp-reconciliation.entity';
import { MpReconciliationApplyService } from './mp-reconciliation-apply.service';
import type { MpContexto } from './mp-reconciliation.service';

const DIST = 'dist-1';
const ADMIN: MpContexto = {
  distributorId: DIST,
  userId: 'adm-1',
  role: RoleType.ADMIN,
};
const SUPER: MpContexto = { ...ADMIN, role: RoleType.SUPER_ADMIN };

function item(
  kind: MpDifferenceKind,
  cambios: Partial<MpReconciliationItem> = {},
): MpReconciliationItem {
  return {
    itemId: `item-${kind}`,
    reconciliationId: 'rec-1',
    distributorId: DIST,
    rowKey: `key-${kind}`,
    kind,
    accountLevel: false,
    sourceId: '1003',
    paymentId: 'pay-1003',
    orderId: 'ord-1003',
    occurredAt: new Date('2026-10-03T12:00:00Z'),
    mpDescription: 'payment',
    mpAmount: 0,
    ledgerAmount: null,
    difference: null,
    extraAmount: null,
    direction: null,
    appliable: true,
    needsCashBox: false,
    note: 'nota',
    status: MpItemStatus.PENDING,
    appliedAt: null,
    appliedByUserId: null,
    appliedMovementId: null,
    targetCashBoxId: null,
    createdAt: new Date(),
    ...cambios,
  };
}

describe('MpReconciliationApplyService', () => {
  let service: MpReconciliationApplyService;
  let corrida: Partial<MpReconciliation> | null;
  let items: MpReconciliationItem[];
  let config: Partial<CashCollectionSettings> | null;
  let base: Record<string, jest.Mock>;
  let tx: Record<string, jest.Mock>;
  let aplicadasEnOtra: boolean;
  let ingresoDelPago: { cash_box_id: string; amount: string } | null;
  let egresado: string;
  type Asiento = {
    cashBoxId: string;
    direction: string;
    amount: unknown;
    categoryId: string;
    referenceType: string;
    referenceId?: string;
    description: string;
  };
  let ledger: {
    registrar: jest.Mock<Promise<{ movementId: string }>, [unknown, Asiento]>;
    bloquearCajas: jest.Mock;
  };
  let categorias: { deSistema: jest.Mock };
  let ventas: {
    asentarCobroDeMercadoPago: jest.Mock;
    asentarComision: jest.Mock;
  };
  let consultas: string[];
  let guardados: MpReconciliationItem[];

  const aplicar = (
    itemsPedidos: Array<{ itemId: string; cashBoxId?: string }>,
    ctx: MpContexto = ADMIN,
    distributorId?: string,
  ) =>
    service.aplicar(
      'rec-1',
      { items: itemsPedidos, ...(distributorId ? { distributorId } : {}) },
      ctx,
    );

  beforeEach(() => {
    corrida = {
      reconciliationId: 'rec-1',
      distributorId: DIST,
      status: MpReconciliationStatus.READY,
    };
    items = [];
    config = { mercadoPagoCashBoxId: 'wallet-1' };
    aplicadasEnOtra = false;
    ingresoDelPago = { cash_box_id: 'wallet-1', amount: '5000.00' };
    egresado = '0';
    consultas = [];
    guardados = [];
    base = {
      findOne: jest.fn((entidad: unknown) =>
        Promise.resolve(entidad === MpReconciliation ? corrida : config),
      ),
      find: jest.fn(() => Promise.resolve(items)),
    };
    tx = {
      findOne: jest.fn((_e: unknown, op: { where: { itemId: string } }) =>
        Promise.resolve(
          items.find((i) => i.itemId === op.where.itemId) ?? null,
        ),
      ),
      exists: jest.fn(() => Promise.resolve(aplicadasEnOtra)),
      save: jest.fn((i: MpReconciliationItem) => {
        guardados.push({ ...i });
        return Promise.resolve(i);
      }),
      findOneByOrFail: jest.fn((_e: unknown, c: { cashBoxId: string }) =>
        Promise.resolve({
          cashBoxId: c.cashBoxId,
          name: `Caja ${c.cashBoxId}`,
        }),
      ),
      query: jest.fn((sql: string) => {
        consultas.push(sql);
        if (/SELECT "cash_box_id", "amount" FROM "cash_movement"/.test(sql)) {
          return Promise.resolve(ingresoDelPago ? [ingresoDelPago] : []);
        }
        if (/SELECT "cash_box_id" FROM "cash_movement"/.test(sql)) {
          return Promise.resolve(
            ingresoDelPago ? [{ cash_box_id: ingresoDelPago.cash_box_id }] : [],
          );
        }
        if (/COALESCE\(SUM/.test(sql)) {
          return Promise.resolve([{ total: egresado }]);
        }
        if (/SELECT "movement_id"/.test(sql)) {
          return Promise.resolve([{ movement_id: 'mov-existente' }]);
        }
        return Promise.resolve([]);
      }),
    };
    const dataSource = {
      manager: base,
      transaction: jest.fn((cb: (m: typeof tx) => unknown) => cb(tx)),
    } as unknown as DataSource;
    let n = 0;
    ledger = {
      registrar: jest.fn<Promise<{ movementId: string }>, [unknown, Asiento]>(
        () => Promise.resolve({ movementId: `mov-${++n}` }),
      ),
      bloquearCajas: jest.fn().mockResolvedValue(undefined),
    };
    categorias = {
      deSistema: jest.fn((_m: unknown, _d: string, code: string) =>
        Promise.resolve({ categoryId: `cat-${code}` }),
      ),
    };
    ventas = {
      asentarCobroDeMercadoPago: jest.fn().mockResolvedValue('asentado'),
      asentarComision: jest.fn().mockResolvedValue('asentado'),
    };
    service = new MpReconciliationApplyService(
      dataSource,
      ledger as unknown as CashLedgerService,
      categorias as unknown as CashCategoryService,
      ventas as unknown as SalesCashService,
    );
  });

  describe('validaciones previas', () => {
    it('404 si la corrida no existe y 409 si todavía no está lista', async () => {
      corrida = null;
      await expect(aplicar([{ itemId: 'x' }])).rejects.toBeInstanceOf(
        NotFoundException,
      );

      corrida = { status: MpReconciliationStatus.REQUESTED };
      await expect(aplicar([{ itemId: 'x' }])).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('404 si una diferencia no es de la corrida', async () => {
      items = [];

      await expect(aplicar([{ itemId: 'fantasma' }])).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('un renglón repetido no corre la numeración: el 404 dice el lugar del body, sin ids', async () => {
      items = [item(MpDifferenceKind.TAX_ROW)];
      const conocida = items[0].itemId;

      const error: unknown = await aplicar([
        { itemId: conocida },
        { itemId: conocida },
        { itemId: 'fantasma' },
      ]).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as Error).message).toBe(
        'Diferencia del renglón 3 no encontrada',
      );
    });

    it('la distribuidora no ve (404) las diferencias de la cuenta; el super admin sí las asienta', async () => {
      items = [
        item(MpDifferenceKind.TAX_ROW, {
          accountLevel: true,
          mpAmount: 120,
          direction: CashDirection.OUT,
        }),
      ];

      await expect(
        aplicar([{ itemId: items[0].itemId }]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(ledger.registrar).not.toHaveBeenCalled();

      const r = await aplicar([{ itemId: items[0].itemId }], SUPER, DIST);
      expect(r.applied).toBe(1);
    });

    it('las diferencias de la cuenta piden la distribuidora destino explícita, y tiene que ser la de la corrida', async () => {
      items = [
        item(MpDifferenceKind.TAX_ROW, {
          accountLevel: true,
          mpAmount: 120,
          direction: CashDirection.OUT,
        }),
      ];

      await expect(
        aplicar([{ itemId: items[0].itemId }], SUPER),
      ).rejects.toThrow('distribuidora destino');
      await expect(
        aplicar([{ itemId: items[0].itemId }], SUPER, 'otra-dist'),
      ).rejects.toThrow('la distribuidora de la conciliación');
      expect(ledger.registrar).not.toHaveBeenCalled();
    });

    it('400 si la diferencia es sólo informativa', async () => {
      items = [item(MpDifferenceKind.AMOUNT_MISMATCH, { appliable: false })];

      await expect(
        aplicar([{ itemId: items[0].itemId }]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 si un retiro no trae la caja de destino', async () => {
      items = [
        item(MpDifferenceKind.PAYOUT, {
          accountLevel: true,
          needsCashBox: true,
          mpAmount: 9997,
        }),
      ];

      await expect(
        aplicar([{ itemId: items[0].itemId }], SUPER, DIST),
      ).rejects.toThrow('caja de destino');
    });

    it('409 si no hay caja de Mercado Pago configurada', async () => {
      items = [item(MpDifferenceKind.TAX_WITHHOLDING, { mpAmount: 30 })];
      config = { mercadoPagoCashBoxId: null };

      await expect(
        aplicar([{ itemId: items[0].itemId }]),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('asientos', () => {
    it('cobro sin ingreso: asienta con el bruto y la comisión del reporte y marca la comisión como informada', async () => {
      items = [
        item(MpDifferenceKind.PAYMENT_NOT_IN_CASH, {
          mpAmount: 2000,
          extraAmount: 100,
          direction: CashDirection.IN,
        }),
      ];

      const r = await aplicar([{ itemId: items[0].itemId }]);

      expect(ventas.asentarCobroDeMercadoPago).toHaveBeenCalledWith(tx, {
        distributorId: DIST,
        orderId: 'ord-1003',
        paymentId: 'pay-1003',
        gatewayPaymentId: '1003',
        amount: 2000,
        feeAmount: 100,
        feeUnreported: false,
        userId: 'adm-1',
      });
      expect(r).toMatchObject({ applied: 1, alreadyApplied: 0, failed: 0 });
      expect(r.results[0].movementId).toBe('mov-existente');
      expect(consultas.some((q) => q.includes('UPDATE "payment"'))).toBe(true);
      expect(guardados[0]).toMatchObject({
        status: MpItemStatus.APPLIED,
        appliedByUserId: 'adm-1',
      });
    });

    it.each([
      ['sin_caja', /no tiene configurada/],
      ['fallo', /rechazó/],
      ['sin_efecto', /nada que asentar/],
    ])(
      'si la caja responde %s la diferencia queda sin asentar',
      async (resultado, mensaje) => {
        ventas.asentarCobroDeMercadoPago.mockResolvedValue(resultado);
        items = [
          item(MpDifferenceKind.PAYMENT_NOT_IN_CASH, { mpAmount: 2000 }),
        ];

        const r = await aplicar([{ itemId: items[0].itemId }]);

        expect(r.failed).toBe(1);
        expect(r.results[0].message).toMatch(mensaje);
        expect(guardados).toHaveLength(0);
      },
    );

    it('comisión pendiente: usa el asiento de comisión de siempre', async () => {
      items = [
        item(MpDifferenceKind.FEE_PENDING, {
          mpAmount: 150,
          direction: CashDirection.OUT,
        }),
      ];

      await aplicar([{ itemId: items[0].itemId }]);

      expect(ventas.asentarComision).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ paymentId: 'pay-1003', feeAmount: 150 }),
      );
    });

    it('si otro flujo ya había asentado el cobro, queda como ya aplicado', async () => {
      ventas.asentarCobroDeMercadoPago.mockResolvedValue('ya_asentado');
      items = [item(MpDifferenceKind.PAYMENT_NOT_IN_CASH, { mpAmount: 2000 })];

      const r = await aplicar([{ itemId: items[0].itemId }]);

      expect(r).toMatchObject({ applied: 0, alreadyApplied: 1 });
      expect(guardados[0].status).toBe(MpItemStatus.APPLIED);
      expect(consultas.some((q) => q.includes('UPDATE "payment"'))).toBe(false);
    });

    it('impuestos del cobro: egreso «Impuestos y retenciones» en la caja del cobro, con la descripción de conciliación', async () => {
      ingresoDelPago = { cash_box_id: 'wallet-2', amount: '3000' };
      items = [
        item(MpDifferenceKind.TAX_WITHHOLDING, {
          mpAmount: 30,
          direction: CashDirection.OUT,
        }),
      ];

      await aplicar([{ itemId: items[0].itemId }]);

      expect(ledger.registrar).toHaveBeenCalledWith(tx, {
        distributorId: DIST,
        cashBoxId: 'wallet-2',
        direction: CashDirection.OUT,
        amount: expect.anything() as unknown,
        categoryId: `cat-${CashSystemCode.TAXES_WITHHOLDINGS}`,
        method: 'mercadopago',
        description: 'Conciliación MP 2026-10-03 — payment (1003)',
        referenceType: CashReferenceType.MP_RECONCILIATION,
        referenceId: items[0].itemId,
        userId: 'adm-1',
      });
      expect(
        String(
          (ledger.registrar.mock.calls[0][1] as { amount: unknown }).amount,
        ),
      ).toBe('30');
    });

    it('comisión distinta: egreso si Mercado Pago cobró más, ingreso como reintegro si cobró menos', async () => {
      items = [
        item(MpDifferenceKind.FEE_MISMATCH, {
          itemId: 'mas',
          difference: 20,
          direction: CashDirection.OUT,
          mpAmount: 200,
        }),
        item(MpDifferenceKind.FEE_MISMATCH, {
          itemId: 'menos',
          rowKey: 'otra',
          difference: -30,
          direction: CashDirection.IN,
          mpAmount: 150,
        }),
      ];

      await aplicar([{ itemId: 'mas' }, { itemId: 'menos' }]);

      const [mas, menos] = ledger.registrar.mock.calls.map(
        (c) =>
          c[1] as { categoryId: string; direction: string; amount: unknown },
      );
      expect(mas.categoryId).toBe(`cat-${CashSystemCode.MERCADOPAGO_FEE}`);
      expect(mas.direction).toBe('out');
      expect(String(mas.amount)).toBe('20');
      expect(menos.categoryId).toBe(
        `cat-${CashSystemCode.MERCADOPAGO_FEE_REFUND}`,
      );
      expect(menos.direction).toBe('in');
      expect(String(menos.amount)).toBe('30');
    });

    it('reintegro de comisión de una devolución: ingreso en «Reintegros de Mercado Pago»', async () => {
      items = [
        item(MpDifferenceKind.FEE_REIMBURSEMENT, {
          mpAmount: 250,
          direction: CashDirection.IN,
        }),
      ];

      await aplicar([{ itemId: items[0].itemId }]);

      expect(ledger.registrar).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          direction: CashDirection.IN,
          categoryId: `cat-${CashSystemCode.MERCADOPAGO_FEE_REFUND}`,
        }),
      );
    });

    it('impuesto suelto: sale de la caja de Mercado Pago; si Mercado Pago lo devolvió, entra como reintegro', async () => {
      items = [
        item(MpDifferenceKind.TAX_ROW, {
          itemId: 'sale',
          accountLevel: true,
          paymentId: null,
          sourceId: '9002',
          mpDescription: 'tax_payment_iibb',
          mpAmount: 120,
          direction: CashDirection.OUT,
        }),
        item(MpDifferenceKind.TAX_ROW, {
          itemId: 'entra',
          rowKey: 'k2',
          accountLevel: true,
          paymentId: null,
          mpDescription: 'tax_payment_iibb_cancel',
          mpAmount: 120,
          direction: CashDirection.IN,
        }),
      ];

      await aplicar([{ itemId: 'sale' }, { itemId: 'entra' }], SUPER, DIST);

      const [sale, entra] = ledger.registrar.mock.calls.map(
        (c) => c[1] as { cashBoxId: string; categoryId: string },
      );
      expect(sale.cashBoxId).toBe('wallet-1');
      expect(sale.categoryId).toBe(`cat-${CashSystemCode.TAXES_WITHHOLDINGS}`);
      expect(entra.categoryId).toBe(
        `cat-${CashSystemCode.MERCADOPAGO_FEE_REFUND}`,
      );
    });

    it('devolución o contracargo: egreso «Devoluciones a clientes» de la caja del cobro, referenciado al pago', async () => {
      items = [
        item(MpDifferenceKind.REFUND_MISSING, {
          mpAmount: 5000,
          direction: CashDirection.OUT,
        }),
      ];

      const r = await aplicar([{ itemId: items[0].itemId }]);

      expect(r.applied).toBe(1);
      expect(ledger.registrar).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          categoryId: `cat-${CashSystemCode.CUSTOMER_REFUND}`,
          referenceType: CashReferenceType.PAYMENT_EXTERNAL_REFUND,
          referenceId: 'pay-1003',
        }),
      );
    });

    it('una devolución nunca egresa más de lo que ingresó el cobro', async () => {
      ingresoDelPago = { cash_box_id: 'wallet-1', amount: '3000' };
      items = [item(MpDifferenceKind.REFUND_MISSING, { mpAmount: 5000 })];

      await aplicar([{ itemId: items[0].itemId }]);

      expect(
        String(
          (ledger.registrar.mock.calls[0][1] as { amount: unknown }).amount,
        ),
      ).toBe('3000');
    });

    it('si la caja ya devolvió todo lo que ingresó el cobro, no egresa más', async () => {
      egresado = '5000';
      items = [item(MpDifferenceKind.REFUND_MISSING, { mpAmount: 5000 })];

      const r = await aplicar([{ itemId: items[0].itemId }]);

      expect(r.failed).toBe(1);
      expect(r.results[0].message).toMatch(/ya devolvió todo/);
      expect(ledger.registrar).not.toHaveBeenCalled();
    });

    it('con una devolución parcial ya egresada, otra devolución parcial se asienta (sin pasar de lo ingresado)', async () => {
      egresado = '2000';
      items = [item(MpDifferenceKind.REFUND_MISSING, { mpAmount: 5000 })];

      const r = await aplicar([{ itemId: items[0].itemId }]);

      expect(r.applied).toBe(1);
      expect(
        String(
          (ledger.registrar.mock.calls[0][1] as { amount: unknown }).amount,
        ),
      ).toBe('3000');
    });

    it('devolución de un cobro que no entró a la caja: pide asentar primero el cobro', async () => {
      ingresoDelPago = null;
      items = [item(MpDifferenceKind.REFUND_MISSING, { mpAmount: 5000 })];

      const r = await aplicar([{ itemId: items[0].itemId }]);

      expect(r.results[0].message).toMatch(/asentalo primero/);
    });

    it('retiro: transferencia billetera -> caja elegida más la comisión del retiro', async () => {
      items = [
        item(MpDifferenceKind.PAYOUT, {
          accountLevel: true,
          needsCashBox: true,
          paymentId: null,
          sourceId: '9001',
          mpDescription: 'payout',
          mpAmount: 9997,
          extraAmount: 3,
          direction: CashDirection.OUT,
        }),
      ];

      const r = await aplicar(
        [{ itemId: items[0].itemId, cashBoxId: 'banco-1' }],
        SUPER,
        DIST,
      );

      expect(ledger.bloquearCajas).toHaveBeenCalledWith(
        tx,
        ['wallet-1', 'banco-1'],
        DIST,
      );
      const [salida, entrada, comision] = ledger.registrar.mock.calls.map(
        (c) =>
          c[1] as {
            cashBoxId: string;
            direction: string;
            referenceType: string;
            referenceId?: string;
            description: string;
            amount: unknown;
          },
      );
      expect(salida).toMatchObject({
        cashBoxId: 'wallet-1',
        direction: 'out',
        referenceType: 'box_transfer',
      });
      expect(String(salida.amount)).toBe('9997');
      expect(entrada).toMatchObject({
        cashBoxId: 'banco-1',
        direction: 'in',
        referenceType: 'box_transfer',
        referenceId: 'mov-1',
      });
      expect(entrada.description).toMatch(
        /^Conciliación MP 2026-10-03 — payout \(9001\) — desde/,
      );
      expect(comision).toMatchObject({
        cashBoxId: 'wallet-1',
        direction: 'out',
        referenceType: 'mp_reconciliation',
        referenceId: items[0].itemId,
      });
      expect(String(comision.amount)).toBe('3');
      expect(r.results[0].movementId).toBe('mov-1');
      expect(guardados[0].targetCashBoxId).toBe('banco-1');
    });

    it('el retiro no puede ir a la misma caja de Mercado Pago', async () => {
      items = [
        item(MpDifferenceKind.PAYOUT, {
          accountLevel: true,
          needsCashBox: true,
          mpAmount: 100,
        }),
      ];

      const r = await aplicar(
        [{ itemId: items[0].itemId, cashBoxId: 'wallet-1' }],
        SUPER,
        DIST,
      );

      expect(r.failed).toBe(1);
      expect(r.results[0].message).toMatch(/distinta/);
      expect(ledger.registrar).not.toHaveBeenCalled();
      expect(tx.findOneByOrFail).not.toHaveBeenCalledWith(
        CashBox,
        expect.anything(),
      );
    });
  });

  describe('idempotencia y fallas', () => {
    it('una diferencia ya aplicada no se vuelve a asentar', async () => {
      items = [
        item(MpDifferenceKind.TAX_WITHHOLDING, {
          mpAmount: 30,
          status: MpItemStatus.APPLIED,
          appliedMovementId: 'mov-9',
        }),
      ];

      const r = await aplicar([{ itemId: items[0].itemId }]);

      expect(r).toMatchObject({ applied: 0, alreadyApplied: 1 });
      expect(r.results[0].movementId).toBe('mov-9');
      expect(ledger.registrar).not.toHaveBeenCalled();
    });

    it('la misma fila del reporte aplicada desde otra corrida tampoco se repite', async () => {
      aplicadasEnOtra = true;
      items = [item(MpDifferenceKind.TAX_WITHHOLDING, { mpAmount: 30 })];

      const r = await aplicar([{ itemId: items[0].itemId }]);

      expect(r.alreadyApplied).toBe(1);
      expect(ledger.registrar).not.toHaveBeenCalled();
    });

    it('una fila de la cuenta asentada desde otra distribuidora tampoco se repite', async () => {
      aplicadasEnOtra = true;
      items = [
        item(MpDifferenceKind.TAX_ROW, {
          accountLevel: true,
          mpAmount: 120,
          direction: CashDirection.OUT,
        }),
      ];

      const r = await aplicar([{ itemId: items[0].itemId }], SUPER, DIST);

      expect(r.alreadyApplied).toBe(1);
      expect(ledger.registrar).not.toHaveBeenCalled();
      const [, consulta] = tx.exists.mock.calls[0] as [
        unknown,
        { where: Record<string, unknown> },
      ];
      expect(consulta.where).toEqual(
        expect.objectContaining({ accountLevel: true }),
      );
      expect(consulta.where).not.toHaveProperty('distributorId');
    });

    it('los errores de la base no llegan al cliente: queda un mensaje propio', async () => {
      ledger.registrar.mockRejectedValueOnce(
        new Error('duplicate key value violates unique constraint "UQ_x"'),
      );
      items = [item(MpDifferenceKind.TAX_WITHHOLDING, { mpAmount: 30 })];

      const r = await aplicar([{ itemId: items[0].itemId }]);

      expect(r.results[0].message).toBe(
        'Error interno: se registró en el servidor',
      );
    });

    it('impuestos devueltos: ingreso «Reintegros de Mercado Pago»', async () => {
      items = [
        item(MpDifferenceKind.TAX_REFUND, {
          mpAmount: 20,
          direction: CashDirection.IN,
        }),
      ];

      await aplicar([{ itemId: items[0].itemId }]);

      expect(ledger.registrar).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          direction: CashDirection.IN,
          categoryId: `cat-${CashSystemCode.MERCADOPAGO_FEE_REFUND}`,
        }),
      );
    });

    it('repetir el mismo item en el pedido lo asienta una vez', async () => {
      items = [item(MpDifferenceKind.TAX_WITHHOLDING, { mpAmount: 30 })];

      const r = await aplicar([
        { itemId: items[0].itemId },
        { itemId: items[0].itemId },
      ]);

      expect(r.results).toHaveLength(1);
      expect(ledger.registrar).toHaveBeenCalledTimes(1);
    });

    it('una que la caja rechaza no frena a las demás', async () => {
      ledger.registrar.mockRejectedValueOnce(
        new ConflictException('La caja está desactivada'),
      );
      items = [
        item(MpDifferenceKind.TAX_WITHHOLDING, { itemId: 'a', mpAmount: 30 }),
        item(MpDifferenceKind.FEE_REIMBURSEMENT, {
          itemId: 'b',
          rowKey: 'kb',
          mpAmount: 250,
        }),
      ];

      const r = await aplicar([{ itemId: 'a' }, { itemId: 'b' }]);

      expect(r).toMatchObject({ applied: 1, failed: 1 });
      expect(r.results[0]).toMatchObject({
        outcome: 'failed',
        message: 'La caja está desactivada',
      });
      expect(guardados.map((g) => g.itemId)).toEqual(['b']);
    });

    it('un importe en cero no genera movimiento', async () => {
      items = [item(MpDifferenceKind.TAX_WITHHOLDING, { mpAmount: 0 })];

      const r = await aplicar([{ itemId: items[0].itemId }]);

      expect(r.failed).toBe(1);
      expect(ledger.registrar).not.toHaveBeenCalled();
    });

    it('los tipos que son sólo informativos no se asientan', async () => {
      items = [item(MpDifferenceKind.UNKNOWN_PAYMENT, { accountLevel: true })];

      const r = await aplicar([{ itemId: items[0].itemId }], SUPER, DIST);

      expect(r.failed).toBe(1);
      expect(r.results[0].message).toMatch(/no se asienta desde acá/);
    });
  });
});
