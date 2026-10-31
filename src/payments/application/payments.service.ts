import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { Payment } from '../entities/payment.entity';
import { PaymentRefund } from '../entities/payment-refund.entity';
import {
  montoCoincide,
  puedeTransicionarElPago,
} from '../domain/payment-status.machine';
import {
  PaymentGateway,
  PaymentIntegration,
  LedgerPaymentStatus,
} from '../domain/payment.enums';
import {
  CreateCheckoutResult,
  GatewayPayment,
  PaymentCheckoutItem,
  PaymentGatewayPort,
  VerifyWebhookSignatureInput,
} from '../domain/ports/payment-gateway.port';
import {
  OrderLookupService,
  OrderPaymentState,
} from '../../order/lookup/order-lookup.service';
import { OrderStatus, PaymentStatus } from '../../order/entities/order.entity';
import { errorMessage } from '../../common/errors/error-message';
import {
  idCortoDePedido,
  pedirAvisoAlAdmin,
} from '../../common/events/aviso-al-admin';
import {
  ResultadoDelAsiento,
  SalesCashService,
} from '../../cash/application/sales-cash.service';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';

/** Input para crear un checkout: agnóstico de la pasarela concreta. */
export interface CreatePaymentCheckoutInput {
  orderId: string;
  distributorId?: string | null;
  /** Monto real a cobrar en este intento (el pedido completo o solo la seña). */
  amount: number;
  /** true si este intento cobra la SEÑA de una reserva, no el pedido completo. */
  isDeposit: boolean;
  items: PaymentCheckoutItem[];
  payerEmail: string;
}

export interface ConfirmFromGatewayInput {
  type?: string;
  dataId?: string;
  /** Cuenta de Mercado Pago de la notificación (credencial propia); `null` o ausente = la del sistema. */
  credentialId?: string | null;
}

/**
 * Resultado normalizado de una notificación de la pasarela, listo para que el
 * caller (hoy `ConfirmPaymentUseCase`, en `order`) decida los efectos de
 * NEGOCIO del pedido (marcar PAID, activar reserva, despachar, etc.) — este
 * servicio solo interpreta la pasarela y actualiza el ledger, nunca toca
 * `order`.
 */
export interface ConfirmFromGatewayResult {
  externalReference: string;
  gatewayPaymentId: string;
  /** Estado CRUDO de la pasarela (ej. 'approved'/'rejected'/'pending'). */
  status: string;
  /** Derivado del ledger: si el `Payment` matcheado es una seña. */
  isDeposit: boolean;
  /**
   * Presente cuando la pasarela aprobó un importe distinto del esperado: el
   * caller no tiene que dar el pedido por pagado ni despacharlo.
   */
  montoDistinto?: { esperado: number; cobrado: number };
  /**
   * Presente cuando esta notificación fue la que pasó el pago a devuelto desde
   * la pasarela (devolución hecha en su panel, o contracargo): no la pidió el
   * sistema. El caller avisa al administrador.
   */
  devolucionExterna?: { contracargo: boolean };
}

/**
 * Servicio de aplicación de pagos, GATEWAY-AGNÓSTICO: habla contra
 * `PaymentGatewayPort` (hoy MercadoPago Checkout Pro) y mantiene el ledger
 * (`Payment`) de intentos de cobro. Lo consume `order` (create-order,
 * webhook) para desacoplar el dominio de pedidos del proveedor de pago
 * concreto — sumar un gateway nuevo es agregar un adapter acá, no tocar
 * `order`.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    private readonly paymentGateway: PaymentGatewayPort,
    private readonly orderLookup: OrderLookupService,
    private readonly ventasEnCaja: SalesCashService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Crea el registro de ledger (PENDING) y delega en la pasarela la creación
   * del checkout. Si la pasarela falla, el ledger queda igual (PENDING sin
   * `payment_url`) como rastro del intento fallido — el caller (hoy
   * `CreateOrderUseCase`) decide qué hacer (best-effort: el pedido queda
   * creado igual, sin URL, el cliente puede reintentar).
   */
  async createCheckout(
    input: CreatePaymentCheckoutInput,
  ): Promise<CreateCheckoutResult> {
    const pedido = await this.assertPedidoCobrable(input.orderId);

    const ledgerPayment = await this.paymentRepository.save(
      this.paymentRepository.create({
        orderId: input.orderId,
        distributorId: input.distributorId ?? null,
        gateway: PaymentGateway.MERCADOPAGO,
        integration: PaymentIntegration.CHECKOUT_PRO,
        externalReference: input.orderId,
        amount: input.amount,
        isDeposit: input.isDeposit,
        status: LedgerPaymentStatus.PENDING,
      }),
    );

    const checkout = await this.paymentGateway.createCheckout({
      orderId: input.orderId,
      items: input.items,
      payerEmail: input.payerEmail,
      distributorId: input.distributorId,
      expiresAt: this.vencimientoDelCobro(pedido.createdAt, input.isDeposit),
    });

    ledgerPayment.paymentUrl = checkout.initPoint;
    ledgerPayment.credentialId = checkout.credentialId;
    ledgerPayment.metadata = { preferenceId: checkout.preferenceId };
    await this.paymentRepository.save(ledgerPayment);

    return checkout;
  }

  /**
   * El enlace de pago vigente de cada pedido: el del ÚLTIMO intento de cobro
   * (por fecha), y sólo si ese intento sigue pendiente y tiene URL (cubre el
   * checkout del pedido y el de la seña de una reserva). Un intento posterior
   * rechazado, cancelado o sin URL reemplaza al anterior: el enlace viejo no se
   * vuelve a publicar. Sin pedido en el mapa = no hay enlace vigente.
   */
  async findPendingCheckoutUrls(
    orderIds: string[],
  ): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (orderIds.length === 0) return urls;
    const pagos = await this.paymentRepository.find({
      where: { orderId: In(orderIds) },
      order: { createdAt: 'ASC' },
    });
    const ultimo = new Map<string, Payment>();
    for (const pago of pagos) ultimo.set(pago.orderId, pago);
    for (const [orderId, pago] of ultimo) {
      if (pago.status === LedgerPaymentStatus.PENDING && pago.paymentUrl) {
        urls.set(orderId, pago.paymentUrl);
      }
    }
    return urls;
  }

  /**
   * Cuándo vence el enlace de pago: cuando vence el pedido sin pagar (el mismo
   * plazo con que `ReservationService` cancela los impagos), así un enlace viejo
   * no cobra un pedido que el sistema ya canceló. Una seña de reserva espera las
   * horas de la reserva; un pedido normal, los minutos del pago online.
   */
  private vencimientoDelCobro(creado: Date, esSena: boolean): Date {
    const plazoMs = esSena
      ? this.config.getOrThrow<number>('RESERVATION_DEPOSIT_TTL_HOURS') *
        3600 *
        1000
      : this.config.getOrThrow<number>(
          'ORDER_MERCADOPAGO_PENDING_TTL_MINUTES',
        ) *
        60 *
        1000;
    // Mercado Pago rechaza un vencimiento que ya pasó: un pedido recién creado
    // siempre deja al menos un minuto para pagar.
    const minimo = Date.now() + 60 * 1000;
    return new Date(Math.max(creado.getTime() + plazoMs, minimo));
  }

  /** 404 si el pedido no existe; 409 si ya no se puede cobrar. Devuelve el estado leído. */
  private async assertPedidoCobrable(
    orderId: string,
  ): Promise<OrderPaymentState> {
    const pedido = await this.orderLookup.findPaymentState(orderId);
    if (!pedido) {
      throw new NotFoundException(`Pedido ${orderId} no encontrado`);
    }
    if (pedido.paymentStatus === PaymentStatus.PAID) {
      throw new ConflictException('El pedido ya está pagado');
    }
    if (pedido.status === OrderStatus.CANCELLED) {
      throw new ConflictException(
        'El pedido está cancelado: no se puede cobrar',
      );
    }
    if (pedido.status === OrderStatus.DELIVERED) {
      throw new ConflictException(
        'El pedido ya fue entregado: no se puede cobrar',
      );
    }
    return pedido;
  }

  /**
   * Interpreta una notificación de webhook: consulta el pago REAL en la
   * pasarela (nunca confía en el payload del webhook) y actualiza el ledger.
   * Devuelve `null` cuando no hay nada que procesar (tipo de notificación
   * irrelevante, sin `dataId`, consulta a la pasarela fallida, o pago sin
   * `external_reference`) — el caller no debe seguir el flujo en ese caso.
   */
  async confirmFromGateway(
    input: ConfirmFromGatewayInput,
  ): Promise<ConfirmFromGatewayResult | null> {
    if (input.type !== 'payment' || !input.dataId) {
      // Otros tipos de notificación (merchant_order, etc.) no nos interesan.
      this.logger.debug(`Notificación ignorada (type=${input.type})`);
      return null;
    }

    let gatewayPayment: GatewayPayment;
    try {
      gatewayPayment = await this.paymentGateway.getPayment(
        input.dataId,
        input.credentialId,
      );
    } catch (error) {
      this.logger.error(
        `No se pudo consultar el pago ${input.dataId} en la pasarela: ${errorMessage(error)}`,
      );
      return null;
    }

    if (!gatewayPayment.externalReference) {
      this.logger.warn(
        `Pago ${gatewayPayment.id} sin external_reference, se ignora`,
      );
      return null;
    }

    const credentialId = input.credentialId ?? null;
    const {
      isDeposit,
      estadoAtrasado,
      montoDistinto,
      asiento,
      cuentaDistinta,
      devueltoAhora,
      sinIntentoDeCobro,
    } = await this.updateLedger(gatewayPayment, credentialId);
    if (sinIntentoDeCobro) {
      await this.avisarPagoSinIntento(
        gatewayPayment.externalReference,
        gatewayPayment.id,
      );
    }
    if (cuentaDistinta) {
      this.logger.warn(
        `Pago ${gatewayPayment.id}: la cuenta de Mercado Pago de la notificación no es la del pedido ${gatewayPayment.externalReference}; se ignora`,
      );
      return null;
    }
    if (asiento) {
      this.ventasEnCaja.avisarSinAsentar(
        asiento.distributorId,
        asiento.resultado,
        gatewayPayment.externalReference,
      );
    }

    return {
      externalReference: gatewayPayment.externalReference,
      gatewayPaymentId: gatewayPayment.id,
      // Una notificación atrasada no cambia lo que ya sabemos del pago.
      status: estadoAtrasado ?? gatewayPayment.status,
      isDeposit,
      ...(montoDistinto && { montoDistinto }),
      ...(devueltoAhora && {
        devolucionExterna: {
          contracargo: gatewayPayment.status === 'charged_back',
        },
      }),
    };
  }

  /**
   * Pago aprobado, rechazado o pendiente de un pedido que no tiene ningún
   * intento de cobro registrado: se avisa en la bandeja del administrador para
   * que lo revise en Mercado Pago. Best-effort, una vez por pago.
   */
  private async avisarPagoSinIntento(
    orderId: string,
    gatewayPaymentId: string,
  ): Promise<void> {
    try {
      const pedido = await this.orderLookup.findPaymentState(orderId);
      if (!pedido?.distributorId) return;
      pedirAvisoAlAdmin(this.events, this.logger, {
        distributorId: pedido.distributorId,
        kind: 'payment_without_attempt',
        title: 'Pago de Mercado Pago sin intento de cobro registrado',
        body: `Pedido #${idCortoDePedido(orderId)}: llegó el pago ${gatewayPaymentId} de Mercado Pago y el pedido no tiene ningún intento de cobro registrado. Revisalo en Mercado Pago.`,
        link: { entity: 'order', id: orderId },
        dedupeKey: `mp-sin-intento:${gatewayPaymentId}`,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar el pago ${gatewayPaymentId} sin intento de cobro: ${errorMessage(error)}`,
      );
    }
  }

  verifyWebhookSignature(input: VerifyWebhookSignatureInput): Promise<boolean> {
    return this.paymentGateway.verifyWebhookSignature(input);
  }

  /**
   * Actualiza el registro de ledger correspondiente a este pago de la
   * pasarela. Idempotente: si ya existe un `Payment` con ese
   * `gateway_payment_id` (reintento del webhook), lo reutiliza en vez de
   * crear uno nuevo. Si es la primera notificación, matchea el `Payment`
   * PENDING creado en `createCheckout` para ese pedido (todavía sin
   * `gateway_payment_id`). Devuelve `is_deposit` del registro matcheado (o
   * `false` si no se encontró ninguno, para no romper al caller).
   */
  private async updateLedger(
    gatewayPayment: GatewayPayment,
    credentialId: string | null,
    reintento = false,
  ): Promise<{
    isDeposit: boolean;
    /** Estado vigente del ledger cuando la notificación llegó atrasada. */
    estadoAtrasado?: LedgerPaymentStatus;
    montoDistinto?: { esperado: number; cobrado: number };
    /** Qué pasó con el ingreso a caja de un pago recién aprobado. */
    asiento?: { resultado: ResultadoDelAsiento; distributorId: string };
    /** El aviso vino de una cuenta que no es la del intento de cobro: no se toca nada. */
    cuentaDistinta?: true;
    /** Esta notificación pasó el pago a devuelto (no lo había devuelto el sistema). */
    devueltoAhora?: true;
    /** El pedido no tiene ningún intento de cobro registrado para este pago. */
    sinIntentoDeCobro?: true;
  }> {
    // Leer, validar y escribir con la fila del pago bloqueada: dos notificaciones
    // intercaladas se aplican una detrás de la otra y la segunda ya ve el estado
    // que dejó la primera (no hay carrera que deje `pending` después de `approved`).
    try {
      return await this.actualizarLedgerEnTransaccion(
        gatewayPayment,
        credentialId,
      );
    } catch (error) {
      // Otra notificación del mismo pago ya se llevó ese id de pasarela
      // (índice único): no es un error, el pago ya está procesado. Se vuelve a
      // resolver y se aplica sobre el intento que corresponde.
      if (!reintento && codigoSqlDelError(error) === '23505') {
        this.logger.warn(
          `Pago ${gatewayPayment.id}: otra notificación lo procesó al mismo tiempo, se reintenta`,
        );
        return this.updateLedger(gatewayPayment, credentialId, true);
      }
      throw error;
    }
  }

  private async actualizarLedgerEnTransaccion(
    gatewayPayment: GatewayPayment,
    credentialId: string | null,
  ): Promise<{
    isDeposit: boolean;
    cuentaDistinta?: true;
    estadoAtrasado?: LedgerPaymentStatus;
    montoDistinto?: { esperado: number; cobrado: number };
    asiento?: { resultado: ResultadoDelAsiento; distributorId: string };
    devueltoAhora?: true;
    /** El pedido no tiene ningún intento de cobro registrado para este pago. */
    sinIntentoDeCobro?: true;
  }> {
    return this.paymentRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(Payment);
      const bloqueado = { mode: 'pessimistic_write' } as const;
      const porPasarela = () =>
        repo.findOne({
          where: { gatewayPaymentId: gatewayPayment.id },
          lock: bloqueado,
        });

      let ledgerPayment = await porPasarela();
      if (!ledgerPayment) {
        const candidato = await repo.findOne({
          where: {
            externalReference: gatewayPayment.externalReference ?? undefined,
            gatewayPaymentId: IsNull(),
          },
          order: { createdAt: 'DESC' },
          lock: bloqueado,
        });
        // Con el candidato bloqueado se vuelve a resolver la identidad: si otra
        // notificación del mismo pago ya tomó OTRO intento (con dos intentos sin
        // id de pasarela, cada una pudo elegir uno distinto), ese es el pago.
        ledgerPayment = (await porPasarela()) ?? candidato;
      }

      // Un pago nuevo del MISMO checkout (reintento tras un rechazo, o tarjeta
      // después de un ticket que sigue pendiente) no tiene fila libre: el intento
      // que ya tomó el pago anterior es el que dice con qué cuenta, qué monto y
      // qué preferencia. Se le abre una fila nueva, pendiente, y sigue el camino
      // normal (monto, estado, caja).
      if (!ledgerPayment) {
        const previo = await repo.findOne({
          where: {
            externalReference: gatewayPayment.externalReference ?? undefined,
            status: In([
              LedgerPaymentStatus.PENDING,
              LedgerPaymentStatus.REJECTED,
              LedgerPaymentStatus.CANCELLED,
            ]),
          },
          order: { createdAt: 'DESC' },
          lock: bloqueado,
        });
        // Con el intento bloqueado, otra notificación de este mismo pago pudo
        // haberle abierto la fila mientras se esperaba.
        ledgerPayment = (await porPasarela()) ?? null;
        if (!ledgerPayment && previo) {
          if ((previo.credentialId ?? null) !== credentialId) {
            return { isDeposit: false, cuentaDistinta: true };
          }
          this.logger.log(
            `Pago ${gatewayPayment.id}: nuevo pago del mismo checkout del pedido ${previo.orderId}; se registra un intento de cobro nuevo`,
          );
          ledgerPayment = await repo.save(
            repo.create({
              orderId: previo.orderId,
              distributorId: previo.distributorId,
              gateway: previo.gateway,
              integration: previo.integration,
              externalReference: previo.externalReference,
              credentialId: previo.credentialId,
              amount: previo.amount,
              isDeposit: previo.isDeposit,
              paymentUrl: previo.paymentUrl,
              metadata: previo.metadata?.preferenceId
                ? { preferenceId: previo.metadata.preferenceId }
                : null,
              status: LedgerPaymentStatus.PENDING,
            }),
          );
        }
      }

      if (!ledgerPayment) {
        // Ningún intento de cobro de este pedido: no se puede saber con qué
        // monto ni con qué cuenta se pidió. Con la cuenta del entorno el pedido
        // se confirma igual como hasta ahora; con una cuenta propia no se puede
        // atribuir a ninguna distribuidora y no se confirma. En los dos casos se
        // avisa al administrador: un cobro nunca queda en silencio.
        this.logger.warn(
          `Pago ${gatewayPayment.id} sin Payment de ledger asociado (pedido ${gatewayPayment.externalReference})`,
        );
        return {
          isDeposit: false,
          sinIntentoDeCobro: true,
          ...(credentialId !== null && { cuentaDistinta: true as const }),
        };
      }

      // La cuenta que consultó el pago tiene que ser la del intento de cobro: un
      // aviso de la cuenta de otra distribuidora (o de la del sistema contra un
      // pedido que cobra con cuenta propia, y al revés) no confirma nada.
      if ((ledgerPayment.credentialId ?? null) !== credentialId) {
        return { isDeposit: false, cuentaDistinta: true };
      }

      const nuevoEstado = this.toLedgerStatus(gatewayPayment.status);
      const permitido = puedeTransicionarElPago(
        ledgerPayment.status,
        nuevoEstado,
      );
      if (!permitido) {
        this.logger.warn(
          `Pago ${gatewayPayment.id}: la notificación (${gatewayPayment.status}) llegó después de ${ledgerPayment.status} y no se aplica`,
        );
      }

      // Lo que la pasarela cobró tiene que ser lo que se pidió cobrar.
      const esperado = Number(ledgerPayment.amount);
      const cobrado = gatewayPayment.amount ?? null;
      const montoNuevo =
        permitido &&
        nuevoEstado === LedgerPaymentStatus.APPROVED &&
        cobrado !== null &&
        !montoCoincide(esperado, cobrado)
          ? { esperado, cobrado }
          : undefined;
      if (montoNuevo) {
        this.logger.error(
          `ALERTA: el pago ${gatewayPayment.id} del pedido ${ledgerPayment.orderId} se aprobó por ${cobrado} y se esperaba ${esperado}: no se da por pagado ni se despacha`,
        );
      }
      // La alerta es persistente: una vez marcado, cualquier notificación
      // posterior del pago (incluso un `pending` atrasado) la sigue informando.
      const montoDistinto = montoNuevo ?? montoDistintoGuardado(ledgerPayment);

      const aprobadoAhora =
        permitido &&
        nuevoEstado === LedgerPaymentStatus.APPROVED &&
        ledgerPayment.status !== LedgerPaymentStatus.APPROVED;
      // Pasó a devuelto por esta notificación: si el sistema ya lo había devuelto
      // (reintegro propio) el ledger ya figura devuelto y no se avisa de nuevo.
      const devueltoAhora =
        permitido &&
        nuevoEstado === LedgerPaymentStatus.REFUNDED &&
        ledgerPayment.status !== LedgerPaymentStatus.REFUNDED &&
        (await manager
          .getRepository(PaymentRefund)
          .count({ where: { paymentId: ledgerPayment.paymentId } })) === 0;
      const devuelto = devueltoSegunLaPasarela(gatewayPayment);
      const devueltoGuardado = Number(
        ledgerPayment.metadata?.gatewayRefunded ?? 0,
      );
      ledgerPayment.gatewayPaymentId = gatewayPayment.id;
      if (permitido) ledgerPayment.status = nuevoEstado;
      if (aprobadoAhora) ledgerPayment.approvedAt = new Date();
      ledgerPayment.metadata = {
        ...(ledgerPayment.metadata ?? {}),
        gatewayStatus: gatewayPayment.status,
        ...(aprobadoAhora && {
          gatewayAmount: cobrado ?? esperado,
          feeAmount: gatewayPayment.feeAmount ?? null,
          feeStatus:
            gatewayPayment.feeAmount == null ? 'unreported' : 'reported',
        }),
        ...(devuelto > devueltoGuardado && { gatewayRefunded: devuelto }),
        ...(montoDistinto && { montoDistinto }),
      };
      await repo.save(ledgerPayment);

      // El dinero que la pasarela acreditó entra a la caja de Mercado Pago en la
      // misma transacción que aprueba el pago, y lo que la pasarela devolvió por
      // su cuenta (devolución desde su panel, contracargo) sale de ella. Un fallo
      // del asiento no frena la confirmación: queda sin asentar.
      const distributorId = ledgerPayment.distributorId;
      const resultados: ResultadoDelAsiento[] = [];
      if (distributorId && aprobadoAhora) {
        resultados.push(
          await this.ventasEnCaja.asentarCobroDeMercadoPago(manager, {
            distributorId,
            orderId: ledgerPayment.orderId,
            paymentId: ledgerPayment.paymentId,
            gatewayPaymentId: gatewayPayment.id,
            amount: cobrado ?? esperado,
            feeAmount: gatewayPayment.feeAmount,
            feeUnreported: gatewayPayment.feeAmount == null,
          }),
        );
      }
      if (distributorId && devuelto > 0) {
        resultados.push(
          await this.ventasEnCaja.asentarDevolucionExterna(manager, {
            distributorId,
            orderId: ledgerPayment.orderId,
            paymentId: ledgerPayment.paymentId,
            gatewayPaymentId: gatewayPayment.id,
            refundedTotal: devuelto,
            contracargo: gatewayPayment.status === 'charged_back',
          }),
        );
      }
      const resultado =
        resultados.find((r) => r === 'fallo' || r === 'sin_caja') ??
        resultados[0];
      const asiento =
        distributorId && resultado ? { distributorId, resultado } : undefined;

      return {
        isDeposit: ledgerPayment.isDeposit,
        ...(!permitido && { estadoAtrasado: ledgerPayment.status }),
        ...(montoDistinto && { montoDistinto }),
        ...(asiento && { asiento }),
        ...(devueltoAhora && { devueltoAhora: true as const }),
      };
    });
  }

  private toLedgerStatus(gatewayStatus: string): LedgerPaymentStatus {
    switch (gatewayStatus) {
      case 'approved':
        return LedgerPaymentStatus.APPROVED;
      case 'rejected':
        return LedgerPaymentStatus.REJECTED;
      case 'cancelled':
        return LedgerPaymentStatus.CANCELLED;
      case 'refunded':
      case 'charged_back':
        return LedgerPaymentStatus.REFUNDED;
      default:
        return LedgerPaymentStatus.PENDING;
    }
  }
}

/** La alerta de monto distinto que quedó guardada en el pago, si la hay. */
function montoDistintoGuardado(
  pago: Payment,
): { esperado: number; cobrado: number } | undefined {
  const guardado: unknown = pago.metadata?.montoDistinto;
  if (typeof guardado !== 'object' || guardado === null) return undefined;
  const { esperado, cobrado } = guardado as Record<string, unknown>;
  return typeof esperado === 'number' && typeof cobrado === 'number'
    ? { esperado, cobrado }
    : undefined;
}

/** Lo que la pasarela dice que devolvió de un pago: lo informado, o todo si está devuelto o con contracargo. */
function devueltoSegunLaPasarela(pago: GatewayPayment): number {
  const informado = pago.refundedAmount ?? 0;
  if (pago.status === 'refunded' || pago.status === 'charged_back') {
    return informado > 0 ? informado : (pago.amount ?? 0);
  }
  return informado;
}
