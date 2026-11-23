import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { EntityManager } from 'typeorm';
import { EVENTO_NOTIFICAR_ADMIN } from '../../common/events/notificar-admin.event';
import {
  CashDirection,
  CashMethod,
  CashReferenceType,
  CashSystemCode,
} from '../domain/cash.enums';
import { CashCollectionSettings } from '../entities/cash-collection-settings.entity';
import { CashMovement } from '../entities/cash-movement.entity';
import type { CashCategoryService } from './cash-category.service';
import type {
  CashLedgerService,
  RegistrarMovimiento,
} from './cash-ledger.service';
import { SalesCashService } from './sales-cash.service';

const DIST = 'dist-1';
const ORDER = '11111111-2222-3333-4444-555555abcdef';

describe('SalesCashService', () => {
  let service: SalesCashService;
  let registrar: jest.Mock<
    Promise<{ movementId: string }>,
    [unknown, RegistrarMovimiento]
  >;
  let deSistema: jest.Mock;
  let emit: jest.Mock;
  let config: Partial<CashCollectionSettings> | null;
  let asentados: Array<{
    referenceType: CashReferenceType;
    referenceId: string;
  }>;
  let ingreso: Partial<CashMovement> | null;
  let egresado: number;
  let comprometido: number;
  let manager: EntityManager;

  beforeEach(() => {
    config = {
      distributorId: DIST,
      mercadoPagoCashBoxId: 'wallet-1',
      updatedByUserId: 'adm-1',
    };
    asentados = [];
    ingreso = null;
    egresado = 0;
    comprometido = 0;
    registrar = jest.fn((_m: unknown, e: RegistrarMovimiento) => {
      asentados.push({
        referenceType: e.referenceType ?? CashReferenceType.MANUAL,
        referenceId: e.referenceId ?? '',
      });
      return Promise.resolve({ movementId: 'mov' });
    });
    deSistema = jest.fn((_m: unknown, _d: string, code: CashSystemCode) =>
      Promise.resolve({ categoryId: `cat-${code}` }),
    );
    emit = jest.fn();
    const m: Record<string, jest.Mock> = {
      findOne: jest.fn((entidad: unknown) =>
        Promise.resolve(entidad === CashCollectionSettings ? config : ingreso),
      ),
      exists: jest.fn(
        (
          _e: unknown,
          {
            where,
          }: {
            where: { referenceType: CashReferenceType; referenceId: string };
          },
        ) =>
          Promise.resolve(
            asentados.some(
              (a) =>
                a.referenceType === where.referenceType &&
                a.referenceId === where.referenceId,
            ),
          ),
      ),
      query: jest.fn((sql: string) =>
        Promise.resolve([
          { total: String(sql.includes('SELECT (') ? comprometido : egresado) },
        ]),
      ),
      transaction: jest.fn(
        (trabajo: (x: unknown) => Promise<void>): Promise<void> => trabajo(m),
      ),
    };
    manager = m as unknown as EntityManager;
    service = new SalesCashService(
      { registrar } as unknown as CashLedgerService,
      { deSistema } as unknown as CashCategoryService,
      { emit } as unknown as EventEmitter2,
    );
  });

  describe('asentarCobroDeMercadoPago', () => {
    const cobro = {
      distributorId: DIST,
      orderId: ORDER,
      paymentId: 'pay-1',
      gatewayPaymentId: 'mp-99',
      amount: 3000,
      feeAmount: 149.5,
    };

    it('entra a la caja de Mercado Pago y asienta la comisión como egreso', async () => {
      expect(await service.asentarCobroDeMercadoPago(manager, cobro)).toBe(
        'asentado',
      );

      expect(registrar).toHaveBeenCalledTimes(2);
      expect(registrar.mock.calls[0][1]).toMatchObject({
        cashBoxId: 'wallet-1',
        direction: CashDirection.IN,
        categoryId: `cat-${CashSystemCode.ORDER_PAYMENT}`,
        method: CashMethod.MERCADOPAGO,
        referenceType: CashReferenceType.PAYMENT,
        referenceId: 'pay-1',
        description: 'Pedido #ABCDEF — Mercado Pago mp-99',
        userId: null,
      });
      expect(Number(registrar.mock.calls[0][1].amount)).toBe(3000);
      expect(registrar.mock.calls[1][1]).toMatchObject({
        cashBoxId: 'wallet-1',
        direction: CashDirection.OUT,
        categoryId: `cat-${CashSystemCode.MERCADOPAGO_FEE}`,
        referenceType: CashReferenceType.PAYMENT_FEE,
        referenceId: 'pay-1',
      });
      expect(Number(registrar.mock.calls[1][1].amount)).toBe(149.5);
    });

    it.each([null, undefined, 0])(
      'sin comisión (%s) asienta sólo el ingreso',
      async (fee) => {
        await service.asentarCobroDeMercadoPago(manager, {
          ...cobro,
          feeAmount: fee,
        });
        expect(registrar).toHaveBeenCalledTimes(1);
      },
    );

    it('repetirlo no asienta otra vez', async () => {
      await service.asentarCobroDeMercadoPago(manager, cobro);
      registrar.mockClear();

      expect(await service.asentarCobroDeMercadoPago(manager, cobro)).toBe(
        'ya_asentado',
      );
      expect(registrar).not.toHaveBeenCalled();
    });

    it('sin caja de Mercado Pago configurada no asienta nada', async () => {
      config = { ...config, mercadoPagoCashBoxId: null };
      expect(await service.asentarCobroDeMercadoPago(manager, cobro)).toBe(
        'sin_caja',
      );
      config = null;
      expect(await service.asentarCobroDeMercadoPago(manager, cobro)).toBe(
        'sin_caja',
      );
      expect(registrar).not.toHaveBeenCalled();
    });

    it('si la caja lo rechaza no lanza: devuelve fallo', async () => {
      registrar.mockRejectedValueOnce(new Error('La caja está desactivada'));
      expect(await service.asentarCobroDeMercadoPago(manager, cobro)).toBe(
        'fallo',
      );
    });

    it('usa el autor que se le pasa (el administrador que asienta lo pendiente)', async () => {
      await service.asentarCobroDeMercadoPago(manager, {
        ...cobro,
        userId: 'adm-2',
      });
      expect(registrar.mock.calls[0][1].userId).toBe('adm-2');
    });
  });

  describe('asentarDevolucion', () => {
    const devolucion = {
      distributorId: DIST,
      orderId: ORDER,
      paymentId: 'pay-1',
      refundId: 'ref-1',
      gatewayPaymentId: 'mp-99',
      amount: 1000,
    };

    it('sale de la caja donde entró el cobro, como devolución a clientes', async () => {
      ingreso = { cashBoxId: 'wallet-viejo', amount: 3000 };

      expect(await service.asentarDevolucion(manager, devolucion)).toBe(
        'asentado',
      );

      expect(registrar.mock.calls[0][1]).toMatchObject({
        cashBoxId: 'wallet-viejo',
        direction: CashDirection.OUT,
        categoryId: `cat-${CashSystemCode.CUSTOMER_REFUND}`,
        method: CashMethod.MERCADOPAGO,
        referenceType: CashReferenceType.PAYMENT_REFUND,
        referenceId: 'ref-1',
        userId: null,
      });
      expect(Number(registrar.mock.calls[0][1].amount)).toBe(1000);
    });

    it('un cobro que nunca entró a una caja no tiene egreso', async () => {
      expect(await service.asentarDevolucion(manager, devolucion)).toBe(
        'sin_efecto',
      );
      expect(registrar).not.toHaveBeenCalled();
    });

    it('una devolución ya asentada no se repite', async () => {
      ingreso = { cashBoxId: 'wallet-1', amount: 3000 };
      await service.asentarDevolucion(manager, devolucion);
      registrar.mockClear();

      expect(await service.asentarDevolucion(manager, devolucion)).toBe(
        'ya_asentado',
      );
      expect(registrar).not.toHaveBeenCalled();
    });
  });

  it('ya no existe el asiento de transferencias', () => {
    expect(
      (service as unknown as Record<string, unknown>).asentarTransferencia,
    ).toBeUndefined();
  });

  describe('autor y comisión pendiente', () => {
    const cobro = {
      distributorId: DIST,
      orderId: ORDER,
      paymentId: 'pay-1',
      gatewayPaymentId: 'mp-99',
      amount: 3000,
    };

    it('el cobro del webhook queda sin autor: nunca el usuario de la configuración', async () => {
      await service.asentarCobroDeMercadoPago(manager, {
        ...cobro,
        feeAmount: 100,
      });
      expect(registrar.mock.calls.map((c) => c[1].userId)).toEqual([
        null,
        null,
      ]);
    });

    it('sin comisión informada lo anota en la descripción para completarlo después', async () => {
      await service.asentarCobroDeMercadoPago(manager, {
        ...cobro,
        feeAmount: null,
        feeUnreported: true,
      });
      expect(registrar.mock.calls[0][1].description).toBe(
        'Pedido #ABCDEF — Mercado Pago mp-99 (sin comisión informada)',
      );
    });

    it('la comisión de un cobro ya asentado sale de la misma caja, una sola vez', async () => {
      ingreso = { cashBoxId: 'wallet-viejo', amount: 3000 };
      const c = {
        distributorId: DIST,
        orderId: ORDER,
        paymentId: 'pay-1',
        gatewayPaymentId: 'mp-99',
        feeAmount: 120.5,
        userId: 'adm-3',
      };

      expect(await service.asentarComision(manager, c)).toBe('asentado');
      expect(registrar.mock.calls[0][1]).toMatchObject({
        cashBoxId: 'wallet-viejo',
        direction: CashDirection.OUT,
        categoryId: `cat-${CashSystemCode.MERCADOPAGO_FEE}`,
        referenceType: CashReferenceType.PAYMENT_FEE,
        userId: 'adm-3',
      });
      expect(await service.asentarComision(manager, c)).toBe('ya_asentado');
    });

    it('la comisión de un cobro que nunca entró a una caja no se asienta', async () => {
      expect(
        await service.asentarComision(manager, {
          distributorId: DIST,
          orderId: ORDER,
          paymentId: 'pay-1',
          gatewayPaymentId: 'mp-99',
          feeAmount: 10,
        }),
      ).toBe('sin_efecto');
    });
  });

  describe('tope de las devoluciones', () => {
    it('una devolución propia nunca saca más de lo que ingresó el pago', async () => {
      ingreso = { cashBoxId: 'wallet-1', amount: 3000 };
      egresado = 2500;

      await service.asentarDevolucion(manager, {
        distributorId: DIST,
        orderId: ORDER,
        paymentId: 'pay-1',
        refundId: 'ref-1',
        gatewayPaymentId: 'mp-99',
        amount: 1000,
        userId: 'adm-9',
      });

      expect(Number(registrar.mock.calls[0][1].amount)).toBe(500);
      expect(registrar.mock.calls[0][1].userId).toBe('adm-9');
    });

    it('con todo lo ingresado ya devuelto no asienta nada', async () => {
      ingreso = { cashBoxId: 'wallet-1', amount: 3000 };
      egresado = 3000;
      expect(
        await service.asentarDevolucion(manager, {
          distributorId: DIST,
          orderId: ORDER,
          paymentId: 'pay-1',
          refundId: 'ref-1',
          gatewayPaymentId: 'mp-99',
          amount: 1000,
        }),
      ).toBe('sin_efecto');
    });
  });

  describe('asentarDevolucionExterna', () => {
    const externa = {
      distributorId: DIST,
      orderId: ORDER,
      paymentId: 'pay-1',
      gatewayPaymentId: 'mp-99',
      refundedTotal: 1200,
      contracargo: false,
    };

    it('egresa la diferencia entre lo devuelto según Mercado Pago y lo ya comprometido', async () => {
      ingreso = { cashBoxId: 'wallet-1', amount: 3000 };
      comprometido = 500;
      egresado = 500;

      expect(await service.asentarDevolucionExterna(manager, externa)).toBe(
        'asentado',
      );

      expect(registrar.mock.calls[0][1]).toMatchObject({
        cashBoxId: 'wallet-1',
        direction: CashDirection.OUT,
        categoryId: `cat-${CashSystemCode.CUSTOMER_REFUND}`,
        referenceType: CashReferenceType.PAYMENT_EXTERNAL_REFUND,
        referenceId: 'pay-1',
        userId: null,
        description:
          'Devolución desde Mercado Pago — pedido #ABCDEF, Mercado Pago mp-99',
      });
      expect(Number(registrar.mock.calls[0][1].amount)).toBe(700);
    });

    it('un contracargo lo dice en la descripción', async () => {
      ingreso = { cashBoxId: 'wallet-1', amount: 3000 };
      await service.asentarDevolucionExterna(manager, {
        ...externa,
        refundedTotal: 3000,
        contracargo: true,
      });
      expect(registrar.mock.calls[0][1].description).toMatch(/^Contracargo/);
    });

    it('repetir la notificación no duplica: lo ya egresado cuenta como comprometido', async () => {
      ingreso = { cashBoxId: 'wallet-1', amount: 3000 };
      comprometido = 1200;
      egresado = 1200;
      expect(await service.asentarDevolucionExterna(manager, externa)).toBe(
        'sin_efecto',
      );
      expect(registrar).not.toHaveBeenCalled();
    });

    it('lo que ya se pidió devolver desde el sistema (solicitud en curso) no se egresa dos veces', async () => {
      ingreso = { cashBoxId: 'wallet-1', amount: 3000 };
      comprometido = 1200;
      egresado = 0;
      expect(await service.asentarDevolucionExterna(manager, externa)).toBe(
        'sin_efecto',
      );
    });

    it('nunca más de lo ingresado, aunque Mercado Pago informe de más', async () => {
      ingreso = { cashBoxId: 'wallet-1', amount: 3000 };
      egresado = 2000;
      await service.asentarDevolucionExterna(manager, {
        ...externa,
        refundedTotal: 9999,
      });
      expect(Number(registrar.mock.calls[0][1].amount)).toBe(1000);
    });

    it('un cobro que nunca entró a una caja no tiene egreso', async () => {
      expect(await service.asentarDevolucionExterna(manager, externa)).toBe(
        'sin_efecto',
      );
    });
  });

  describe('M-1: contracargo sobre un pago con un reintegro parcial previo', () => {
    it('express 10000: reintegro del recargo 1500, después contracargo → el egreso es 8500 (el total menos lo ya devuelto)', async () => {
      ingreso = { cashBoxId: 'wallet-1', amount: 10000 };
      comprometido = 1500;
      egresado = 1500;

      await service.asentarDevolucionExterna(manager, {
        distributorId: DIST,
        orderId: ORDER,
        paymentId: 'pay-1',
        gatewayPaymentId: 'mp-99',
        refundedTotal: 10000,
        contracargo: true,
      });

      expect(Number(registrar.mock.calls[0][1].amount)).toBe(8500);
      expect(registrar.mock.calls[0][1].description).toMatch(/^Contracargo/);
    });
  });

  describe('M-2: contracargo reintegrado al comercio (status_detail reimbursed)', () => {
    const datos = {
      distributorId: DIST,
      orderId: ORDER,
      paymentId: 'pay-1',
      gatewayPaymentId: 'mp-99',
      automatico: true,
    };
    const filas = (...f: Array<[string, string, string]>) => {
      (manager as unknown as { query: jest.Mock }).query = jest
        .fn()
        .mockResolvedValue(
          f.map(([cash_box_id, direction, total]) => ({
            cash_box_id,
            direction,
            total,
          })),
        );
    };

    it('hace el contra-asiento: ingreso a la misma caja por lo que salió como contracargo', async () => {
      filas(['wallet-1', 'out', '8500.00']);

      expect(await service.asentarContracargoReintegrado(manager, datos)).toBe(
        'asentado',
      );

      expect(registrar.mock.calls[0][1]).toMatchObject({
        cashBoxId: 'wallet-1',
        direction: CashDirection.IN,
        referenceType: CashReferenceType.PAYMENT_EXTERNAL_REFUND,
        referenceId: 'pay-1',
        userId: null,
      });
      expect(Number(registrar.mock.calls[0][1].amount)).toBe(8500);
      expect(registrar.mock.calls[0][1].description).toMatch(
        /^Contracargo reintegrado/,
      );
    });

    it('S-1: sin la resolución del caso a favor del comercio NO asienta el ingreso: queda a conciliar (si el contracargo había salido de la caja)', async () => {
      filas(['wallet-1', 'out', '8500.00']);

      expect(
        await service.asentarContracargoReintegrado(manager, {
          ...datos,
          automatico: false,
        }),
      ).toBe('a_conciliar');
      expect(registrar).not.toHaveBeenCalled();
    });

    it('S-1: sin automático y sin egreso previo no hay nada que conciliar', async () => {
      filas();

      expect(
        await service.asentarContracargoReintegrado(manager, {
          ...datos,
          automatico: false,
        }),
      ).toBe('sin_efecto');
    });

    it('sin duplicar: si el ingreso ya está asentado no hace nada', async () => {
      filas(['wallet-1', 'out', '8500.00'], ['wallet-1', 'in', '8500.00']);

      expect(await service.asentarContracargoReintegrado(manager, datos)).toBe(
        'ya_asentado',
      );
      expect(registrar).not.toHaveBeenCalled();
    });

    it('si el contracargo nunca salió de la caja no hay nada que devolver', async () => {
      filas();

      expect(await service.asentarContracargoReintegrado(manager, datos)).toBe(
        'sin_efecto',
      );
      expect(registrar).not.toHaveBeenCalled();
    });
  });

  describe('asentarSena', () => {
    it('en efectivo entra a la caja elegida y sólo una vez', async () => {
      const sena = {
        distributorId: DIST,
        orderId: ORDER,
        amount: 1000,
        userId: 'adm-1',
        metodo: CashMethod.CASH as const,
        cashBoxId: 'cash-1',
      };
      expect(await service.asentarSena(manager, sena)).toBe('asentado');
      expect(registrar.mock.calls[0][1]).toMatchObject({
        cashBoxId: 'cash-1',
        method: CashMethod.CASH,
        referenceType: CashReferenceType.ORDER_DEPOSIT,
        referenceId: ORDER,
      });
      expect(await service.asentarSena(manager, sena)).toBe('ya_asentado');
    });

    it('en efectivo entra a la caja que se indicó, sin mirar la configuración', async () => {
      config = null;
      await service.asentarSena(manager, {
        distributorId: DIST,
        orderId: ORDER,
        amount: 1000,
        userId: 'adm-1',
        metodo: CashMethod.CASH,
        cashBoxId: 'cash-7',
      });
      expect(registrar.mock.calls[0][1]).toMatchObject({
        cashBoxId: 'cash-7',
        method: CashMethod.CASH,
      });
    });

    it('sin caja elegida queda sin asentar', async () => {
      expect(
        await service.asentarSena(manager, {
          distributorId: DIST,
          orderId: ORDER,
          amount: 1000,
          userId: 'adm-1',
          metodo: CashMethod.CASH,
        }),
      ).toBe('sin_caja');
    });
  });

  describe('avisarSinAsentar', () => {
    it.each(['sin_caja', 'fallo'] as const)(
      'pide el aviso a la bandeja cuando el resultado es %s, una vez por día',
      (resultado) => {
        service.avisarSinAsentar(DIST, resultado, ORDER);

        expect(emit).toHaveBeenCalledTimes(1);
        const [evento, aviso] = emit.mock.calls[0] as [
          string,
          {
            kind: string;
            link: { entity: string; id: string };
            dedupeKey: string;
          },
        ];
        expect(evento).toBe(EVENTO_NOTIFICAR_ADMIN);
        expect(aviso.kind).toBe('sales_cash_unsettled');
        expect(aviso.link).toEqual({ entity: 'cash-settings', id: DIST });
        expect(aviso.dedupeKey).toMatch(
          /^sales-cash-unsettled:dist-1:\d{4}-\d{2}-\d{2}$/,
        );
      },
    );

    it.each(['asentado', 'ya_asentado', 'sin_efecto'] as const)(
      'no avisa cuando el resultado es %s',
      (resultado) => {
        service.avisarSinAsentar(DIST, resultado, ORDER);
        expect(emit).not.toHaveBeenCalled();
      },
    );
  });
});
