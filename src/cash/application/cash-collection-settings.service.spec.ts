import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { PaymentGatewayPort } from '../../payments/domain/ports/payment-gateway.port';
import { CashBoxKind, CashReferenceType } from '../domain/cash.enums';
import { CajaNoEncontradaError } from '../domain/errors/cash.errors';
import { CashBox } from '../entities/cash-box.entity';
import { CashCollectionSettings } from '../entities/cash-collection-settings.entity';
import { CashCollectionSettingsService } from './cash-collection-settings.service';
import type {
  ResultadoDelAsiento,
  SalesCashService,
} from './sales-cash.service';

const DIST = 'dist-1';
const ADMIN = 'adm-1';

describe('CashCollectionSettingsService', () => {
  let service: CashCollectionSettingsService;
  let cajas: Record<string, Partial<CashBox>>;
  let config: CashCollectionSettings | null;
  let guardado: CashCollectionSettings | null;
  let mpPendientes: Array<Record<string, unknown>>;
  let devoluciones: Array<Record<string, unknown>>;
  let devolucionesSinEgreso: Array<Record<string, unknown>>;
  let comisiones: Array<Record<string, unknown>>;
  let pagosIngresados: Array<Record<string, unknown>>;
  let queries: string[];
  let getPayment: jest.Mock;
  let asentarSena: jest.Mock;
  let asentarComision: jest.Mock;
  let asentarExterna: jest.Mock;
  let asentarCobro: jest.Mock;
  let asentarDevolucion: jest.Mock;
  let pedidos: Array<Record<string, unknown>>;
  let pagosDelPedido: Array<Record<string, unknown>>;
  let movimientos: Array<Record<string, unknown>>;

  beforeEach(() => {
    cajas = {
      'wallet-1': {
        cashBoxId: 'wallet-1',
        name: 'Mercado Pago',
        kind: CashBoxKind.WALLET,
        isActive: true,
      },
      'bank-1': {
        cashBoxId: 'bank-1',
        name: 'Banco Nación',
        kind: CashBoxKind.BANK,
        isActive: true,
      },
      'cash-1': {
        cashBoxId: 'cash-1',
        name: 'Mostrador',
        kind: CashBoxKind.CASH,
        isActive: true,
      },
      'wallet-off': {
        cashBoxId: 'wallet-off',
        name: 'Vieja',
        kind: CashBoxKind.WALLET,
        isActive: false,
      },
    };
    config = null;
    guardado = null;
    mpPendientes = [];
    devoluciones = [];
    devolucionesSinEgreso = [];
    comisiones = [];
    pagosIngresados = [];
    queries = [];
    getPayment = jest.fn().mockRejectedValue(new Error('MP no responde'));
    asentarSena = jest.fn().mockResolvedValue('asentado');
    asentarComision = jest.fn().mockResolvedValue('asentado');
    asentarExterna = jest.fn().mockResolvedValue('asentado');
    pedidos = [];
    pagosDelPedido = [];
    movimientos = [];
    asentarCobro = jest.fn().mockResolvedValue('asentado');
    asentarDevolucion = jest.fn().mockResolvedValue('asentado');

    const manager: Record<string, jest.Mock> = {
      findOne: jest.fn(
        (entidad: unknown, opciones: { where: { cashBoxId?: string } }) => {
          if (entidad === CashCollectionSettings)
            return Promise.resolve(config);
          return Promise.resolve(cajas[opciones.where.cashBoxId ?? ''] ?? null);
        },
      ),
      create: jest.fn(
        (_e: unknown, datos: Partial<CashCollectionSettings>) => ({ ...datos }),
      ),
      save: jest.fn((fila: CashCollectionSettings) => {
        guardado = fila;
        return Promise.resolve(fila);
      }),
      find: jest.fn(() => Promise.resolve(movimientos)),
      findBy: jest.fn(() => Promise.resolve(Object.values(cajas))),
      createQueryBuilder: jest.fn(() => {
        const qb = {
          withDeleted: () => qb,
          where: () => qb,
          getMany: () => Promise.resolve(Object.values(cajas)),
        };
        return qb;
      }),
      query: jest.fn((sql: string) => {
        queries.push(sql);
        if (sql.includes("'payment_fee'")) return Promise.resolve(comisiones);
        if (sql.includes(`p."status" IN ('approved', 'in_mediation')`))
          return Promise.resolve(mpPendientes);
        if (sql.includes('FROM "payment" p'))
          return Promise.resolve(pagosIngresados);
        if (sql.includes('JOIN "payment" p'))
          return Promise.resolve(devolucionesSinEgreso);
        if (sql.includes('FROM "payment_refund"'))
          return Promise.resolve(devoluciones);
        if (sql.includes('FROM "payment"\n'))
          return Promise.resolve(pagosDelPedido);
        if (sql.includes('FROM "order" WHERE')) return Promise.resolve(pedidos);
        return Promise.resolve([]);
      }),
      transaction: jest.fn(
        (trabajo: (m: unknown) => Promise<unknown>): Promise<unknown> =>
          trabajo(manager),
      ),
    };
    const dataSource = {
      manager,
      transaction: manager.transaction,
    } as unknown as DataSource;
    service = new CashCollectionSettingsService(
      dataSource,
      {
        asentarCobroDeMercadoPago: asentarCobro,
        asentarDevolucion,
        asentarSena,
        asentarComision,
        asentarDevolucionExterna: asentarExterna,
      } as unknown as SalesCashService,
      { getPayment } as unknown as PaymentGatewayPort,
    );
  });

  describe('actualizar', () => {
    it('crea la configuración con las cajas elegidas y el autor', async () => {
      await service.actualizar(
        { mercadoPagoCashBoxId: 'wallet-1' },
        DIST,
        ADMIN,
      );

      expect(guardado).toMatchObject({
        distributorId: DIST,
        mercadoPagoCashBoxId: 'wallet-1',
        updatedByUserId: ADMIN,
      });
    });

    it('omitir un campo lo deja como está y null lo quita', async () => {
      config = {
        distributorId: DIST,
        mercadoPagoCashBoxId: 'wallet-1',
      } as CashCollectionSettings;

      await service.actualizar({}, DIST, 'adm-2');
      expect(guardado).toMatchObject({
        mercadoPagoCashBoxId: 'wallet-1',
        updatedByUserId: 'adm-2',
      });

      await service.actualizar({ mercadoPagoCashBoxId: null }, DIST, 'adm-3');
      expect(guardado).toMatchObject({
        mercadoPagoCashBoxId: null,
        updatedByUserId: 'adm-3',
      });
    });

    it('la caja de Mercado Pago tiene que ser una billetera', async () => {
      await expect(
        service.actualizar({ mercadoPagoCashBoxId: 'bank-1' }, DIST, ADMIN),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.actualizar({ mercadoPagoCashBoxId: 'cash-1' }, DIST, ADMIN),
      ).rejects.toThrow(BadRequestException);
      expect(guardado).toBeNull();
    });

    it('una caja desactivada se rechaza', async () => {
      await expect(
        service.actualizar({ mercadoPagoCashBoxId: 'wallet-off' }, DIST, ADMIN),
      ).rejects.toThrow(BadRequestException);
    });

    it('una caja inexistente o de otra distribuidora es 404', async () => {
      await expect(
        service.actualizar({ mercadoPagoCashBoxId: 'ajena' }, DIST, ADMIN),
      ).rejects.toThrow(CajaNoEncontradaError);
    });
  });

  describe('pendientes', () => {
    it('suma los cobros de Mercado Pago sin movimiento', async () => {
      mpPendientes = [
        {
          payment_id: 'p1',
          amount: '3000',
          metadata: { gatewayAmount: 2900.5 },
          approved_at: new Date('2026-10-02T12:00:00Z'),
        },
        {
          payment_id: 'p2',
          amount: '1000',
          metadata: null,
          approved_at: new Date('2026-10-05T12:00:00Z'),
        },
      ];

      const r = await service.pendientes(DIST, '2026-10-01');

      expect(r.count).toBe(2);
      expect(r.mercadoPago).toEqual({ count: 2, amount: 3900.5 });
      expect(r).not.toHaveProperty('transfer');
      expect(r).not.toHaveProperty('deposits');
      expect(r.amount).toBe(3900.5);
      expect(r.oldestAt).toEqual(new Date('2026-10-02T12:00:00Z'));
      expect(r.from).toEqual(new Date('2026-10-01T03:00:00Z'));
    });

    it('sin cobros pendientes informa cero', async () => {
      const r = await service.pendientes(DIST);
      expect(r).toMatchObject({ count: 0, amount: 0, oldestAt: null });
    });

    it('una fecha inválida es 400', async () => {
      await expect(service.pendientes(DIST, '2026-13-45')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('asentarPendientes', () => {
    beforeEach(() => {
      mpPendientes = [
        {
          payment_id: 'p1',
          order_id: 'o1',
          gateway_payment_id: 'mp1',
          amount: '3000',
          metadata: { feeAmount: 100, gatewayAmount: 3000 },
          approved_at: new Date(),
        },
      ];
    });

    it('asienta cada cobro con el administrador como autor y cuenta el resultado', async () => {
      const r = await service.asentarPendientes(DIST, '2026-10-01', ADMIN);

      expect(r).toEqual({
        settled: 1,
        alreadySettled: 0,
        withoutCashBox: 0,
        failed: 0,
        refundsSettled: 0,
        feesSettled: 0,
      });
      expect(asentarCobro).toHaveBeenCalledWith(expect.anything(), {
        distributorId: DIST,
        orderId: 'o1',
        paymentId: 'p1',
        gatewayPaymentId: 'mp1',
        amount: expect.anything() as unknown,
        feeAmount: 100,
        feeUnreported: false,
        userId: ADMIN,
      });
      expect(
        Number(
          (asentarCobro.mock.calls[0] as [unknown, { amount: unknown }])[1]
            .amount,
        ),
      ).toBe(3000);
    });

    it('al asentar tarde un cobro, saca también las devoluciones que ya se hicieron', async () => {
      devoluciones = [{ refund_id: 'r1', amount: '500' }];

      await service.asentarPendientes(DIST, '2026-10-01', ADMIN);

      expect(asentarDevolucion).toHaveBeenCalledTimes(1);
      expect(asentarDevolucion).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          paymentId: 'p1',
          refundId: 'r1',
          userId: ADMIN,
        }),
      );
    });

    it('lo que ya tenía movimiento no se cuenta como asentado ni toca las devoluciones', async () => {
      asentarCobro.mockResolvedValue(
        'ya_asentado' satisfies ResultadoDelAsiento,
      );
      devoluciones = [{ refund_id: 'r1', amount: '500' }];

      const r = await service.asentarPendientes(DIST, '2026-10-01', ADMIN);

      expect(r).toEqual({
        settled: 0,
        alreadySettled: 1,
        withoutCashBox: 0,
        failed: 0,
        refundsSettled: 0,
        feesSettled: 0,
      });
      expect(asentarDevolucion).not.toHaveBeenCalled();
    });

    it('sin caja configurada o con la caja rechazando, informa cuántos quedaron', async () => {
      asentarCobro.mockResolvedValue('sin_caja' satisfies ResultadoDelAsiento);

      const r = await service.asentarPendientes(DIST, '2026-10-01', ADMIN);

      expect(r).toEqual({
        settled: 0,
        alreadySettled: 0,
        withoutCashBox: 1,
        failed: 0,
        refundsSettled: 0,
        feesSettled: 0,
      });
    });

    it('sin cobros pendientes no asienta nada', async () => {
      mpPendientes = [];

      const r = await service.asentarPendientes(DIST, '2026-10-01', ADMIN);

      expect(r).toEqual({
        settled: 0,
        alreadySettled: 0,
        withoutCashBox: 0,
        failed: 0,
        refundsSettled: 0,
        feesSettled: 0,
      });
      expect(asentarCobro).not.toHaveBeenCalled();
    });
  });

  describe('devoluciones y comisiones pendientes', () => {
    it('las devoluciones cerradas sin egreso (con el cobro adentro) cuentan y se asientan con el administrador como autor', async () => {
      devolucionesSinEgreso = [
        {
          refund_id: 'r9',
          payment_id: 'p9',
          order_id: 'o9',
          gateway_payment_id: 'mp9',
          amount: '700',
          refunded_at: new Date('2026-10-05T12:00:00Z'),
        },
      ];

      const pendiente = await service.pendientes(DIST, '2026-10-01');
      expect(pendiente.refunds).toEqual({ count: 1, amount: 700 });
      expect(pendiente.count).toBe(1);

      const r = await service.asentarPendientes(DIST, '2026-10-01', ADMIN);
      expect(asentarDevolucion).toHaveBeenCalledWith(expect.anything(), {
        distributorId: DIST,
        orderId: 'o9',
        paymentId: 'p9',
        refundId: 'r9',
        gatewayPaymentId: 'mp9',
        amount: '700',
        userId: ADMIN,
      });
      expect(r.refundsSettled).toBe(1);
    });

    it('un cobro histórico sin datos guardados le pregunta a Mercado Pago lo cobrado y la comisión, y lo guarda', async () => {
      mpPendientes = [
        {
          payment_id: 'p1',
          order_id: 'o1',
          gateway_payment_id: 'mp1',
          credential_id: 'cred-1',
          amount: '3000',
          metadata: null,
          approved_at: new Date(),
        },
      ];
      getPayment.mockResolvedValue({
        id: 'mp1',
        status: 'approved',
        externalReference: 'o1',
        amount: 2950,
        feeAmount: 140,
        refundedAmount: 0,
      });

      await service.asentarPendientes(DIST, '2026-10-01', ADMIN);

      expect(getPayment).toHaveBeenCalledWith('mp1', 'cred-1');
      const llamada = asentarCobro.mock.calls[0] as [
        unknown,
        { amount: unknown; feeAmount: number; feeUnreported: boolean },
      ];
      expect(Number(llamada[1].amount)).toBe(2950);
      expect(llamada[1].feeAmount).toBe(140);
      expect(llamada[1].feeUnreported).toBe(false);
      expect(
        queries.some((q) => q.includes('UPDATE "payment" SET "metadata"')),
      ).toBe(true);
    });

    it('si Mercado Pago no responde asienta por el importe del ledger, sin comisión y marcado', async () => {
      mpPendientes = [
        {
          payment_id: 'p1',
          order_id: 'o1',
          gateway_payment_id: 'mp1',
          amount: '3000',
          metadata: null,
          approved_at: new Date(),
        },
      ];

      const r = await service.asentarPendientes(DIST, '2026-10-01', ADMIN);

      const llamada = asentarCobro.mock.calls[0] as [
        unknown,
        { amount: unknown; feeAmount: number | null; feeUnreported: boolean },
      ];
      expect(Number(llamada[1].amount)).toBe(3000);
      expect(llamada[1].feeAmount).toBeNull();
      expect(llamada[1].feeUnreported).toBe(true);
      expect(r.settled).toBe(1);
    });

    it('lo guardado por el webhook no vuelve a consultarse a Mercado Pago', async () => {
      mpPendientes = [
        {
          payment_id: 'p1',
          order_id: 'o1',
          gateway_payment_id: 'mp1',
          amount: '3000',
          metadata: { gatewayAmount: 3000, feeAmount: 100 },
          approved_at: new Date(),
        },
      ];
      await service.asentarPendientes(DIST, '2026-10-01', ADMIN);
      expect(getPayment).not.toHaveBeenCalled();
    });

    it('la comisión que faltó se asienta después con la guardada, o con la que informe Mercado Pago ahora', async () => {
      comisiones = [
        {
          payment_id: 'pa',
          order_id: 'oa',
          gateway_payment_id: 'mpa',
          metadata: { feeAmount: 80 },
        },
        {
          payment_id: 'pb',
          order_id: 'ob',
          gateway_payment_id: 'mpb',
          credential_id: 'cred-b',
          metadata: { feeStatus: 'unreported', feeAmount: null },
        },
        {
          payment_id: 'pc',
          order_id: 'oc',
          gateway_payment_id: 'mpc',
          metadata: { feeStatus: 'unreported', feeAmount: null },
        },
      ];
      getPayment.mockImplementation((id: string) =>
        id === 'mpb'
          ? Promise.resolve({
              id,
              status: 'approved',
              externalReference: 'ob',
              feeAmount: 55,
            })
          : Promise.reject(new Error('MP no responde')),
      );

      const r = await service.asentarPendientes(DIST, '2026-10-01', ADMIN);

      expect(asentarComision).toHaveBeenCalledTimes(2);
      expect(asentarComision).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          paymentId: 'pa',
          feeAmount: 80,
          userId: ADMIN,
        }),
      );
      expect(asentarComision).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ paymentId: 'pb', feeAmount: 55 }),
      );
      expect(getPayment).toHaveBeenCalledWith('mpb', 'cred-b');
      expect(r.feesSettled).toBe(2);
    });

    it('lo devuelto por Mercado Pago por su cuenta se retoma con lo guardado en el pago', async () => {
      pagosIngresados = [
        {
          payment_id: 'pd',
          order_id: 'od',
          gateway_payment_id: 'mpd',
          metadata: { gatewayRefunded: 900, gatewayStatus: 'charged_back' },
        },
        {
          payment_id: 'pe',
          order_id: 'oe',
          gateway_payment_id: 'mpe',
          metadata: {},
        },
      ];

      const r = await service.asentarPendientes(DIST, '2026-10-01', ADMIN);

      expect(asentarExterna).toHaveBeenCalledTimes(1);
      expect(asentarExterna).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          paymentId: 'pd',
          refundedTotal: 900,
          contracargo: true,
          userId: ADMIN,
        }),
      );
      expect(r.refundsSettled).toBe(1);
    });
  });

  describe('fecha desde', () => {
    it('no se asienta más de un año hacia atrás', async () => {
      await expect(
        service.asentarPendientes(DIST, '2020-01-01', ADMIN),
      ).rejects.toThrow(BadRequestException);
      await expect(service.pendientes(DIST, '2020-01-01')).rejects.toThrow(
        /365/,
      );
    });
  });

  describe('delPedido', () => {
    it('un pedido de otra distribuidora o inexistente es 404', async () => {
      await expect(service.delPedido('o1', DIST)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('un pago devuelto por completo que nunca se asentó no figura como cobro sin asentar', async () => {
      pedidos = [
        {
          payment_method: 'mercadopago',
          payment_status: 'paid',
          total: '1000',
          deposit_amount: '0',
          deposit_paid: false,
          confirmed_at: null,
          deposit_paid_at: null,
        },
      ];
      pagosDelPedido = [
        {
          payment_id: 'p1',
          status: 'refunded',
          amount: '1000',
          metadata: null,
          approved_at: new Date(),
        },
        {
          payment_id: 'p2',
          status: 'approved',
          amount: '500',
          metadata: null,
          approved_at: new Date(),
        },
      ];

      const r = await service.delPedido('o1', DIST);

      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]).toMatchObject({ amount: 500, settled: false });
    });

    it('la seña confirmada a mano figura con su movimiento', async () => {
      pedidos = [
        {
          payment_method: 'cash',
          payment_status: 'pending',
          total: '4500',
          deposit_amount: '1000',
          deposit_paid: true,
          confirmed_at: null,
          deposit_paid_at: new Date('2026-10-04T00:00:00Z'),
        },
      ];
      movimientos = [
        {
          movementId: 'mov-s',
          cashBoxId: 'bank-1',
          referenceType: CashReferenceType.ORDER_DEPOSIT,
          referenceId: 'o1',
        },
      ];

      const r = await service.delPedido('o1', DIST);

      expect(r.entries).toEqual([
        expect.objectContaining({
          kind: 'deposit',
          amount: 1000,
          settled: true,
          cashBoxName: 'Banco Nación',
        }),
      ]);
    });

    it('muestra el cobro de Mercado Pago con su movimiento y NO muestra la transferencia vieja (no aplica)', async () => {
      pedidos = [
        {
          payment_method: 'transfer',
          payment_status: 'paid',
          total: '4500',
          deposit_amount: '0',
          deposit_paid: false,
          confirmed_at: new Date('2026-10-03T00:00:00Z'),
        },
      ];
      pagosDelPedido = [
        {
          payment_id: 'p1',
          amount: '1000',
          metadata: null,
          approved_at: new Date('2026-10-02T00:00:00Z'),
        },
      ];
      movimientos = [
        {
          movementId: 'mov-1',
          cashBoxId: 'wallet-1',
          referenceType: CashReferenceType.PAYMENT,
          referenceId: 'p1',
        },
      ];

      const r = await service.delPedido('o1', DIST);

      expect(r.entries).toEqual([
        {
          kind: 'mercadopago',
          amount: 1000,
          collectedAt: new Date('2026-10-02T00:00:00Z'),
          settled: true,
          movementId: 'mov-1',
          cashBoxId: 'wallet-1',
          cashBoxName: 'Mercado Pago',
        },
      ]);
    });

    it('una seña vieja por transferencia no figura ni se enlaza a una caja', async () => {
      pedidos = [
        {
          payment_method: 'transfer',
          payment_status: 'pending',
          total: '4500',
          deposit_amount: '1000',
          deposit_paid: true,
          confirmed_at: null,
          deposit_paid_at: new Date('2026-10-04T00:00:00Z'),
        },
      ];
      movimientos = [
        {
          movementId: 'mov-s',
          cashBoxId: 'bank-1',
          referenceType: CashReferenceType.ORDER_DEPOSIT,
          referenceId: 'o1',
        },
      ];

      const r = await service.delPedido('o1', DIST);

      expect(r.entries).toEqual([]);
    });
  });
});
