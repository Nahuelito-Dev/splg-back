import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityManager, FindOperator, Repository } from 'typeorm';
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
    if (op.type === 'lessThan') return (valor as Date) < (interno as Date);
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
    find: jest.fn(({ where, take }: { where?: Fila; take?: number } = {}) =>
      Promise.resolve(filtrar(filas, where).slice(0, take)),
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
  let refundsRepo: ReturnType<typeof repoEnMemoria> & {
    createQueryBuilder: jest.Mock;
  };
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
          into: () => qb,
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
                refundedBaseline: null,
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
    }) as typeof refundsRepo;
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
    it('reintenta la devolución fallida: la clave del intento nuevo sólo cambia porque la pasarela confirmó que el anterior no se aplicó', async () => {
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
      expect(claves).toEqual([r.refundId, `${r.refundId}:1`]);
    });

    it('si la pasarela no responde al reintento no se puede confirmar que el intento anterior no se aplicó: misma clave', async () => {
      pagos.push(pago());
      gateway.refundPayment.mockRejectedValueOnce(new Error('caída'));
      const [fallida] = await service.reintegrarPorCancelacion('ord-1');
      gateway.getPayment.mockRejectedValue(new Error('sin red'));

      await service.reintentar('ord-1', 'dist-1', 'adm-1');

      const claves = gateway.refundPayment.mock.calls.map(
        (c: [{ idempotencyKey: string }]) => c[0].idempotencyKey,
      );
      expect(claves).toEqual([fallida.refundId, fallida.refundId]);
    });

    it('si el intento fallido se había aplicado igual (lo devuelto subió), el reintento lo da por reintegrado sin pedir nada', async () => {
      pagos.push(pago());
      gateway.refundPayment.mockRejectedValueOnce(new Error('timeout'));
      // Lectura previa al intento, y posterior al timeout: sin cambio (parece fallido).
      await service.reintegrarPorCancelacion('ord-1');
      gateway.refundPayment.mockClear();
      gateway.getPayment.mockResolvedValue({
        id: 'mp-1',
        status: 'approved',
        externalReference: 'ord-1',
        amount: 3000,
        refundedAmount: 3000 - 0, // la pasarela terminó aplicándolo
      });

      const [r] = await service.reintentar('ord-1', 'dist-1', 'adm-1');

      expect(r.status).toBe(RefundStatus.SUCCEEDED);
      expect(gateway.refundPayment).not.toHaveBeenCalled();
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

  describe('timeout de una devolución PARCIAL (el pago no pasa a refunded)', () => {
    const estado = (refundedAmount: number) => ({
      id: 'mp-1',
      status: 'approved',
      externalReference: 'ord-1',
      amount: 4500,
      refundedAmount,
    });

    it('si tras el timeout lo devuelto subió al menos el monto, es éxito aunque el estado siga approved', async () => {
      pagos.push(pago({ amount: 4500 }));
      gateway.getPayment
        .mockResolvedValueOnce(estado(0))
        .mockResolvedValueOnce(estado(1500));
      gateway.refundPayment.mockRejectedValue(new Error('timeout'));

      const [r] = await service.reintegrarRecargoExpress('ord-1', 1500);

      expect(r.status).toBe(RefundStatus.SUCCEEDED);
      expect(eventos.emit).not.toHaveBeenCalledWith(
        EVENTO_REINTEGRO_FALLIDO,
        expect.anything(),
      );
    });

    it('si no subió, es fallo (y queda anotado desde dónde se partió)', async () => {
      pagos.push(pago({ amount: 4500 }));
      gateway.getPayment
        .mockResolvedValueOnce(estado(200))
        .mockResolvedValueOnce(estado(200));
      gateway.refundPayment.mockRejectedValue(new Error('timeout'));

      const [r] = await service.reintegrarRecargoExpress('ord-1', 1500);

      expect(r.status).toBe(RefundStatus.FAILED);
      expect(r.refundedBaseline).toBe(200);
    });

    it('si subió menos que el monto no alcanza', async () => {
      pagos.push(pago({ amount: 4500 }));
      gateway.getPayment
        .mockResolvedValueOnce(estado(0))
        .mockResolvedValueOnce(estado(300));
      gateway.refundPayment.mockRejectedValue(new Error('timeout'));

      const [r] = await service.reintegrarRecargoExpress('ord-1', 1500);

      expect(r.status).toBe(RefundStatus.FAILED);
    });

    it('si la segunda lectura falla no se puede afirmar éxito: queda fallido para reintentar', async () => {
      pagos.push(pago({ amount: 4500 }));
      gateway.getPayment
        .mockResolvedValueOnce(estado(0))
        .mockRejectedValueOnce(new Error('sin red'));
      gateway.refundPayment.mockRejectedValue(new Error('timeout'));

      const [r] = await service.reintegrarRecargoExpress('ord-1', 1500);

      expect(r.status).toBe(RefundStatus.FAILED);
    });
  });

  describe('carrera de reintegro doble', () => {
    it('dos cancelaciones simultáneas dejan UNA solicitud, UNA clave de idempotencia y UN aviso', async () => {
      pagos.push(pago());

      await Promise.all([
        service.reintegrarPorCancelacion('ord-1'),
        service.reintegrarPorCancelacion('ord-1'),
      ]);

      expect(solicitudes).toHaveLength(1);
      const claves = new Set(
        gateway.refundPayment.mock.calls.map(
          (c: [{ idempotencyKey: string }]) => c[0].idempotencyKey,
        ),
      );
      expect(claves.size).toBe(1);
      const avisos = eventos.emit.mock.calls.filter(
        (c: [string]) => c[0] === EVENTO_PAGO_REINTEGRADO,
      );
      expect(avisos).toHaveLength(1);
    });

    it('el cierre es un UPDATE condicional a "no reintegrado": la segunda vez no afecta filas', async () => {
      pagos.push(pago());
      const [r] = await service.reintegrarPorCancelacion('ord-1');
      eventos.emit.mockClear();

      await service.reintentar('ord-1', 'dist-1', 'adm-1');

      const condiciones = refundsRepo.update.mock.calls.map(
        (c: [Fila, Fila]) => c[0],
      );
      expect(
        condiciones.some(
          (c: Fila) =>
            c.refundId === r.refundId && c.status instanceof FindOperator,
        ),
      ).toBe(true);
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('un fallo que llega cuando otro proceso ya reintegró no se avisa', async () => {
      pagos.push(pago());
      const [r] = await service.reintegrarPorCancelacion('ord-1');
      eventos.emit.mockClear();
      // El cierre de otro proceso: ya está succeeded, el UPDATE de fallo no afecta filas.
      const registrarFallo = (
        service as unknown as {
          registrarFallo: (
            s: PaymentRefund,
            m: string,
            a: string | null,
          ) => Promise<PaymentRefund>;
        }
      ).registrarFallo.bind(service);

      await registrarFallo(r, 'rechazo tardío', null);

      expect(eventos.emit).not.toHaveBeenCalled();
      expect(r.status).toBe(RefundStatus.SUCCEEDED);
    });
  });

  describe('outbox y pendientes viejas', () => {
    const manager = () => ({
      find: jest.fn(() => Promise.resolve(filtrar(pagos, undefined))),
      createQueryBuilder: refundsRepo.createQueryBuilder,
    });

    it('registrarRecargoExpress deja la solicitud pendiente con el manager de la transacción, sin hablar con la pasarela', async () => {
      pagos.push(pago({ amount: 4500 }));

      const hay = await service.registrarRecargoExpress(
        manager() as unknown as EntityManager,
        'ord-1',
        1500,
      );

      expect(hay).toBe(true);
      expect(solicitudes).toHaveLength(1);
      expect(solicitudes[0]).toMatchObject({
        kind: RefundKind.EXPRESS_SURCHARGE,
        amount: 1500,
        status: RefundStatus.PENDING,
      });
      expect(gateway.refundPayment).not.toHaveBeenCalled();
    });

    it('sin pago de pasarela (efectivo) no registra nada', async () => {
      const hay = await service.registrarRecargoExpress(
        manager() as unknown as EntityManager,
        'ord-1',
        1500,
      );
      expect(hay).toBe(false);
      expect(solicitudes).toHaveLength(0);
    });

    it('retomarPendientes ejecuta sólo las pendientes más viejas que el umbral', async () => {
      pagos.push(pago({ amount: 4500 }));
      const vieja = new Date(Date.now() - 10 * 60 * 1000);
      solicitudes.push(
        {
          refundId: 'vieja',
          paymentId: 'pay-1',
          orderId: 'ord-1',
          kind: RefundKind.EXPRESS_SURCHARGE,
          amount: 1500,
          status: RefundStatus.PENDING,
          attempts: 0,
          refundedBaseline: null,
          updatedAt: vieja,
        },
        {
          refundId: 'reciente',
          paymentId: 'pay-1',
          orderId: 'ord-1',
          kind: RefundKind.FULL,
          amount: 100,
          status: RefundStatus.PENDING,
          attempts: 0,
          refundedBaseline: null,
          updatedAt: new Date(),
        },
      );

      const n = await service.retomarPendientes();

      expect(n).toBe(1);
      expect(solicitudes.find((x) => x.refundId === 'vieja')?.status).toBe(
        RefundStatus.SUCCEEDED,
      );
      expect(solicitudes.find((x) => x.refundId === 'reciente')?.status).toBe(
        RefundStatus.PENDING,
      );
      expect(gateway.refundPayment).toHaveBeenCalledTimes(1);
      expect(gateway.refundPayment).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'vieja' }),
      );
    });

    it('un error al retomar una no frena las demás', async () => {
      pagos.push(pago({ amount: 4500 }));
      const vieja = new Date(Date.now() - 10 * 60 * 1000);
      solicitudes.push({
        refundId: 'sin-pago',
        paymentId: 'no-existe',
        orderId: 'ord-1',
        kind: RefundKind.FULL,
        amount: 100,
        status: RefundStatus.PENDING,
        attempts: 0,
        refundedBaseline: null,
        updatedAt: vieja,
      });
      expect(await service.retomarPendientes()).toBe(0);
    });
  });

  describe('recargo express sin devolver (reintento del admin)', () => {
    const vivo = (over: Fila = {}) =>
      orderLookup.findForRefund.mockResolvedValue({
        orderId: 'ord-1',
        customerId: 'cus-1',
        distributorId: 'dist-1',
        status: OrderStatus.PENDING,
        expressSurchargeAmount: 1500,
        expressDegradedAt: new Date(),
        ...over,
      });

    it('pasó al reparto común, se cobró por la pasarela y no hay solicitud: reintentar la crea y la ejecuta', async () => {
      pagos.push(pago({ amount: 4500 }));
      vivo();

      const [r] = await service.reintentar('ord-1', 'dist-1', 'adm-1');

      expect(r).toMatchObject({
        kind: RefundKind.EXPRESS_SURCHARGE,
        amount: 1500,
        status: RefundStatus.SUCCEEDED,
      });
    });

    it('con una solicitud pendiente también se puede reintentar', async () => {
      pagos.push(pago({ amount: 4500 }));
      vivo();
      await service.registrarRecargoExpress(
        {
          find: () => Promise.resolve(pagos),
          createQueryBuilder: refundsRepo.createQueryBuilder,
        } as unknown as EntityManager,
        'ord-1',
        1500,
      );

      const [r] = await service.reintentar('ord-1', 'dist-1', 'adm-1');

      expect(r.status).toBe(RefundStatus.SUCCEEDED);
    });

    it('si el recargo ya se devolvió, 409', async () => {
      pagos.push(pago({ amount: 4500 }));
      vivo();
      await service.reintegrarRecargoExpress('ord-1', 1500);

      await expect(
        service.reintentar('ord-1', 'dist-1', 'adm-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('en efectivo (sin pago de pasarela) no hay nada que devolver: 409', async () => {
      vivo();
      await expect(
        service.reintentar('ord-1', 'dist-1', 'adm-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('sin haber pasado al reparto común no aplica: 409', async () => {
      pagos.push(pago({ amount: 4500 }));
      vivo({ expressDegradedAt: null });
      await expect(
        service.reintentar('ord-1', 'dist-1', 'adm-1'),
      ).rejects.toThrow(ConflictException);
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
