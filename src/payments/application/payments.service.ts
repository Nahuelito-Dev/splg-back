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

import { CambioDeEstadoDelPago, Payment } from '../entities/payment.entity';
import { PaymentRefund } from '../entities/payment-refund.entity';
import {
  ESTADOS_REINTENTABLES,
  estadoDelLedgerDesde,
  montoCoincide,
  normalizarDetalleDelEstado,
  pagoCobrado,
  puedeTransicionarElPago,
} from '../domain/payment-status.machine';
import {
  PaymentGateway,
  PaymentIntegration,
  LedgerPaymentStatus,
  OrigenDelEstadoDelPago,
} from '../domain/payment.enums';
import { etiquetaDelPago } from '../domain/payment-status-label';
import {
  CheckoutAddress,
  CheckoutPayer,
  CreateCheckoutResult,
  GatewayChargeback,
  GatewayPayment,
  PaymentCheckoutItem,
  PaymentGatewayPort,
  ResultadoDeFirma,
  VerifyWebhookSignatureInput,
} from '../domain/ports/payment-gateway.port';
import {
  OrderLookupService,
  OrderPaymentState,
} from '../../order/lookup/order-lookup.service';
import { OrderStatus, PaymentStatus } from '../../order/entities/order.entity';
import { errorMessage, errorStatus } from '../../common/errors/error-message';
import {
  idCortoDePedido,
  pedirAvisoAlAdmin,
} from '../../common/events/aviso-al-admin';
import {
  ResultadoDelAsiento,
  SalesCashService,
} from '../../cash/application/sales-cash.service';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { descriptorDeResumen } from '../domain/statement-descriptor';

/** Tipos de aviso de `type` del webhook que traen un contracargo (el nombre varía según el canal). */
const TIPOS_DE_CONTRACARGO = ['topic_chargebacks_wh', 'chargebacks'];

/** Tipo de aviso con que Mercado Pago informa una alerta de fraude sobre un pago ya hecho. */
export const TIPO_ALERTA_DE_FRAUDE = 'stop_delivery_op_wh';

/** Input para crear un checkout: agnóstico de la pasarela concreta. */
export interface CreatePaymentCheckoutInput {
  orderId: string;
  distributorId?: string | null;
  /** Monto real a cobrar en este intento (el pedido completo o solo la seña). */
  amount: number;
  /** true si este intento cobra la SEÑA de una reserva, no el pedido completo. */
  isDeposit: boolean;
  items: PaymentCheckoutItem[];
  payer: CheckoutPayer;
  /** Dónde se entrega el pedido. */
  receiverAddress?: CheckoutAddress | null;
}

export interface ConfirmFromGatewayInput {
  type?: string;
  dataId?: string;
  /** De dónde sale esta lectura del pago (queda en el historial); por defecto un webhook. */
  origin?: OrigenDelEstadoDelPago;
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
  /** Motivo del estado (`status_detail`). */
  statusDetail?: string | null;
  /**
   * Presente cuando el aviso es una alerta de fraude sobre este pago
   * (`stop_delivery_op_wh`): el pedido no se tiene que entregar.
   */
  alertaDeFraude?: true;
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
  /** Mercado Pago le devolvió al comercio lo que retuvo por un contracargo (`reimbursed`). */
  contracargoReintegrado?: true;
  /** `reimbursed` sin resolución a favor del comercio: no se asentó nada, lo concilia el administrador. */
  contracargoAConciliar?: true;
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

    const vencimiento = this.vencimientoDelCobro(
      pedido.createdAt,
      input.isDeposit,
    );
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
      payer: input.payer,
      receiverAddress: input.receiverAddress,
      statementDescriptor: await this.descriptorDeLaDistribuidora(
        input.distributorId,
      ),
      distributorId: input.distributorId,
      expiresAt: vencimiento,
    });

    ledgerPayment.paymentUrl = checkout.initPoint;
    ledgerPayment.credentialId = checkout.credentialId;
    ledgerPayment.metadata = {
      preferenceId: checkout.preferenceId,
      expiresAt: vencimiento.toISOString(),
    };
    await this.paymentRepository.save(ledgerPayment);

    return checkout;
  }

  /** El nombre corto de la distribuidora para el resumen de la tarjeta (`SPLG` si no se lo puede leer). */
  private async descriptorDeLaDistribuidora(
    distributorId?: string | null,
  ): Promise<string> {
    if (!distributorId) return descriptorDeResumen();
    try {
      const distribuidora = await this.paymentRepository.manager.findOne(
        Distributor,
        {
          where: { distributorId },
          select: { distributorId: true, name: true },
        },
      );
      return descriptorDeResumen(distribuidora?.name);
    } catch (error) {
      this.logger.warn(
        `No se pudo leer el nombre de la distribuidora ${distributorId} para el resumen de la tarjeta: ${errorMessage(error)}`,
      );
      return descriptorDeResumen();
    }
  }

  /**
   * El enlace de pago vigente de cada pedido: el del intento de cobro que
   * corresponde (ver `elegirPagoRepresentativo`) si todavía se puede pagar con él:
   * pendiente, o rechazado/cancelado con el checkout sin vencer (el comprador
   * reintenta con otro medio sobre el mismo enlace). Un pedido con un pago en
   * curso, acreditado, devuelto o con reclamo no publica enlace. Cubre el checkout
   * del pedido y el de la seña de una reserva. Sin pedido en el mapa = no hay
   * enlace vigente.
   */
  async findPendingCheckoutUrls(
    orderIds: string[],
  ): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (orderIds.length === 0) return urls;
    const pagos = await this.paymentRepository.find({
      where: { orderId: In(orderIds), gateway: PaymentGateway.MERCADOPAGO },
      order: { createdAt: 'ASC' },
    });
    for (const [orderId, delPedido] of agruparPorPedido(pagos)) {
      const pago = elegirPagoRepresentativo(delPedido);
      if (pago && this.sePuedeReintentarConEl(pago)) {
        urls.set(orderId, pago.paymentUrl as string);
      }
    }
    return urls;
  }

  /** ¿El comprador puede (seguir) pagando con el enlace de este intento? */
  private sePuedeReintentarConEl(pago: Payment): boolean {
    if (!pago.paymentUrl) return false;
    if (pago.status === LedgerPaymentStatus.PENDING) {
      // Un pendiente con id de la pasarela es un pago ya iniciado que espera
      // (transferencia, cuota): no se publica otro enlace para no cobrar dos veces.
      return !pago.gatewayPaymentId && !this.venciElEnlace(pago);
    }
    return (
      ESTADOS_REINTENTABLES.includes(pago.status) && !this.venciElEnlace(pago)
    );
  }

  /** ¿Ya pasó el plazo de pago del checkout? (la fecha guardada; si falta, el plazo normal del pedido). */
  private venciElEnlace(pago: Payment): boolean {
    const guardado = pago.metadata?.expiresAt;
    const vence =
      typeof guardado === 'string'
        ? new Date(guardado)
        : this.vencimientoDelCobro(pago.createdAt, pago.isDeposit);
    return vence.getTime() <= Date.now();
  }

  /**
   * El estado del pago de un pedido tal como lo ven la app y el panel: uno de los
   * nueve estados de Mercado Pago, su motivo, el texto en castellano, si el
   * comprador puede reintentar y el enlace para hacerlo. Sin pagos de Mercado Pago
   * (efectivo, transferencia, sin checkout), `paymentStatus` es `null`.
   */
  async estadoDelPagoDelPedido(
    orderId: string,
    incluirHistorial: boolean,
  ): Promise<EstadoDelPagoDelPedido> {
    const pagos = await this.paymentRepository.find({
      where: { orderId, gateway: PaymentGateway.MERCADOPAGO },
      order: { createdAt: 'ASC' },
    });
    const pedido = await this.orderLookup.findPaymentState(orderId);
    return this.armarEstadoDelPago(orderId, pagos, pedido, incluirHistorial);
  }

  /** `estadoDelPagoDelPedido` para varios pedidos (la lista del panel). */
  async estadosDelPagoDePedidos(
    orderIds: string[],
  ): Promise<EstadoDelPagoDelPedido[]> {
    if (orderIds.length === 0) return [];
    const pagos = await this.paymentRepository.find({
      where: { orderId: In(orderIds), gateway: PaymentGateway.MERCADOPAGO },
      order: { createdAt: 'ASC' },
    });
    const porPedido = agruparPorPedido(pagos);
    const resultado: EstadoDelPagoDelPedido[] = [];
    for (const orderId of orderIds) {
      const pedido = await this.orderLookup.findPaymentState(orderId);
      resultado.push(
        this.armarEstadoDelPago(
          orderId,
          porPedido.get(orderId) ?? [],
          pedido,
          false,
        ),
      );
    }
    return resultado;
  }

  private armarEstadoDelPago(
    orderId: string,
    pagos: Payment[],
    pedido: OrderPaymentState | null,
    incluirHistorial: boolean,
  ): EstadoDelPagoDelPedido {
    const pago = elegirPagoRepresentativo(pagos);
    const vivo =
      !!pedido &&
      (pedido.status === OrderStatus.PENDING ||
        pedido.status === OrderStatus.RESERVED) &&
      pedido.paymentStatus !== PaymentStatus.PAID;
    const puedeReintentar = !!pago && vivo && this.sePuedeReintentarConEl(pago);
    return {
      orderId,
      paymentStatus: pago?.status ?? null,
      paymentStatusDetail: pago?.statusDetail ?? null,
      paymentStatusLabel: pago
        ? sinPagarPorCancelacion(pago, pedido)
          ? 'Sin pagar: el pedido se canceló'
          : etiquetaDelPago(pago.status, pago.statusDetail)
        : null,
      paymentFraudHold: pedido?.paymentFraudHold ?? false,
      canRetry: puedeReintentar && !pedido?.paymentFraudHold,
      paymentUrl: puedeReintentar ? (pago.paymentUrl ?? null) : null,
      ...(incluirHistorial && {
        history: pagos.flatMap((p) =>
          (p.statusHistory ?? []).map((cambio) => ({
            ...cambio,
            gatewayPaymentId: p.gatewayPaymentId,
            label: etiquetaDelPago(cambio.status, cambio.statusDetail),
          })),
        ),
      }),
    };
  }

  /**
   * Cierra en la pasarela los checkouts que quedaron abiertos de un pedido que se
   * canceló: así el enlace deja de cobrar y no aparece un pago «zombi» después. Mejor
   * esfuerzo (nunca lanza): si falla se loguea, y el barrido de pedidos cancelados
   * reintegra igual lo que se cobre.
   */
  async cerrarCheckoutsDelPedido(orderId: string): Promise<void> {
    let abiertos: Payment[];
    try {
      // Todos los intentos del pedido, también los ya cobrados: el enlace de un pedido
      // pagado y después cancelado sigue abierto y podría cobrar otra vez.
      abiertos = await this.paymentRepository.find({
        where: { orderId, gateway: PaymentGateway.MERCADOPAGO },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo leer los checkouts del pedido ${orderId} para cerrarlos: ${errorMessage(error)}`,
      );
      return;
    }
    const cerrados = new Set<string>();
    for (const pago of abiertos) {
      const preferenceId = pago.metadata?.preferenceId;
      if (typeof preferenceId !== 'string' || cerrados.has(preferenceId)) {
        continue;
      }
      cerrados.add(preferenceId);
      try {
        await this.paymentGateway.expireCheckout(
          preferenceId,
          pago.credentialId,
        );
      } catch (error) {
        this.logger.warn(
          `No se pudo cerrar el checkout ${preferenceId} del pedido ${orderId} en la pasarela: ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * Lo que la pasarela tiene de los pagos de un pedido, consultado directamente (no
   * por aviso): sirve para no cancelar un pedido cuyo pago aprobado no se avisó, y
   * para aplicar ese pago. Se consulta cada cuenta con la que se armó un checkout
   * del pedido (la propia de la distribuidora o la del sistema). Lanza si la
   * pasarela no responde: «sin respuesta» no es «sin pagos».
   */
  async consultarPagosDelPedido(orderId: string): Promise<
    Array<{
      gatewayPaymentId: string;
      status: string;
      credentialId: string | null;
    }>
  > {
    const intentos = await this.paymentRepository.find({
      where: { orderId },
      select: { credentialId: true },
    });
    const cuentas = new Set<string | null>(
      intentos.length > 0
        ? intentos.map((i) => i.credentialId ?? null)
        : [null],
    );
    const pagos: Array<{
      gatewayPaymentId: string;
      status: string;
      credentialId: string | null;
    }> = [];
    for (const credentialId of cuentas) {
      const encontrados = await this.paymentGateway.findPaymentsByReference(
        orderId,
        credentialId,
      );
      for (const pago of encontrados) {
        if (pago.externalReference !== orderId) continue;
        pagos.push({
          gatewayPaymentId: pago.id,
          status: pago.status,
          credentialId,
        });
      }
    }
    return pagos;
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
      throw new NotFoundException('Pedido no encontrado');
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
   * irrelevante, sin `dataId`, o pago sin `external_reference`) — el caller no
   * debe seguir el flujo en ese caso. Si la pasarela no responde la consulta,
   * lanza: la cola de webhooks la reintenta.
   */
  async confirmFromGateway(
    input: ConfirmFromGatewayInput,
  ): Promise<ConfirmFromGatewayResult | null> {
    if (input.type && TIPOS_DE_CONTRACARGO.includes(input.type)) {
      if (input.dataId) {
        await this.registrarContracargo(input.dataId, input.credentialId);
      }
      return null;
    }
    if (input.type === TIPO_ALERTA_DE_FRAUDE && input.dataId) {
      return this.registrarAlertaDeFraude(input.dataId, input.credentialId);
    }
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
      if (esNoEncontrado(error)) {
        // Un pago que la pasarela no conoce no aparece reintentando (p. ej. el aviso
        // de prueba del panel de MP): se descarta en vez de pedir otro reintento.
        this.logger.warn(
          `La pasarela no conoce el pago ${input.dataId}: se ignora la notificación`,
        );
        return null;
      }
      this.logger.error(
        `No se pudo consultar el pago ${input.dataId} en la pasarela: ${errorMessage(error)}`,
      );
      // Se propaga: el webhook responde 5xx y la pasarela reintenta el aviso.
      throw error;
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
      contracargoReintegradoAhora,
      contracargoAConciliarAhora,
      sinIntentoDeCobro,
      enMediacionAhora,
    } = await this.updateLedger(
      gatewayPayment,
      credentialId,
      input.origin ?? OrigenDelEstadoDelPago.WEBHOOK,
    );
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
    if (enMediacionAhora) {
      await this.avisarPagoEnMediacion(
        gatewayPayment.externalReference,
        gatewayPayment.id,
      );
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
      statusDetail: estadoAtrasado
        ? undefined
        : (gatewayPayment.statusDetail ?? undefined),
      isDeposit,
      ...(montoDistinto && { montoDistinto }),
      ...(devueltoAhora && {
        devolucionExterna: {
          contracargo: gatewayPayment.status === 'charged_back',
        },
      }),
      ...(contracargoReintegradoAhora && { contracargoReintegrado: true }),
      ...(contracargoAConciliarAhora && { contracargoAConciliar: true }),
    };
  }

  /**
   * Alerta de fraude de Mercado Pago sobre un pago (`stop_delivery_op_wh`): la
   * documentación manda cancelar el pedido sin entregarlo. Se marca en el pago, y el
   * caller (`order`) avisa al administrador y frena el despacho. Este aviso llega por
   * la bandeja de entrada (`PaymentNotificationInboxService`): Mercado Pago no lo
   * reintenta, así que el webhook ya contestó 200 y los reintentos son propios. Si la
   * pasarela no responde, lanza y la bandeja lo vuelve a intentar. Un pago que no
   * conocemos se ignora.
   *
   * Doc: https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/additional-info
   */
  private async registrarAlertaDeFraude(
    gatewayPaymentId: string,
    credentialId?: string | null,
  ): Promise<ConfirmFromGatewayResult | null> {
    // El `payment_id` del cuerpo NO está firmado (la firma cubre el `data.id` de la URL):
    // cualquiera con un secreto propio podría nombrar un pago ajeno. Por eso SIEMPRE se
    // lee el pago de Mercado Pago con la cuenta que firmó: si MP no lo tiene en esa
    // cuenta (404) o el ledger lo tiene en otra, la alerta se descarta.
    const cuenta = credentialId ?? null;
    let pago: GatewayPayment;
    try {
      pago = await this.paymentGateway.getPayment(
        gatewayPaymentId,
        credentialId,
      );
    } catch (error) {
      if (esNoEncontrado(error)) {
        this.logger.warn(
          `Alerta de fraude sobre el pago ${gatewayPaymentId}: la cuenta que firmó no lo tiene; se descarta`,
        );
        return null;
      }
      throw error;
    }
    if (!pago.externalReference) {
      this.logger.warn(
        `Alerta de fraude sobre el pago ${gatewayPaymentId} sin external_reference: se descarta`,
      );
      return null;
    }
    // Registra/actualiza el pago (si el aviso de su estado no llegó) y comprueba la cuenta.
    const { cuentaDistinta, sinIntentoDeCobro } = await this.updateLedger(
      pago,
      cuenta,
      OrigenDelEstadoDelPago.CONSULTA,
    );
    if (cuentaDistinta || sinIntentoDeCobro) {
      this.logger.warn(
        `Alerta de fraude sobre el pago ${gatewayPaymentId}: no corresponde a la cuenta que firmó; se descarta`,
      );
      return null;
    }
    const marcado = await this.marcarAlertaDeFraude(gatewayPaymentId, cuenta);
    if (!marcado) {
      this.logger.warn(
        `Alerta de fraude sobre el pago ${gatewayPaymentId}, que no está en el ledger con esa cuenta: se descarta`,
      );
      return null;
    }
    return {
      externalReference: marcado.externalReference ?? marcado.orderId,
      gatewayPaymentId,
      status: marcado.status,
      statusDetail: marcado.statusDetail,
      isDeposit: marcado.isDeposit,
      alertaDeFraude: true,
    };
  }

  private marcarAlertaDeFraude(
    gatewayPaymentId: string,
    credentialId: string | null,
  ): Promise<Payment | null> {
    return this.paymentRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(Payment);
      const pago = await repo.findOne({
        // Sólo si el ledger lo tiene con la MISMA cuenta que firmó el aviso.
        where: {
          gatewayPaymentId,
          credentialId: credentialId ?? IsNull(),
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!pago) return null;
      const previa = pago.metadata?.fraudAlert as
        | { notifiedAt?: string }
        | undefined;
      pago.metadata = {
        ...(pago.metadata ?? {}),
        fraudAlert: {
          notifiedAt: previa?.notifiedAt ?? new Date().toISOString(),
        },
      };
      await repo.save(pago);
      return pago;
    });
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

  /**
   * Un cliente abrió un reclamo sobre el pago (`in_mediation`): se avisa en la
   * bandeja del administrador para que lo atienda en Mercado Pago. Best-effort,
   * una vez por pago.
   */
  private async avisarPagoEnMediacion(
    orderId: string,
    gatewayPaymentId: string,
  ): Promise<void> {
    try {
      const pedido = await this.orderLookup.findPaymentState(orderId);
      if (!pedido?.distributorId) return;
      pedirAvisoAlAdmin(this.events, this.logger, {
        distributorId: pedido.distributorId,
        kind: 'payment_in_mediation',
        title: 'Reclamo abierto sobre un pago de Mercado Pago',
        body: `Pedido #${idCortoDePedido(orderId)}: el comprador abrió un reclamo sobre el pago ${gatewayPaymentId}. Respondelo en Mercado Pago con el comprobante de entrega.`,
        link: { entity: 'order', id: orderId },
        dedupeKey: `mp-mediacion:${gatewayPaymentId}`,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar el reclamo del pago ${gatewayPaymentId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Aviso de contracargo: se consulta el contracargo en la pasarela, se lo marca
   * en el pago del ledger, se alinea el estado del pago con lo que la pasarela dice
   * hoy (`charged_back`, y el egreso de la caja) y se avisa al administrador para
   * que presente la documentación (comprobante de entrega) antes del plazo.
   *
   * Si algo falla se lanza: el webhook responde 503 y Mercado Pago reintenta (un
   * contracargo no atendido se pierde). Todo es idempotente. Un contracargo que la
   * pasarela no conoce (404) se descarta.
   */
  private async registrarContracargo(
    chargebackId: string,
    credentialId?: string | null,
  ): Promise<void> {
    let contracargo: GatewayChargeback;
    try {
      contracargo = await this.paymentGateway.getChargeback(
        chargebackId,
        credentialId,
      );
    } catch (error) {
      if (esNoEncontrado(error)) {
        this.logger.warn(
          `La pasarela no conoce el contracargo ${chargebackId}: se ignora el aviso`,
        );
        return;
      }
      this.logger.error(
        `No se pudo consultar el contracargo ${chargebackId} en la pasarela: ${errorMessage(error)}`,
      );
      throw error;
    }
    for (const gatewayPaymentId of contracargo.paymentIds) {
      if (await this.marcarContracargo(contracargo, gatewayPaymentId)) {
        await this.alinearEstadoDelPago(gatewayPaymentId, credentialId);
      }
    }
  }

  /** Vuelve a leer el pago de la pasarela y deja el ledger (y la caja) con lo que dice hoy. */
  private async alinearEstadoDelPago(
    gatewayPaymentId: string,
    credentialId?: string | null,
  ): Promise<void> {
    const pago = await this.paymentGateway.getPayment(
      gatewayPaymentId,
      credentialId,
    );
    if (!pago.externalReference) return;
    const { asiento } = await this.updateLedger(
      pago,
      credentialId ?? null,
      OrigenDelEstadoDelPago.CONSULTA,
    );
    if (asiento) {
      this.ventasEnCaja.avisarSinAsentar(
        asiento.distributorId,
        asiento.resultado,
        pago.externalReference,
      );
    }
  }

  private async marcarContracargo(
    contracargo: GatewayChargeback,
    gatewayPaymentId: string,
  ): Promise<boolean> {
    const pago = await this.paymentRepository.manager.transaction(
      async (manager) => {
        const repo = manager.getRepository(Payment);
        const encontrado = await repo.findOne({
          where: { gatewayPaymentId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!encontrado) return null;
        encontrado.metadata = {
          ...(encontrado.metadata ?? {}),
          chargeback: {
            id: contracargo.id,
            amount: contracargo.amount,
            documentationRequired: contracargo.documentationRequired,
            documentationDeadline: contracargo.documentationDeadline,
            coverageApplied: contracargo.coverageApplied,
            notifiedAt: new Date().toISOString(),
          },
        };
        await repo.save(encontrado);
        return encontrado;
      },
    );
    if (!pago) {
      this.logger.warn(
        `Contracargo ${contracargo.id}: el pago ${gatewayPaymentId} no está en el ledger`,
      );
      return false;
    }
    const pedido = await this.orderLookup.findPaymentState(pago.orderId);
    const distributorId = pago.distributorId ?? pedido?.distributorId;
    if (!distributorId) return true;
    const plazo = contracargo.documentationDeadline
      ? ` Plazo para presentarla: ${contracargo.documentationDeadline.slice(0, 10)}.`
      : '';
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId,
      kind: 'payment_chargeback_opened',
      title: 'Contracargo abierto sobre un pago',
      body: `Pedido #${idCortoDePedido(pago.orderId)}: el cliente desconoció el pago ${gatewayPaymentId} (contracargo ${contracargo.id}).${
        contracargo.documentationRequired
          ? ` Hay que presentar documentación en Mercado Pago: el comprobante de entrega del pedido.${plazo}`
          : ' Revisalo en Mercado Pago.'
      }`,
      link: { entity: 'order', id: pago.orderId },
      dedupeKey: `mp-contracargo-abierto:${contracargo.id}:${gatewayPaymentId}`,
    });
    return true;
  }

  verifyWebhookSignature(
    input: VerifyWebhookSignatureInput,
  ): Promise<ResultadoDeFirma> {
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
    origen: OrigenDelEstadoDelPago,
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
    /** Mercado Pago devolvió al comercio lo retenido por un contracargo (`reimbursed`). */
    contracargoReintegradoAhora?: true;
    /** `reimbursed` sin que el caso diga que fue a favor del comercio: lo concilia el administrador. */
    contracargoAConciliarAhora?: true;
    /** Esta notificación fue la que puso el pago en reclamo (`in_mediation`). */
    enMediacionAhora?: true;
  }> {
    // Leer, validar y escribir con la fila del pago bloqueada: dos notificaciones
    // intercaladas se aplican una detrás de la otra y la segunda ya ve el estado
    // que dejó la primera (no hay carrera que deje `pending` después de `approved`).
    try {
      return await this.actualizarLedgerEnTransaccion(
        gatewayPayment,
        credentialId,
        origen,
      );
    } catch (error) {
      // Otra notificación del mismo pago ya se llevó ese id de pasarela
      // (índice único): no es un error, el pago ya está procesado. Se vuelve a
      // resolver y se aplica sobre el intento que corresponde.
      if (!reintento && codigoSqlDelError(error) === '23505') {
        this.logger.warn(
          `Pago ${gatewayPayment.id}: otra notificación lo procesó al mismo tiempo, se reintenta`,
        );
        return this.updateLedger(gatewayPayment, credentialId, origen, true);
      }
      throw error;
    }
  }

  private async actualizarLedgerEnTransaccion(
    gatewayPayment: GatewayPayment,
    credentialId: string | null,
    origen: OrigenDelEstadoDelPago,
  ): Promise<{
    isDeposit: boolean;
    cuentaDistinta?: true;
    estadoAtrasado?: LedgerPaymentStatus;
    montoDistinto?: { esperado: number; cobrado: number };
    asiento?: { resultado: ResultadoDelAsiento; distributorId: string };
    devueltoAhora?: true;
    /** El pedido no tiene ningún intento de cobro registrado para este pago. */
    sinIntentoDeCobro?: true;
    enMediacionAhora?: true;
    contracargoReintegradoAhora?: true;
    contracargoAConciliarAhora?: true;
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

      // Un pago nuevo del MISMO checkout (reintento tras un rechazo, tarjeta
      // después de un ticket que sigue pendiente, o un segundo pago de un pedido que
      // ya se cobró) no tiene fila libre: el intento que ya tomó el pago anterior es
      // el que dice con qué cuenta, qué monto y qué preferencia. Se le abre una fila
      // nueva, pendiente, y sigue el camino normal (monto, estado, caja). Si el pedido
      // ya estaba cobrado, `order` lo reconoce como cobro duplicado y lo devuelve.
      if (!ledgerPayment) {
        const previo = await repo.findOne({
          where: {
            externalReference: gatewayPayment.externalReference ?? undefined,
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
                ? {
                    preferenceId: previo.metadata.preferenceId,
                    ...(previo.metadata.expiresAt != null && {
                      expiresAt: previo.metadata.expiresAt,
                    }),
                  }
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

      // Los nueve estados de Mercado Pago se guardan tal cual; lo que no cabe en la
      // máquina (un aviso atrasado, fuera de orden) no cambia el pago pero queda en
      // el historial.
      const estadoAnterior = ledgerPayment.status;
      const nuevoEstado = estadoDelLedgerDesde(gatewayPayment.status);
      const permitido = puedeTransicionarElPago(estadoAnterior, nuevoEstado);
      const enMediacionAhora =
        permitido &&
        nuevoEstado === LedgerPaymentStatus.IN_MEDIATION &&
        estadoAnterior !== LedgerPaymentStatus.IN_MEDIATION;
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
        pagoCobrado(nuevoEstado) &&
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

      // El dinero se acreditó con esta notificación (aprobado, o directo a reclamo si
      // el aviso de la aprobación no llegó).
      const aprobadoAhora =
        permitido && pagoCobrado(nuevoEstado) && !pagoCobrado(estadoAnterior);
      // Pasó a devuelto por esta notificación: si el sistema ya lo había devuelto
      // (reintegro propio) el ledger ya figura devuelto y no se avisa de nuevo.
      const devueltoAhora =
        permitido &&
        (nuevoEstado === LedgerPaymentStatus.REFUNDED ||
          nuevoEstado === LedgerPaymentStatus.CHARGED_BACK) &&
        estadoAnterior !== nuevoEstado &&
        (await manager
          .getRepository(PaymentRefund)
          .count({ where: { paymentId: ledgerPayment.paymentId } })) === 0;
      const detalle = normalizarDetalleDelEstado(gatewayPayment.statusDetail);
      // Contracargo según la doc de Mercado Pago (chargebacks): mientras se resuelve el caso
      // el monto queda retenido («on hold»), no retirado; sólo `settled` («el dinero quedó
      // retenido tras el proceso») saca plata de la caja. `reimbursed` no dice a quién se
      // reintegra: el ingreso se asienta solo únicamente si el caso informa
      // `coverage_applied: true` («a favor del vendedor, el dinero se reintegra»).
      const esReintegrado =
        permitido &&
        nuevoEstado === LedgerPaymentStatus.CHARGED_BACK &&
        detalle === DETALLE_CONTRACARGO_REINTEGRADO;
      const casoAFavor = coberturaAplicada(ledgerPayment);
      const devuelto = devueltoSegunLaPasarela(gatewayPayment, detalle);
      const devueltoGuardado = Number(
        ledgerPayment.metadata?.gatewayRefunded ?? 0,
      );
      ledgerPayment.gatewayPaymentId = gatewayPayment.id;
      if (permitido) {
        ledgerPayment.status = nuevoEstado;
        ledgerPayment.statusDetail = detalle;
      }
      if (aprobadoAhora) ledgerPayment.approvedAt = new Date();
      ledgerPayment.statusHistory = agregarAlHistorial(
        ledgerPayment.statusHistory,
        {
          status: nuevoEstado,
          statusDetail: detalle,
          at: new Date().toISOString(),
          origin: origen,
          applied: permitido,
        },
      );
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
      // Se decide por el estado de la caja (hay egreso del contracargo y no hay ingreso),
      // no por el cambio de `statusDetail`: si un asiento falla, el próximo aviso o la
      // conciliación lo reintenta.
      let contracargoReintegradoAhora = false;
      let contracargoAConciliarAhora = false;
      if (distributorId && esReintegrado) {
        const r = await this.ventasEnCaja.asentarContracargoReintegrado(
          manager,
          {
            distributorId,
            orderId: ledgerPayment.orderId,
            paymentId: ledgerPayment.paymentId,
            gatewayPaymentId: gatewayPayment.id,
            automatico: casoAFavor,
          },
        );
        contracargoReintegradoAhora = r === 'asentado';
        contracargoAConciliarAhora = r === 'a_conciliar';
        if (r !== 'a_conciliar') resultados.push(r);
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
        ...(contracargoReintegradoAhora && {
          contracargoReintegradoAhora: true as const,
        }),
        ...(contracargoAConciliarAhora && {
          contracargoAConciliarAhora: true as const,
        }),
        ...(enMediacionAhora && { enMediacionAhora: true as const }),
      };
    });
  }
}

/**
 * Suma una lectura del estado al historial (de sólo agregar). Si es idéntica a la
 * última (reintento del mismo aviso) no se repite.
 */
function agregarAlHistorial(
  historial: CambioDeEstadoDelPago[] | null | undefined,
  cambio: CambioDeEstadoDelPago,
): CambioDeEstadoDelPago[] {
  const actual = historial ?? [];
  const ultimo = actual[actual.length - 1];
  if (
    ultimo &&
    ultimo.status === cambio.status &&
    ultimo.statusDetail === cambio.statusDetail &&
    ultimo.applied === cambio.applied
  ) {
    return actual;
  }
  return [...actual, cambio];
}

/** Lo que la app y el panel muestran del pago de un pedido. */
export interface EstadoDelPagoDelPedido {
  orderId: string;
  paymentStatus: LedgerPaymentStatus | null;
  paymentStatusDetail: string | null;
  paymentStatusLabel: string | null;
  /** Retenido por una alerta de fraude. */
  paymentFraudHold: boolean;
  canRetry: boolean;
  paymentUrl: string | null;
  history?: Array<
    CambioDeEstadoDelPago & {
      gatewayPaymentId: string | null;
      label: string;
    }
  >;
}

function agruparPorPedido(pagos: Payment[]): Map<string, Payment[]> {
  const porPedido = new Map<string, Payment[]>();
  for (const pago of pagos) {
    porPedido.set(pago.orderId, [...(porPedido.get(pago.orderId) ?? []), pago]);
  }
  return porPedido;
}

/** Cuánto pesa cada estado para decidir cuál es «el pago» del pedido (menor = más relevante). */
/**
 * Un pago que nunca llegó a cobrarse (pendiente, en proceso o autorizado) de un pedido ya cancelado: ya no se espera
 * nada de él, así que no se lo muestra como «Esperando el pago».
 */
function sinPagarPorCancelacion(
  pago: Payment,
  pedido: OrderPaymentState | null,
): boolean {
  return (
    pedido?.status === OrderStatus.CANCELLED &&
    (pago.status === LedgerPaymentStatus.PENDING ||
      pago.status === LedgerPaymentStatus.IN_PROCESS ||
      pago.status === LedgerPaymentStatus.AUTHORIZED)
  );
}

const PESO_DEL_ESTADO: Readonly<Record<LedgerPaymentStatus, number>> = {
  [LedgerPaymentStatus.APPROVED]: 0,
  [LedgerPaymentStatus.IN_MEDIATION]: 0,
  [LedgerPaymentStatus.CHARGED_BACK]: 1,
  [LedgerPaymentStatus.REFUNDED]: 2,
  [LedgerPaymentStatus.IN_PROCESS]: 3,
  [LedgerPaymentStatus.AUTHORIZED]: 3,
  [LedgerPaymentStatus.PENDING]: 4,
  [LedgerPaymentStatus.REJECTED]: 5,
  [LedgerPaymentStatus.CANCELLED]: 5,
};

/**
 * El intento de cobro que representa al pedido: el que está acreditado (o con
 * reclamo), si no el contracargo o la devolución, si no el que está en curso, si no
 * el pendiente, y recién al final los rechazados o cancelados. A igual peso, el
 * más nuevo. Así un pago duplicado devuelto no tapa al que sí quedó cobrado.
 */
export function elegirPagoRepresentativo(pagos: Payment[]): Payment | null {
  let elegido: Payment | null = null;
  for (const pago of pagos) {
    if (
      !elegido ||
      PESO_DEL_ESTADO[pago.status] <= PESO_DEL_ESTADO[elegido.status]
    ) {
      elegido = pago;
    }
  }
  return elegido;
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

/** `status_detail` de un contracargo cuyo dinero Mercado Pago le devolvió al comercio. */
const DETALLE_CONTRACARGO_REINTEGRADO = 'reimbursed';

/** `status_detail` de un contracargo cuyo dinero quedó retenido (egreso de la caja). */
const DETALLE_CONTRACARGO_RETENIDO = 'settled';

/**
 * Lo que la pasarela dice que sacó de ese cobro, para la caja. Devuelto: lo informado
 * (o todo si no informa). Contracargo: sólo `settled` («el dinero quedó retenido tras
 * el proceso del contracargo») saca plata, y es el TOTAL del pago (un reintegro parcial
 * previo se descuenta después, al asentar, con lo ya egresado). `in_process` («el pago
 * está en proceso porque el comprador lo desconoce»): el monto está retenido pero el
 * caso no se resolvió, no se retira todavía. `reimbursed`, o un detalle que la doc no
 * lista: nada.
 * https://www.mercadopago.com.ar/developers/en/docs/checkout-api-payments/response-handling/query-results
 * https://www.mercadopago.com.ar/developers/en/docs/checkout-pro-preferences/chargebacks/introduction
 */
function devueltoSegunLaPasarela(
  pago: GatewayPayment,
  detalle: string | null,
): number {
  const informado = pago.refundedAmount ?? 0;
  if (pago.status === 'charged_back') {
    return detalle === DETALLE_CONTRACARGO_RETENIDO
      ? (pago.amount ?? informado)
      : 0;
  }
  if (pago.status === 'refunded') {
    return informado > 0 ? informado : (pago.amount ?? 0);
  }
  return informado;
}

/** ¿El caso del contracargo se resolvió a favor del vendedor (`coverage_applied: true`)? */
function coberturaAplicada(pago: Payment): boolean {
  const caso = pago.metadata?.chargeback as
    | { coverageApplied?: unknown }
    | undefined;
  return caso?.coverageApplied === true;
}

function esNoEncontrado(error: unknown): boolean {
  return errorStatus(error) === 404;
}
