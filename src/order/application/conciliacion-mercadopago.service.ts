import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, MoreThanOrEqual, Repository } from 'typeorm';

import { errorMessage, errorStatus } from '../../common/errors/error-message';
import {
  idCortoDePedido,
  pedirAvisoAlAdmin,
} from '../../common/events/aviso-al-admin';
import { PaymentsService } from '../../payments/application/payments.service';
import { RefundsService } from '../../payments/application/refunds.service';
import { OrigenDelEstadoDelPago } from '../../payments/domain/payment.enums';
import { Order, OrderStatus, PaymentMethod } from '../entities/order.entity';
import { ConfirmPaymentUseCase } from './confirm-payment.use-case';
import { PaymentStatus } from '../entities/order.entity';
import { ConRegistro } from '../../process-run/process-run.recorder';
import { registrarErrorAtrapado } from '../../process-run/process-run.context';
import { ProcessName } from '../../process-run/domain/process-catalog';

/** Páginas de pedidos cancelados que mira como máximo cada pasada. */
const PAGINAS_DE_CANCELADOS = 10;

/** Estados de un pago de la pasarela con la plata ya acreditada (un reclamo abierto no la quita). */
const ESTADOS_COBRADOS = ['approved', 'in_mediation'];

/** Estados de un pago de la pasarela que todavía pueden terminar en un cobro. */
const ESTADOS_EN_CURSO = ['pending', 'authorized', 'in_process'];

/**
 * Qué hacer con un pedido de Mercado Pago sin pago confirmado, tras preguntarle a la
 * pasarela:
 *  - `aplicado`: tenía un pago cobrado cuyo aviso no llegó; ya se confirmó el pedido.
 *  - `esperar`: hay un pago en curso o la pasarela no respondió: no hay que cancelar
 *    nada ahora, se vuelve a mirar en la próxima pasada.
 *  - `revisar`: hay un pago cobrado que NO se pudo aplicar al pedido (importe o cuenta
 *    distintos) o no se aplicó: lo decide el administrador, que ya fue avisado. No se
 *    cancela solo: hay plata cobrada.
 *  - `libre`: la pasarela no tiene ningún pago que pueda cobrarse; se puede cancelar.
 */
export type VeredictoDeCobro = 'aplicado' | 'esperar' | 'revisar' | 'libre';

/**
 * Red de seguridad del webhook. Si el aviso de un pago aprobado no llegó (el proceso
 * estaba caído, la red falló, MP agotó sus reintentos), el pedido quedaría pendiente
 * y el vencimiento lo cancelaría con el cliente ya cobrado. Acá se le pregunta a
 * Mercado Pago por los pagos del pedido y se aplican los cobrados, con el mismo
 * caso de uso que el webhook (idempotente: aplicar dos veces el mismo pago no hace
 * nada). Si hubo más de un pago cobrado, se aplican todos: el primero confirma el
 * pedido y los demás se devuelven como cobros duplicados.
 *
 * Dos barridos:
 *  - pedidos pendientes (cada 5 minutos): aplica los cobros cuyo aviso no llegó;
 *  - pedidos cancelados de las últimas horas: un pago que entró después de la
 *    cancelación se devuelve aunque su aviso se haya perdido.
 */
@Injectable()
export class ConciliacionMercadoPagoService {
  private readonly logger = new Logger(ConciliacionMercadoPagoService.name);

  /** Pedidos que cada pasada revisa. */
  static readonly LOTE = 50;

  /** Minutos que se le dan al webhook antes de ir a preguntar. */
  static readonly ESPERA_AL_WEBHOOK_MINUTOS = 3;

  /** Horas de un pedido cancelado que se siguen revisando por si entra un pago tardío. */
  static readonly HORAS_DE_CANCELADOS_POR_DEFECTO = 48;

  /** Pasadas con la pasarela sin responder (o sin credencial válida) tras las cuales se avisa al administrador. */
  static readonly HORAS_ANTES_DE_AVISAR_CONSULTA_FALLIDA = 2;

  /** Cuándo se miró cada pedido por última vez en esta instancia: la próxima pasada empieza por los menos mirados. */
  private readonly ultimaMirada = new Map<string, number>();

  /** Dudas ya logueadas, para no repetir el mismo error cada 5 minutos. */
  private readonly yaLogueado = new Set<string>();

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly payments: PaymentsService,
    private readonly confirmPayment: ConfirmPaymentUseCase,
    private readonly refunds: RefundsService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  async resolverCobro(order: Order): Promise<VeredictoDeCobro> {
    this.ultimaMirada.set(order.orderId, Date.now());
    let pagos: Awaited<ReturnType<PaymentsService['consultarPagosDelPedido']>>;
    try {
      pagos = await this.payments.consultarPagosDelPedido(order.orderId);
    } catch (error) {
      registrarErrorAtrapado(error);
      this.logger.warn(
        `No se pudo consultar a Mercado Pago los pagos del pedido ${order.orderId}; se reintenta en la próxima pasada: ${errorMessage(error)}`,
      );
      this.avisarConsultaFallida(order, error);
      return 'esperar';
    }

    const cobrados = pagos
      .filter((p) => ESTADOS_COBRADOS.includes(p.status))
      .sort(porIdAscendente);
    if (cobrados.length > 0) return this.aplicarCobrados(order, cobrados);

    if (pagos.some((p) => ESTADOS_EN_CURSO.includes(p.status))) {
      this.logger.log(
        `Pedido ${order.orderId}: hay un pago de Mercado Pago todavía en curso; se espera`,
      );
      return 'esperar';
    }
    return 'libre';
  }

  /** Aplica cada pago cobrado, el más viejo primero, y mira si el pedido quedó confirmado. */
  private async aplicarCobrados(
    order: Order,
    cobrados: Array<{ gatewayPaymentId: string; credentialId: string | null }>,
  ): Promise<VeredictoDeCobro> {
    for (const cobrado of cobrados) {
      try {
        await this.confirmPayment.execute({
          type: 'payment',
          dataId: cobrado.gatewayPaymentId,
          origin: OrigenDelEstadoDelPago.CONCILIACION,
          credentialId: cobrado.credentialId ?? undefined,
        });
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `No se pudo aplicar el pago cobrado ${cobrado.gatewayPaymentId} del pedido ${order.orderId}: ${errorMessage(error)}`,
        );
        return 'esperar';
      }
    }

    const actual = await this.orderRepository.findOne({
      where: { orderId: order.orderId },
    });
    const confirmado =
      !!actual &&
      (!!actual.gatewayPaymentId ||
        actual.paymentStatus === PaymentStatus.PAID);
    if (confirmado) {
      this.logger.warn(
        `Pedido ${order.orderId}: el pago cobrado ${cobrados[0].gatewayPaymentId} no había llegado por aviso; se aplicó por conciliación`,
      );
      return 'aplicado';
    }

    // Hay plata cobrada que el pedido no tomó (importe o cuenta que no coinciden): no
    // se cancela ni se da por aplicado; decide el administrador.
    const clave = `revisar:${order.orderId}`;
    if (!this.yaLogueado.has(clave)) {
      this.yaLogueado.add(clave);
      this.logger.error(
        `Pedido ${order.orderId}: Mercado Pago cobró ${cobrados.map((c) => c.gatewayPaymentId).join(', ')} y el pedido no quedó confirmado (importe o cuenta distintos): requiere revisión del administrador`,
      );
    }
    this.avisar(order, {
      kind: 'payment_needs_review',
      title: 'Pago de Mercado Pago que no se pudo aplicar',
      body: `Pedido #${idCortoDePedido(order.orderId)}: Mercado Pago cobró el pago ${cobrados[0].gatewayPaymentId} pero el pedido no se confirmó (el importe o la cuenta no coinciden con lo esperado). Revisalo en Mercado Pago y decidí si lo cancelás para devolver el pago.`,
      dedupeKey: `mp-revisar:${order.orderId}:${cobrados[0].gatewayPaymentId}`,
    });
    return 'revisar';
  }

  /**
   * La pasarela no responde o rechaza la credencial: el pedido «espera», pero no
   * para siempre. Pasadas unas horas se avisa al administrador (una credencial
   * revocada, 401/403, no se arregla sola).
   */
  private avisarConsultaFallida(order: Order, error: unknown): void {
    const horas = (Date.now() - order.createdAt.getTime()) / (60 * 60 * 1000);
    if (
      horas <
      ConciliacionMercadoPagoService.HORAS_ANTES_DE_AVISAR_CONSULTA_FALLIDA
    ) {
      return;
    }
    const estado = errorStatus(error);
    const credencial = estado === 401 || estado === 403;
    this.avisar(order, {
      kind: 'payment_lookup_failed',
      title: credencial
        ? 'Mercado Pago rechazó la credencial'
        : 'No se pudo consultar a Mercado Pago',
      body: credencial
        ? `Pedido #${idCortoDePedido(order.orderId)}: Mercado Pago rechazó las credenciales de la cuenta (${String(estado)}) al buscar el pago. Revisá o cargá de nuevo la cuenta en la configuración de Mercado Pago: mientras tanto el pedido no se puede confirmar ni cancelar solo.`
        : `Pedido #${idCortoDePedido(order.orderId)}: hace más de ${ConciliacionMercadoPagoService.HORAS_ANTES_DE_AVISAR_CONSULTA_FALLIDA} horas que no se puede consultar a Mercado Pago el pago de este pedido. Revisalo en Mercado Pago.`,
      dedupeKey: `mp-consulta:${order.orderId}`,
    });
  }

  private avisar(
    order: Order,
    aviso: { kind: string; title: string; body: string; dedupeKey: string },
  ): void {
    if (!order.distributorId) return;
    pedirAvisoAlAdmin(this.events, this.logger, {
      ...aviso,
      distributorId: order.distributorId,
      link: { entity: 'order', id: order.orderId },
    });
  }

  /** Cada 5 minutos (en el segundo 30, desfasado del resto) revisa los pedidos de Mercado Pago pendientes y aplica los cobros que no se avisaron. */
  @Cron('30 */5 * * * *')
  @ConRegistro(ProcessName.MP_PENDING_RECONCILIATION)
  async conciliarPendientes(): Promise<number> {
    const hasta = new Date(
      Date.now() -
        ConciliacionMercadoPagoService.ESPERA_AL_WEBHOOK_MINUTOS * 60 * 1000,
    );
    const candidatos = await this.orderRepository.find({
      where: {
        // También las reservas: su seña por Mercado Pago se paga con el mismo checkout.
        status: In([OrderStatus.PENDING, OrderStatus.RESERVED]),
        paymentMethod: PaymentMethod.MERCADOPAGO,
        gatewayPaymentId: IsNull(),
        createdAt: LessThan(hasta),
      },
      order: { createdAt: 'ASC' },
      take: ConciliacionMercadoPagoService.LOTE * 4,
    });

    let aplicados = 0;
    for (const pedido of this.losMenosMirados(candidatos)) {
      if ((await this.resolverCobro(pedido)) === 'aplicado') aplicados++;
    }
    if (aplicados > 0) {
      this.logger.warn(
        `Conciliación: ${aplicados} pago(s) aprobado(s) sin aviso aplicados`,
      );
    }
    return aplicados;
  }

  /**
   * Cada 15 minutos revisa los pedidos de Mercado Pago cancelados en las últimas
   * horas (`ORDER_MERCADOPAGO_CANCELLED_SWEEP_HOURS`): si Mercado Pago tiene un pago
   * cobrado que no se devolvió (el cliente pagó después de la cancelación y el aviso
   * se perdió), se lo aplica por el mismo camino del webhook, que lo devuelve. Un
   * pedido con una devolución rechazada espera al administrador: no se reintenta solo.
   */
  @Cron('45 */15 * * * *')
  @ConRegistro(ProcessName.MP_CANCELLED_RECONCILIATION)
  async conciliarCancelados(): Promise<number> {
    const horas = this.config.get<number>(
      'ORDER_MERCADOPAGO_CANCELLED_SWEEP_HOURS',
      ConciliacionMercadoPagoService.HORAS_DE_CANCELADOS_POR_DEFECTO,
    );
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000);
    if (this.ultimaMirada.size > 5000) this.ultimaMirada.clear();

    let devueltos = 0;
    let revisados = 0;
    // Se pagina en vez de mirar sólo los primeros: con muchos cancelados recientes los
    // de más abajo también se revisan, empezando por los que hace más que no se miran.
    for (let pagina = 0; pagina < PAGINAS_DE_CANCELADOS; pagina++) {
      const candidatos = await this.orderRepository.find({
        where: {
          status: OrderStatus.CANCELLED,
          paymentMethod: PaymentMethod.MERCADOPAGO,
          updatedAt: MoreThanOrEqual(desde),
        },
        order: { updatedAt: 'DESC', orderId: 'ASC' },
        take: ConciliacionMercadoPagoService.LOTE * 4,
        skip: pagina * ConciliacionMercadoPagoService.LOTE * 4,
      });
      if (candidatos.length === 0) break;
      for (const pedido of this.losMenosMirados(candidatos)) {
        if (revisados >= ConciliacionMercadoPagoService.LOTE) break;
        revisados++;
        this.ultimaMirada.set(pedido.orderId, Date.now());
        devueltos += await this.conciliarUnCancelado(pedido);
      }
      if (
        revisados >= ConciliacionMercadoPagoService.LOTE ||
        candidatos.length < ConciliacionMercadoPagoService.LOTE * 4
      ) {
        break;
      }
    }
    return devueltos;
  }

  /** Devuelve cuántos pagos aprobados entraron sin aviso y se mandaron a devolver. */
  private async conciliarUnCancelado(pedido: Order): Promise<number> {
    let devueltos = 0;
    try {
      const pagos = await this.payments.consultarPagosDelPedido(pedido.orderId);
      // Un reclamo abierto no se devuelve solo: se avisa al administrador.
      for (const enReclamo of pagos.filter(
        (p) => p.status === 'in_mediation',
      )) {
        this.avisar(pedido, {
          kind: 'payment_needs_review',
          title: 'Pedido cancelado con un pago en reclamo',
          body: `Pedido #${idCortoDePedido(pedido.orderId)}: el pedido está cancelado y el pago ${enReclamo.gatewayPaymentId} tiene un reclamo abierto en Mercado Pago. No se devuelve solo: resolvelo desde Mercado Pago.`,
          dedupeKey: `mp-revisar-cancelado:${pedido.orderId}:${enReclamo.gatewayPaymentId}`,
        });
      }
      const aprobados = pagos
        .filter((p) => p.status === 'approved')
        .sort(porIdAscendente);
      for (const cobrado of aprobados) {
        // Sólo se saltea el pago CUYA devolución rechazó la pasarela (la reintenta el
        // administrador); un pago nuevo del mismo pedido se atiende igual.
        if (
          await this.refunds.tieneDevolucionFallidaDelPago(
            cobrado.gatewayPaymentId,
          )
        ) {
          continue;
        }
        await this.confirmPayment.execute({
          type: 'payment',
          dataId: cobrado.gatewayPaymentId,
          origin: OrigenDelEstadoDelPago.CONCILIACION,
          credentialId: cobrado.credentialId ?? undefined,
        });
        devueltos++;
        this.logger.warn(
          `Pedido cancelado ${pedido.orderId}: el pago ${cobrado.gatewayPaymentId} entró sin aviso; se pidió su devolución`,
        );
      }
    } catch (error) {
      registrarErrorAtrapado(error);
      this.logger.error(
        `No se pudo conciliar el pedido cancelado ${pedido.orderId}: ${errorMessage(error)}`,
      );
    }
    return devueltos;
  }

  /** Los `LOTE` pedidos que hace más que no se miran (los nunca mirados primero), y entre iguales el más viejo. */
  private losMenosMirados(pedidos: Order[]): Order[] {
    return [...pedidos]
      .sort(
        (a, b) =>
          (this.ultimaMirada.get(a.orderId) ?? 0) -
          (this.ultimaMirada.get(b.orderId) ?? 0),
      )
      .slice(0, ConciliacionMercadoPagoService.LOTE);
  }
}

function porIdAscendente(
  a: { gatewayPaymentId: string },
  b: { gatewayPaymentId: string },
): number {
  const x = BigInt(a.gatewayPaymentId.replace(/\D/g, '') || '0');
  const y = BigInt(b.gatewayPaymentId.replace(/\D/g, '') || '0');
  return x < y ? -1 : x > y ? 1 : 0;
}
