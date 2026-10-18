import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FindOperator, Repository } from 'typeorm';
import { RefundsService } from './refunds.service';
import { Payment } from '../entities/payment.entity';
import { PaymentRefund } from '../entities/payment-refund.entity';
import {
  LedgerPaymentStatus,
  PaymentGateway,
  RefundKind,
  RefundStatus,
} from '../domain/payment.enums';
import { PaymentGatewayPort } from '../domain/ports/payment-gateway.port';
import {
  EVENTO_PAGO_REINTEGRADO,
  EVENTO_REINTEGRO_FALLIDO,
  PagoReintegradoEvent,
  ReintegroResuelto,
} from '../domain/events/reintegro.events';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { OrderStatus } from '../../order/entities/order.entity';

type Fila = Record<string, unknown>;

/** ¿La fila cumple la condición (valor, `Not` o `In` de TypeORM)? */
function cumple(valor: unknown, condicion: unknown): boolean {
  if (condicion instanceof FindOperator) {
    const op = condicion;
    const interno: unknown = op.value;
    if (op.type === 'not') return valor !== interno;
    if (op.type === 'in') return (interno as unknown[]).includes(valor);
    throw new Error(`operador no soportado en el doble: ${op.type}`);
  }
  return valor === condicion;
}

function filtrar(filas: Fila[], where: Fila | undefined): Fila[] {
  if (!where) return filas;
  return filas.filter((f) =>
    Object.entries(where).every(([k, v]) => cumple(f[k], v)),
  );
}

/** Repositorio en memoria con lo que usa `RefundsService`. */
function repoEnMemoria(filas: Fila[], idCampo: string, extra: Fila = {}) {
  return {
    filas,
    find: jest.fn(({ where }: { where?: Fila } = {}) =>
      Promise.resolve(filtrar(filas, where)),
    ),
    findOne: jest.fn(({ where }: { where?: Fila } = {}) =>
      Promise.resolve(filtrar(filas, where)[0] ?? null),
    ),
    findOneOrFail: jest.fn(({ where }: { where?: Fila } = {}) => {
      const f = filtrar(filas, where)[0];
      return f ? Promise.resolve(f) : Promise.reject(new Error('no existe'));
    }),
    findAndCount: jest.fn(
      ({ where, take, skip }: { where?: Fila; take: number; skip: number }) => {
        const todas = filtrar(filas, where);
        return Promise.resolve([todas.slice(skip, skip + take), todas.length]);
      },
    ),
    update: jest.fn((criterio: Fila, cambios: Fila) => {
      const objetivo = filtrar(filas, criterio);
      for (const f of objetivo) {
        for (const [k, v] of Object.entries(cambios)) {
          f[k] =
            typeof v === 'function'
              ? (f[k] as number) + 1 // `attempts + 1`
              : v;
        }
      }
      return Promise.resolve({ affected: objetivo.length });
    }),
    idCampo,
    ...extra,
  };
}

describe('RefundsService (CU-168)', () => {
  let pagos: Fila[];
  let solicitudes: Fila[];
  let pagosRepo: ReturnType<typeof repoEnMemoria>;
  let refundsRepo: ReturnType<typeof repoEnMemoria>;
  let gateway: {
    getPayment: jest.Mock;
    refundPayment: jest.Mock;
  };
  let orderLookup: { findForRefund: jest.Mock };
  let eventos: { emit: jest.Mock };
  let service: RefundsService;
  let seq: number;

  const pago = (over: Fila = {}): Fila => ({
    paymentId: 'pay-1',
    orderId: 'ord-1',
    distributorId: 'dist-1',
    gateway: PaymentGateway.MERCADOPAGO,
    gatewayPaymentId: 'mp-1',
    amount: 3000,
    isDeposit: false,
    status: LedgerPaymentStatus.APPROVED,
    ...over,
  });

  beforeEach(() => {
    seq = 0;
    pagos = [];
    solicitudes = [];
    pagosRepo = repoEnMemoria(pagos, 'paymentId');
    pagosRepo.find = jest.fn(({ where }: { where?: Fila } = {}) => {
      // `gateway: Not(CASH)` y estado: el doble los interpreta como los reales.
      return Promise.resolve(filtrar(pagos, where));
    });
    refundsRepo = repoEnMemoria(solicitudes, 'refundId', {
      createQueryBuilder: jest.fn(() => {
        let valores: Fila = {};
        const qb = {
          insert: () => qb,
          values: (v: Fila) => {
            valores = v;
            return qb;
          },
          orIgnore: () => qb,
          execute: () => {
            const existe = solicitudes.some(
              (s) =>
                s.paymentId === valores.paymentId && s.kind === valores.kind,
            );
            if (!existe) {
              seq += 1;
              solicitudes.push({
                refundId: `ref-${seq}`,
                gatewayRefundId: null,
                errorMessage: null,
                attempts: 0,
                refundedAt: null,
                requestedByUserId: null,
                createdAt: new Date(2026, 0, seq),
                ...valores,
              });
            }
            return Promise.resolve();
          },
        };
        return qb;
      }),
    });
    gateway = {
      getPayment: jest.fn().mockResolvedValue({
        id: 'mp-1',
        status: 'approved',
        externalReference: 'ord-1',
        amount: 3000,
        refundedAmount: 0,
      }),
      refundPayment: jest.fn().mockResolvedValue({ refundId: 'mp-refund-1' }),
    };
    orderLookup = {
      findForRefund: jest.fn().mockResolvedValue({
        orderId: 'ord-1',
        customerId: 'cus-1',
        distributorId: 'dist-1',
        status: OrderStatus.CANCELLED,
        expressSurchargeAmount: 0,
      }),
    };
    eventos = { emit: jest.fn() };
    service = new RefundsService(
      pagosRepo as unknown as Repository<Payment>,
      refundsRepo as unknown as Repository<PaymentRefund>,
      gateway as unknown as PaymentGatewayPort,
      orderLookup as unknown as OrderLookupService,
      eventos as unknown as EventEmitter2,
    );
  });

  describe('reintegrarPorCancelacion', () => {
    it('devuelve el total del pago aprobado y lo marca reintegrado', async () => {
      pagos.push(pago());

      const [r] = await service.reintegrarPorCancelacion('ord-1');

      expect(gateway.refundPayment).toHaveBeenCalledWith({
        gatewayPaymentId: 'mp-1',
        amount: 3000,
        idempotencyKey: r.refundId,
      });
      expect(r.status).toBe(RefundStatus.SUCCEEDED);
      expect(r.kind).toBe(RefundKind.FULL);
      expect(r.gatewayRefundId).toBe('mp-refund-1');
      expect(pagos[0].status).toBe(LedgerPaymentStatus.REFUNDED);
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_PAGO_REINTEGRADO,
        new PagoReintegradoEvent(
          expect.objectContaining({
            orderId: 'ord-1',
            amount: 3000,
          }) as unknown as ReintegroResuelto,
        ),
      );
    });

    it('sin pagos de pasarela (efectivo, transferencia, nunca aprobado) no hace nada', async () => {
      pagos.push(
        pago({ gateway: PaymentGateway.CASH }),
        pago({ paymentId: 'pay-2', status: LedgerPaymentStatus.PENDING }),
      );

      expect(await service.reintegrarPorCancelacion('ord-1')).toEqual([]);
      expect(gateway.refundPayment).not.toHaveBeenCalled();
    });

    it('repetir no devuelve el dinero dos veces: una sola solicitud a la pasarela', async () => {
      pagos.push(pago());

      await service.reintegrarPorCancelacion('ord-1');
      pagos[0].status = LedgerPaymentStatus.APPROVED; // aunque el ledger siguiera aprobado
      await service.reintegrarPorCancelacion('ord-1');

      expect(gateway.refundPayment).toHaveBeenCalledTimes(1);
      expect(solicitudes).toHaveLength(1);
      expect(eventos.emit).toHaveBeenCalledTimes(1);
    });

    it('devuelve cada pago aprobado (seña y saldo) por separado', async () => {
      pagos.push(
        pago({ isDeposit: true, amount: 1000 }),
        pago({ paymentId: 'pay-2', gatewayPaymentId: 'mp-2', amount: 2000 }),
      );
      gateway.getPayment.mockImplementation((id: string) =>
        Promise.resolve({
          id,
          status: 'approved',
          externalReference: 'ord-1',
          amount: id === 'mp-1' ? 1000 : 2000,
          refundedAmount: 0,
        }),
      );

      const r = await service.reintegrarPorCancelacion('ord-1');

      expect(r.map((x) => x.amount)).toEqual([1000, 2000]);
      expect(gateway.refundPayment).toHaveBeenCalledTimes(2);
    });

    it('descuenta lo que ya se devolvió del pago (recargo express)', async () => {
      pagos.push(pago());
      solicitudes.push({
        refundId: 'ref-x',
        paymentId: 'pay-1',
        orderId: 'ord-1',
        kind: RefundKind.EXPRESS_SURCHARGE,
        amount: 500,
        status: RefundStatus.SUCCEEDED,
      });
      gateway.getPayment.mockResolvedValue({
        id: 'mp-1',
        status: 'approved',
        externalReference: 'ord-1',
        amount: 3000,
        refundedAmount: 500,
      });

      const [r] = await service.reintegrarPorCancelacion('ord-1');

      expect(r.amount).toBe(2500);
      expect(gateway.refundPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 2500 }),
      );
    });

    it('nunca pide más de lo que la pasarela cobró (el ledger puede traer recargos que no pasaron por ella)', async () => {
      pagos.push(pago({ amount: 3300 }));

      const [r] = await service.reintegrarPorCancelacion('ord-1');

      expect(r.amount).toBe(3000);
      expect(gateway.refundPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 3000 }),
      );
    });

    it('si la pasarela dice que ya estaba devuelto, lo marca reintegrado sin pedirlo de nuevo', async () => {
      pagos.push(pago());
      gateway.getPayment.mockResolvedValue({
        id: 'mp-1',
        status: 'refunded',
        externalReference: 'ord-1',
        amount: 3000,
        refundedAmount: 3000,
      });

      const [r] = await service.reintegrarPorCancelacion('ord-1');

      expect(gateway.refundPayment).not.toHaveBeenCalled();
      expect(r.status).toBe(RefundStatus.SUCCEEDED);
      expect(r.gatewayRefundId).toBeNull();
      expect(pagos[0].status).toBe(LedgerPaymentStatus.REFUNDED);
    });

    it('si la pasarela rechaza deja el pago aprobado, registra el error y avisa', async () => {
      pagos.push(pago());
      gateway.refundPayment.mockRejectedValue(new Error('saldo insuficiente'));

      const [r] = await service.reintegrarPorCancelacion('ord-1');

      expect(r.status).toBe(RefundStatus.FAILED);
      expect(r.errorMessage).toBe('saldo insuficiente');
      expect(r.attempts).toBe(1);
      expect(pagos[0].status).toBe(LedgerPaymentStatus.APPROVED);
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_REINTEGRO_FALLIDO,
        expect.objectContaining({ motivo: 'saldo insuficiente' }),
      );
      expect(eventos.emit).not.toHaveBeenCalledWith(
        EVENTO_PAGO_REINTEGRADO,
        expect.anything(),
      );
    });

    it('un timeout con la devolución ya aplicada no se da por fallida', async () => {
      pagos.push(pago());
      gateway.getPayment
        .mockResolvedValueOnce({
          id: 'mp-1',
          status: 'approved',
          externalReference: 'ord-1',
          amount: 3000,
          refundedAmount: 0,
        })
        .mockResolvedValueOnce({
          id: 'mp-1',
          status: 'refunded',
          externalReference: 'ord-1',
          amount: 3000,
          refundedAmount: 3000,
        });
      gateway.refundPayment.mockRejectedValue(new Error('timeout'));

      const [r] = await service.reintegrarPorCancelacion('ord-1');

      expect(r.status).toBe(RefundStatus.SUCCEEDED);
    });

    it('si getPayment no responde igual intenta la devolución', async () => {
      pagos.push(pago());
      gateway.getPayment.mockRejectedValue(new Error('sin red'));

      const [r] = await service.reintegrarPorCancelacion('ord-1');

      expect(gateway.refundPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 3000 }),
      );
      expect(r.status).toBe(RefundStatus.SUCCEEDED);
    });

    it('un pago sin id en la pasarela queda fallido sin llamarla', async () => {
      pagos.push(pago({ gatewayPaymentId: null }));

      const [r] = await service.reintegrarPorCancelacion('ord-1');

      expect(r.status).toBe(RefundStatus.FAILED);
      expect(gateway.refundPayment).not.toHaveBeenCalled();
    });
  });

  describe('reintegrarRecargoExpress', () => {
    it('devuelve sólo el recargo del pago online del pedido y deja el pago aprobado', async () => {
      pagos.push(
        pago({ isDeposit: true, amount: 5000 }),
        pago({ amount: 4500 }),
      );
      gateway.getPayment.mockResolvedValue({
        id: 'mp-1',
        status: 'approved',
        externalReference: 'ord-1',
        amount: 4500,
        refundedAmount: 0,
      });

      const [r] = await service.reintegrarRecargoExpress('ord-1', 1500);

      expect(r.kind).toBe(RefundKind.EXPRESS_SURCHARGE);
      expect(r.amount).toBe(1500);
      expect(r.paymentId).toBe('pay-1');
      expect(gateway.refundPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1500 }),
      );
      expect(pagos[1].status).toBe(LedgerPaymentStatus.APPROVED);
    });

    it('en efectivo (sin pago de pasarela) no devuelve nada', async () => {
      expect(await service.reintegrarRecargoExpress('ord-1', 1500)).toEqual([]);
      expect(gateway.refundPayment).not.toHaveBeenCalled();
    });

    it('sin recargo no hace nada', async () => {
      pagos.push(pago());
      expect(await service.reintegrarRecargoExpress('ord-1', 0)).toEqual([]);
    });

    it('repetirlo no devuelve el recargo dos veces', async () => {
      pagos.push(pago());

      await service.reintegrarRecargoExpress('ord-1', 1500);
      await service.reintegrarRecargoExpress('ord-1', 1500);

      expect(gateway.refundPayment).toHaveBeenCalledTimes(1);
    });
  });

  describe('reintentar', () => {
    it('reintenta la devolución fallida con la MISMA clave de idempotencia', async () => {
      pagos.push(pago());
      gateway.refundPayment.mockRejectedValueOnce(new Error('caída'));
      const [fallida] = await service.reintegrarPorCancelacion('ord-1');
      expect(fallida.status).toBe(RefundStatus.FAILED);

      const [r] = await service.reintentar('ord-1', 'dist-1', 'adm-1');

      expect(r.status).toBe(RefundStatus.SUCCEEDED);
      expect(r.requestedByUserId).toBe('adm-1');
      expect(r.attempts).toBe(2);
      const claves = gateway.refundPayment.mock.calls.map(
        (c: [{ idempotencyKey: string }]) => c[0].idempotencyKey,
      );
      expect(new Set(claves).size).toBe(1);
    });

    it('crea la devolución de un pedido cancelado que nunca la pidió', async () => {
      pagos.push(pago());

      const [r] = await service.reintentar('ord-1', 'dist-1', 'adm-1');

      expect(r.kind).toBe(RefundKind.FULL);
      expect(r.status).toBe(RefundStatus.SUCCEEDED);
    });

    it('un pedido de otra distribuidora o inexistente es 404', async () => {
      orderLookup.findForRefund.mockResolvedValue(null);
      await expect(
        service.reintentar('ord-1', 'otra', 'adm-1'),
      ).rejects.toThrow(NotFoundException);
      expect(orderLookup.findForRefund).toHaveBeenCalledWith('ord-1', 'otra');
    });

    it('si el pedido no está cancelado y no hay recargo pendiente, 409', async () => {
      orderLookup.findForRefund.mockResolvedValue({
        orderId: 'ord-1',
        status: OrderStatus.PENDING,
      });
      pagos.push(pago());

      await expect(
        service.reintentar('ord-1', 'dist-1', 'adm-1'),
      ).rejects.toThrow(ConflictException);
      expect(gateway.refundPayment).not.toHaveBeenCalled();
    });

    it('un pedido vivo con la devolución del recargo fallida sí se reintenta', async () => {
      orderLookup.findForRefund.mockResolvedValue({
        orderId: 'ord-1',
        status: OrderStatus.PENDING,
      });
      pagos.push(pago());
      gateway.refundPayment.mockRejectedValueOnce(new Error('caída'));
      await service.reintegrarRecargoExpress('ord-1', 1500);

      const [r] = await service.reintentar('ord-1', 'dist-1', 'adm-1');

      expect(r.status).toBe(RefundStatus.SUCCEEDED);
      expect(r.kind).toBe(RefundKind.EXPRESS_SURCHARGE);
    });

    it('cancelado con una devolución de recargo fallida: va todo en la devolución total', async () => {
      pagos.push(pago());
      gateway.refundPayment.mockRejectedValueOnce(new Error('caída'));
      await service.reintegrarRecargoExpress('ord-1', 1500);

      const r = await service.reintentar('ord-1', 'dist-1', 'adm-1');

      expect(gateway.refundPayment).toHaveBeenCalledTimes(2);
      const total = r.find((x) => x.kind === RefundKind.FULL);
      expect(total?.status).toBe(RefundStatus.SUCCEEDED);
      const recargo = r.find((x) => x.kind === RefundKind.EXPRESS_SURCHARGE);
      expect(recargo?.status).toBe(RefundStatus.FAILED);
    });

    it('lo ya reintegrado no se vuelve a pedir', async () => {
      pagos.push(pago());
      await service.reintegrarPorCancelacion('ord-1');
      gateway.refundPayment.mockClear();

      const r = await service.reintentar('ord-1', 'dist-1', 'adm-1');

      expect(gateway.refundPayment).not.toHaveBeenCalled();
      expect(r).toHaveLength(1);
    });
  });

  describe('listados', () => {
    it('listarDelPedido acota por la distribuidora (404 si es ajeno)', async () => {
      orderLookup.findForRefund.mockResolvedValue(null);
      await expect(service.listarDelPedido('ord-1', 'otra')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('listarDelPedido devuelve las del pedido', async () => {
      pagos.push(pago());
      await service.reintegrarPorCancelacion('ord-1');
      expect(await service.listarDelPedido('ord-1', 'dist-1')).toHaveLength(1);
    });

    it('listar filtra por distribuidora y estado, y pagina', async () => {
      solicitudes.push(
        { refundId: 'a', distributorId: 'dist-1', status: RefundStatus.FAILED },
        {
          refundId: 'b',
          distributorId: 'dist-1',
          status: RefundStatus.SUCCEEDED,
        },
        { refundId: 'c', distributorId: 'otra', status: RefundStatus.FAILED },
      );

      const fallidas = await service.listar('dist-1', {
        status: RefundStatus.FAILED,
        limit: 10,
        offset: 0,
      });
      expect(fallidas.items.map((i) => i.refundId)).toEqual(['a']);
      expect(fallidas.total).toBe(1);

      const todas = await service.listar('dist-1', { limit: 1, offset: 1 });
      expect(todas.total).toBe(2);
      expect(todas.items).toHaveLength(1);
    });
  });
});
