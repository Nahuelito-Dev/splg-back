import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityManager, In, LessThan, Not, Repository } from 'typeorm';
import Decimal from 'decimal.js';

import { Payment } from '../entities/payment.entity';
import { PaymentRefund } from '../entities/payment-refund.entity';
import {
  LedgerPaymentStatus,
  PaymentGateway,
  RefundKind,
  RefundStatus,
} from '../domain/payment.enums';
import {
  GatewayPayment,
  PaymentGatewayPort,
} from '../domain/ports/payment-gateway.port';
import {
  EVENTO_PAGO_REINTEGRADO,
  EVENTO_REINTEGRO_FALLIDO,
  PagoReintegradoEvent,
  ReintegroFallidoEvent,
  ReintegroResuelto,
} from '../domain/events/reintegro.events';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { OrderStatus } from '../../order/entities/order.entity';
import { errorMessage } from '../../common/errors/error-message';
import { SalesCashService } from '../../cash/application/sales-cash.service';

/** Largo máximo del motivo del error que se guarda (la pasarela puede devolver un volcado). */
const MAX_ERROR = 500;

/** Estado de un pago en la pasarela cuando ya se devolvió completo. */
const ESTADO_DEVUELTO = 'refunded';

/** Diferencia de centavos que se tolera al comparar importes de la pasarela. */
const TOLERANCIA = 0.005;

/** Una solicitud `pending` más vieja que esto quedó a medias (se cayó el proceso) y se retoma. */
export const PENDIENTE_VIEJA_MS = 5 * 60 * 1000;

export interface FiltrosDeReintegros {
  status?: RefundStatus;
  limit: number;
  offset: number;
}

/**
 * CU-168: devolver a la pasarela lo que el cliente pagó. Es un efecto POSTERIOR
 * a la cancelación (o a la pérdida de la modalidad express): nunca corre dentro
 * de la transacción del pedido y un fallo no la revierte; queda la solicitud
 * en `payment_refund` con su error y el administrador la reintenta.
 *
 * Idempotencia en tres capas: una solicitud por pago y tipo (índice único), su
 * `refund_id` viaja como clave de idempotencia a la pasarela, y el cierre
 * (`pending|failed -> succeeded`) es un UPDATE condicional del que sólo gana
 * uno, que es quien avisa.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    @InjectRepository(PaymentRefund)
    private readonly refunds: Repository<PaymentRefund>,
    private readonly gateway: PaymentGatewayPort,
    private readonly orderLookup: OrderLookupService,
    private readonly eventos: EventEmitter2,
    private readonly ventasEnCaja: SalesCashService,
  ) {}

  /** El pedido se canceló: devuelve lo que falte de cada pago aprobado por una pasarela. */
  async reintegrarPorCancelacion(orderId: string): Promise<PaymentRefund[]> {
    const pagos = await this.pagosAprobados(orderId);
    const resultado: PaymentRefund[] = [];
    for (const pago of pagos) {
      const solicitud = await this.solicitudParaCancelacion(pago);
      if (solicitud) resultado.push(await this.ejecutar(solicitud, pago, null));
    }
    return resultado;
  }

  /**
   * El pedido express pasó al reparto común: devuelve sólo el recargo express,
   * del pago online del pedido (el de la seña de una reserva no lleva recargo).
   */
  async reintegrarRecargoExpress(
    orderId: string,
    amount: number,
  ): Promise<PaymentRefund[]> {
    if (!(amount > 0)) return [];
    const pagos = (await this.pagosAprobados(orderId)).filter(
      (p) => !p.isDeposit && p.amount >= amount,
    );
    const pago = pagos[pagos.length - 1];
    if (!pago) return [];
    const solicitud = await this.solicitudNueva(
      pago,
      RefundKind.EXPRESS_SURCHARGE,
      amount,
    );
    return [await this.ejecutar(solicitud, pago, null)];
  }

  /**
   * Outbox del pase al reparto común: deja registrada la solicitud de devolución
   * del recargo (`pending`) DENTRO de la transacción del pedido, así un corte
   * antes de hablar con la pasarela no pierde el reintegro. La ejecuta después
   * `reintegrarRecargoExpress` (o `retomarPendientes` si el proceso se cae).
   * Devuelve false si no hay un pago aprobado por una pasarela que lo cubra.
   */
  async registrarRecargoExpress(
    manager: EntityManager,
    orderId: string,
    amount: number,
  ): Promise<boolean> {
    if (!(amount > 0)) return false;
    const pagos = await manager.find(Payment, {
      where: {
        orderId,
        status: LedgerPaymentStatus.APPROVED,
        gateway: Not(PaymentGateway.CASH),
      },
      order: { createdAt: 'ASC' },
    });
    const pago = pagos.filter((p) => !p.isDeposit && p.amount >= amount).pop();
    if (!pago) return false;
    await manager
      .createQueryBuilder()
      .insert()
      .into(PaymentRefund)
      .values({
        paymentId: pago.paymentId,
        orderId: pago.orderId,
        distributorId: pago.distributorId,
        kind: RefundKind.EXPRESS_SURCHARGE,
        amount,
        status: RefundStatus.PENDING,
      })
      .orIgnore()
      .execute();
    return true;
  }

  /**
   * Retoma las solicitudes que quedaron `pending` hace más de `edadMs` (se cayó
   * el proceso entre registrarlas y hablar con la pasarela). Las ejecuta con la
   * misma clave de idempotencia: si la pasarela ya las aplicó, no devuelve de más.
   */
  async retomarPendientes(
    edadMs: number = PENDIENTE_VIEJA_MS,
    limite = 20,
  ): Promise<number> {
    const viejas = await this.refunds.find({
      where: {
        status: RefundStatus.PENDING,
        updatedAt: LessThan(new Date(Date.now() - edadMs)),
      },
      order: { updatedAt: 'ASC' },
      take: limite,
    });
    let retomadas = 0;
    for (const solicitud of viejas) {
      try {
        const pago = await this.payments.findOne({
          where: { paymentId: solicitud.paymentId },
        });
        if (!pago) continue;
        await this.ejecutar(solicitud, pago, null);
        retomadas += 1;
      } catch (error) {
        this.logger.error(
          `No se pudo retomar la devolución ${solicitud.refundId}: ${errorMessage(error)}`,
        );
      }
    }
    return retomadas;
  }

  /**
   * El administrador reintenta lo que falló. Sólo si el pedido está cancelado o
   * tiene pendiente la devolución del recargo express; en otro caso 409. Un
   * pedido de otra distribuidora no existe (404).
   */
  async reintentar(
    orderId: string,
    distributorId: string,
    actorUserId: string,
  ): Promise<PaymentRefund[]> {
    const pedido = await this.orderLookup.findForRefund(orderId, distributorId);
    if (!pedido) {
      throw new NotFoundException(`Order with ID: ${orderId} not found`);
    }
    const existentes = await this.refunds.find({ where: { orderId } });
    const recargoPendiente = existentes.some(
      (r) =>
        r.kind === RefundKind.EXPRESS_SURCHARGE &&
        r.status !== RefundStatus.SUCCEEDED,
    );
    const cancelado = pedido.status === OrderStatus.CANCELLED;
    const pagos = await this.pagosAprobados(orderId);
    // Pasó al reparto común, se cobró el recargo por una pasarela y nunca se
    // devolvió (ni siquiera quedó la solicitud): también se puede reintentar.
    const recargoSinDevolver =
      pedido.expressDegradedAt != null &&
      pedido.expressSurchargeAmount > 0 &&
      !existentes.some(
        (r) =>
          r.kind === RefundKind.EXPRESS_SURCHARGE &&
          r.status === RefundStatus.SUCCEEDED,
      ) &&
      pagos.some(
        (p) => !p.isDeposit && p.amount >= pedido.expressSurchargeAmount,
      );
    if (!cancelado && !recargoPendiente && !recargoSinDevolver) {
      throw new ConflictException(
        'Sólo se puede reintentar la devolución de un pedido cancelado, o con la devolución del recargo express pendiente o sin pedir',
      );
    }

    if (cancelado) {
      for (const pago of pagos) await this.solicitudParaCancelacion(pago);
    }
    if (recargoSinDevolver && !cancelado) {
      const pago = pagos
        .filter(
          (p) => !p.isDeposit && p.amount >= pedido.expressSurchargeAmount,
        )
        .pop();
      if (pago) {
        await this.solicitudNueva(
          pago,
          RefundKind.EXPRESS_SURCHARGE,
          pedido.expressSurchargeAmount,
        );
      }
    }
    const solicitudes = await this.refunds.find({
      where: { orderId },
      order: { createdAt: 'ASC' },
    });
    const conTotal = new Set(
      solicitudes
        .filter((s) => s.kind === RefundKind.FULL)
        .map((s) => s.paymentId),
    );
    const resultado: PaymentRefund[] = [];
    for (const solicitud of solicitudes) {
      if (solicitud.status === RefundStatus.SUCCEEDED) {
        resultado.push(solicitud);
        continue;
      }
      // El recargo ya está dentro de la devolución total de ese pago.
      if (
        solicitud.kind === RefundKind.EXPRESS_SURCHARGE &&
        conTotal.has(solicitud.paymentId)
      ) {
        resultado.push(solicitud);
        continue;
      }
      const pago = await this.payments.findOne({
        where: { paymentId: solicitud.paymentId },
      });
      resultado.push(
        pago ? await this.ejecutar(solicitud, pago, actorUserId) : solicitud,
      );
    }
    return resultado;
  }

  /** Las solicitudes del pedido, dentro de la distribuidora (lo ajeno es 404). */
  async listarDelPedido(
    orderId: string,
    distributorId: string,
  ): Promise<PaymentRefund[]> {
    const pedido = await this.orderLookup.findForRefund(orderId, distributorId);
    if (!pedido) {
      throw new NotFoundException(`Order with ID: ${orderId} not found`);
    }
    return this.refunds.find({
      where: { orderId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Las devoluciones de un pedido vistas por su cliente. El cliente es uno solo
   * para todas las distribuidoras: no se filtra por tenant, se exige que el
   * pedido sea suyo. Un pedido ajeno es 404, igual que uno inexistente.
   */
  async listarDelCliente(
    orderId: string,
    customerUserId: string,
  ): Promise<PaymentRefund[]> {
    const pedido = await this.orderLookup.findForRefund(orderId);
    if (!pedido || pedido.customerId !== customerUserId) {
      throw new NotFoundException(`Order with ID: ${orderId} not found`);
    }
    const filas = await this.refunds.find({
      where: { orderId },
      order: { createdAt: 'ASC' },
    });
    // Si el pedido se canceló después de pasar al reparto común, la devolución
    // total ya incluye el recargo: el del recargo, mientras no se acredite, sería
    // una segunda promesa por el mismo dinero.
    return filas.filter(
      (r) =>
        !(
          r.kind === RefundKind.EXPRESS_SURCHARGE &&
          r.status !== RefundStatus.SUCCEEDED &&
          filas.some(
            (o) => o.kind === RefundKind.FULL && o.paymentId === r.paymentId,
          )
        ),
    );
  }

  /** Listado de la distribuidora, el más nuevo primero; `status` filtra (p. ej. `failed`). */
  async listar(
    distributorId: string,
    filtros: FiltrosDeReintegros,
  ): Promise<{ items: PaymentRefund[]; total: number }> {
    const [items, total] = await this.refunds.findAndCount({
      where: {
        distributorId,
        ...(filtros.status ? { status: filtros.status } : {}),
      },
      order: { createdAt: 'DESC', refundId: 'ASC' },
      take: filtros.limit,
      skip: filtros.offset,
    });
    return { items, total };
  }

  /** Pagos del pedido aprobados por una pasarela (no efectivo ni transferencia), los más viejos primero. */
  private pagosAprobados(orderId: string): Promise<Payment[]> {
    return this.payments.find({
      where: {
        orderId,
        status: LedgerPaymentStatus.APPROVED,
        gateway: Not(PaymentGateway.CASH),
      },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * La devolución total del pago: lo que falta devolver. `null` si no queda
   * nada (ya se devolvió todo por otras solicitudes).
   */
  private async solicitudParaCancelacion(
    pago: Payment,
  ): Promise<PaymentRefund | null> {
    const existente = await this.refunds.findOne({
      where: { paymentId: pago.paymentId, kind: RefundKind.FULL },
    });
    if (existente) return existente;
    const devuelto = await this.refunds.find({
      where: {
        paymentId: pago.paymentId,
        status: RefundStatus.SUCCEEDED,
      },
    });
    const restante = devuelto.reduce(
      (acc, r) => acc.minus(r.amount),
      new Decimal(pago.amount),
    );
    if (restante.lte(0)) return null;
    return this.solicitudNueva(pago, RefundKind.FULL, restante.toNumber());
  }

  /** Crea la solicitud o devuelve la que ya existe (carrera: gana la del índice único). */
  private async solicitudNueva(
    pago: Payment,
    kind: RefundKind,
    amount: number,
  ): Promise<PaymentRefund> {
    await this.refunds
      .createQueryBuilder()
      .insert()
      .values({
        paymentId: pago.paymentId,
        orderId: pago.orderId,
        distributorId: pago.distributorId,
        kind,
        amount,
        status: RefundStatus.PENDING,
      })
      .orIgnore()
      .execute();
    return this.refunds.findOneOrFail({
      where: { paymentId: pago.paymentId, kind },
    });
  }

  /**
   * Pide la devolución a la pasarela y deja constancia. Nunca lanza por la
   * pasarela: el resultado queda en la solicitud.
   */
  private async ejecutar(
    solicitud: PaymentRefund,
    pago: Payment,
    actorUserId: string | null,
  ): Promise<PaymentRefund> {
    if (solicitud.status === RefundStatus.SUCCEEDED) return solicitud;
    if (!pago.gatewayPaymentId) {
      return this.registrarFallo(
        solicitud,
        'El pago no tiene id en la pasarela',
        actorUserId,
      );
    }

    const antes = await this.estadoEnPasarela(pago.gatewayPaymentId);
    if (antes?.status === ESTADO_DEVUELTO) {
      return this.registrarExito(solicitud, pago, null, actorUserId);
    }
    // Un intento anterior (fallido, o cortado a mitad) pudo haberse aplicado
    // igual: se mira antes de pedir nada.
    if (this.seAplico(solicitud, antes)) {
      return this.registrarExito(solicitud, pago, null, actorUserId);
    }
    // Nunca se pide más de lo que la pasarela cobró y no devolvió: el importe
    // del ledger puede incluir recargos que no pasaron por ella.
    const monto = this.montoDevolvible(solicitud.amount, antes);
    if (monto <= 0) {
      return this.registrarExito(solicitud, pago, null, actorUserId);
    }
    const clave = this.claveDeIntento(solicitud, antes);
    await this.refunds.update(
      { refundId: solicitud.refundId },
      {
        amount: monto,
        refundedBaseline: antes?.refundedAmount ?? solicitud.refundedBaseline,
      },
    );
    solicitud.amount = monto;

    try {
      const respuesta = await this.gateway.refundPayment({
        gatewayPaymentId: pago.gatewayPaymentId,
        amount: monto,
        idempotencyKey: clave,
      });
      return this.registrarExito(
        solicitud,
        pago,
        respuesta.refundId,
        actorUserId,
      );
    } catch (error) {
      // La pasarela pudo haber devuelto igual (timeout con la solicitud ya
      // aplicada). En una devolución parcial el estado del pago no cambia: se
      // decide por lo devuelto, antes contra después.
      const despues = await this.estadoEnPasarela(pago.gatewayPaymentId);
      if (
        despues?.status === ESTADO_DEVUELTO ||
        this.subioLoDevuelto(antes, despues, monto)
      ) {
        return this.registrarExito(solicitud, pago, null, actorUserId);
      }
      this.logger.warn(
        `Devolución ${solicitud.refundId} del pedido ${solicitud.orderId} rechazada: ${errorMessage(error)}`,
      );
      return this.registrarFallo(solicitud, errorMessage(error), actorUserId);
    }
  }

  /** ¿Lo devuelto por la pasarela subió al menos `monto` entre las dos lecturas? */
  private subioLoDevuelto(
    antes: GatewayPayment | null,
    despues: GatewayPayment | null,
    monto: number,
  ): boolean {
    if (antes?.refundedAmount == null || despues?.refundedAmount == null) {
      return false;
    }
    return new Decimal(despues.refundedAmount)
      .minus(antes.refundedAmount)
      .gte(new Decimal(monto).minus(TOLERANCIA));
  }

  /** ¿Un intento anterior de esta solicitud se aplicó en la pasarela? (lo devuelto desde que arrancó). */
  private seAplico(
    solicitud: PaymentRefund,
    estado: GatewayPayment | null,
  ): boolean {
    if (solicitud.refundedBaseline == null || estado?.refundedAmount == null) {
      return false;
    }
    return new Decimal(estado.refundedAmount)
      .minus(solicitud.refundedBaseline)
      .gte(new Decimal(solicitud.amount).minus(TOLERANCIA));
  }

  /**
   * Clave de idempotencia del intento. Es siempre `refund_id` (repetir la
   * llamada nunca devuelve dos veces) salvo que ya hubo un intento fallido y la
   * pasarela confirma que NO se aplicó: ahí se usa `refund_id:intento`, porque
   * una clave ya usada puede devolver el rechazo guardado en vez de reintentar.
   */
  private claveDeIntento(
    solicitud: PaymentRefund,
    estado: GatewayPayment | null,
  ): string {
    const confirmadoSinAplicar =
      solicitud.attempts > 0 &&
      solicitud.refundedBaseline != null &&
      estado?.refundedAmount != null;
    return confirmadoSinAplicar
      ? `${solicitud.refundId}:${solicitud.attempts}`
      : solicitud.refundId;
  }

  /** El pago tal como lo ve la pasarela, o null si no responde. Nunca lanza. */
  private async estadoEnPasarela(
    gatewayPaymentId: string,
  ): Promise<GatewayPayment | null> {
    try {
      return await this.gateway.getPayment(gatewayPaymentId);
    } catch {
      return null;
    }
  }

  /** Lo pedido, acotado a lo que la pasarela cobró y todavía no devolvió. */
  private montoDevolvible(
    pedido: number,
    estado: GatewayPayment | null,
  ): number {
    if (estado?.amount == null) return pedido;
    const restante = new Decimal(estado.amount).minus(
      estado.refundedAmount ?? 0,
    );
    return Decimal.min(pedido, restante)
      .toDecimalPlaces(2, Decimal.ROUND_DOWN)
      .toNumber();
  }

  private async registrarExito(
    solicitud: PaymentRefund,
    pago: Payment,
    gatewayRefundId: string | null,
    actorUserId: string | null,
  ): Promise<PaymentRefund> {
    // Sólo uno gana el cierre: es quien actualiza el pago, asienta la salida de
    // la caja y avisa. La salida va en la misma transacción que el cierre, así
    // una devolución cerrada tiene su egreso (o queda sin asentar y se avisa).
    const { cierre, actual, asiento } = await this.refunds.manager.transaction(
      async (manager) => {
        // Mismo orden de locks que `settle-pending`: primero el pago, después la caja.
        await manager.query(
          `SELECT 1 FROM "payment" WHERE "payment_id" = $1 FOR UPDATE`,
          [pago.paymentId],
        );
        const resultado = await manager.update(
          PaymentRefund,
          { refundId: solicitud.refundId, status: Not(RefundStatus.SUCCEEDED) },
          {
            status: RefundStatus.SUCCEEDED,
            gatewayRefundId,
            errorMessage: null,
            refundedAt: new Date(),
            requestedByUserId: actorUserId,
            attempts: () => '"attempts" + 1',
          },
        );
        const cerrada = await manager.findOneOrFail(PaymentRefund, {
          where: { refundId: solicitud.refundId },
        });
        const distributorId = pago.distributorId;
        const salida =
          resultado.affected && distributorId
            ? {
                distributorId,
                resultado: await this.ventasEnCaja.asentarDevolucion(manager, {
                  distributorId,
                  orderId: cerrada.orderId,
                  paymentId: pago.paymentId,
                  refundId: cerrada.refundId,
                  gatewayPaymentId: pago.gatewayPaymentId ?? pago.paymentId,
                  amount: cerrada.amount,
                  userId: actorUserId,
                }),
              }
            : undefined;
        return { cierre: resultado, actual: cerrada, asiento: salida };
      },
    );
    if (asiento) {
      this.ventasEnCaja.avisarSinAsentar(
        asiento.distributorId,
        asiento.resultado,
        actual.orderId,
      );
    }
    if (!cierre.affected) return actual;

    if (solicitud.kind === RefundKind.FULL) {
      await this.payments.update(
        { paymentId: pago.paymentId },
        { status: LedgerPaymentStatus.REFUNDED },
      );
    }
    this.eventos.emit(
      EVENTO_PAGO_REINTEGRADO,
      new PagoReintegradoEvent(this.resumen(actual)),
    );
    return actual;
  }

  private async registrarFallo(
    solicitud: PaymentRefund,
    motivo: string,
    actorUserId: string | null,
  ): Promise<PaymentRefund> {
    const texto = motivo.slice(0, MAX_ERROR);
    const cierre = await this.refunds.update(
      {
        refundId: solicitud.refundId,
        status: In([RefundStatus.PENDING, RefundStatus.FAILED]),
      },
      {
        status: RefundStatus.FAILED,
        errorMessage: texto,
        requestedByUserId: actorUserId,
        attempts: () => '"attempts" + 1',
      },
    );
    const actual = await this.refunds.findOneOrFail({
      where: { refundId: solicitud.refundId },
    });
    // Si el UPDATE condicional no afectó filas, otro proceso ya la cerró
    // (p. ej. con éxito): no hay fallo que avisar.
    if (cierre.affected) {
      this.eventos.emit(
        EVENTO_REINTEGRO_FALLIDO,
        new ReintegroFallidoEvent(this.resumen(actual), texto),
      );
    }
    return actual;
  }

  private resumen(r: PaymentRefund): ReintegroResuelto {
    return {
      orderId: r.orderId,
      refundId: r.refundId,
      paymentId: r.paymentId,
      distributorId: r.distributorId,
      kind: r.kind,
      amount: r.amount,
      attempts: r.attempts,
    };
  }
}
