import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  DataSource,
  FindOptionsOrder,
  FindOptionsWhere,
  IsNull,
  LessThan,
  LessThanOrEqual,
  Repository,
} from 'typeorm';

import { Order, OrderStatus, PaymentMethod } from '../entities/order.entity';
import { transitionOrder } from '../domain/order-status.machine';
import { marcarOfrecible } from '../domain/vencimiento-sin-chofer';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { saldoTrasLaSena } from '../domain/deposit-cap';
import { errorMessage } from '../../common/errors/error-message';
import { ConciliacionMercadoPagoService } from './conciliacion-mercadopago.service';
import { PaymentsService } from '../../payments/application/payments.service';
import { CashDocumentPaymentService } from '../../cash/application/cash-document-payment.service';
import {
  ResultadoDelAsiento,
  SalesCashService,
} from '../../cash/application/sales-cash.service';
import { CashMethod } from '../../cash/domain/cash.enums';
import { ScheduledTasksSettingsService } from '../../distributor/scheduled-tasks-settings.service';
import type { TareaConIntervalo } from '../../distributor/scheduled-tasks-settings';
import { ConRegistro } from '../../process-run/process-run.recorder';
import { registrarErrorAtrapado } from '../../process-run/process-run.context';
import { ProcessName } from '../../process-run/domain/process-catalog';

/**
 * Procesos AUTOMÁTICOS de las pre-reservas (Módulo Inteligente / DSS del scope:
 * el sistema opera sin intervención humana):
 *
 *  - `activateDueReservations` (cron): el día agendado, las reservas con seña
 *    paga pasan RESERVED → PENDING y se despachan solas.
 *  - `expireUnpaidReservations` (cron): las reservas cuya seña no se pagó dentro
 *    del plazo se cancelan y LIBERAN el stock reservado.
 *  - `expireUnpaidMercadoPagoOrders` (cron): pedidos NORMALES (no reserva) con
 *    `paymentMethod=mercadopago` cuyo checkout el cliente nunca pagó quedan
 *    colgados en PENDING con stock reservado para siempre (ver
 *    CreateOrderUseCase: la reserva de stock es previa al pago). Este cron los
 *    cancela pasado un TTL corto y libera el stock.
 *
 * `confirmDeposit` es la única acción humana: el admin confirma la seña cobrada
 * en efectivo (la seña por MP la confirma el webhook automáticamente).
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  /** Pedidos que cada ciclo procesa por distribuidora. */
  private static readonly LOTE_POR_DISTRIBUIDORA = 50;

  /** Cuándo se miró cada pedido por última vez: el lote siguiente arranca por los menos mirados (si no, 50 «en espera» tapan al resto). */
  private readonly ultimaMirada = new Map<string, number>();

  /** Horas que una reserva puede esperar el pago de la seña antes de expirar. */
  private readonly depositTtlHours: number;

  /**
   * Minutos que un pedido NORMAL (no reserva) con `paymentMethod=mercadopago`
   * puede esperar el pago del checkout antes de expirar. Corto a propósito
   * (el checkout de MP no dura horas) para no tener stock reservado colgado.
   */
  private readonly mpPendingTtlMinutes: number;

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly orders: OrderRepositoryPort,
    private readonly stock: GasCylinderService,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
    private readonly frecuencias: ScheduledTasksSettingsService,
    config: ConfigService,
    private readonly payments: PaymentsService,
    private readonly ventasEnCaja: SalesCashService,
    private readonly pagoEnCaja: CashDocumentPaymentService,
    private readonly conciliacion: ConciliacionMercadoPagoService,
  ) {
    // Validadas y con su valor por defecto en joi.validation.ts.
    this.depositTtlHours = config.getOrThrow<number>(
      'RESERVATION_DEPOSIT_TTL_HOURS',
    );
    this.mpPendingTtlMinutes = config.getOrThrow<number>(
      'ORDER_MERCADOPAGO_PENDING_TTL_MINUTES',
    );
  }

  /**
   * Corre una tarea por distribuidora (CU-173). Al empezar decide, de una sola
   * pasada, a cuáles les toca el ciclo (poniendo sus marcas); después consulta
   * cada una con su propio límite y orden, así ninguna tapa a otra. Si falla
   * antes de procesar una distribuidora, le devuelve la marca para que no
   * pierda un intervalo entero.
   */
  private async porDistribuidora(
    tarea: TareaConIntervalo,
    where: FindOptionsWhere<Order>,
    opciones: {
      order: FindOptionsOrder<Order>;
      relations?: string[];
    },
    procesar: (pedidos: Order[]) => Promise<void>,
  ): Promise<void> {
    const filas = await this.orderRepository.find({
      where,
      select: { orderId: true, distributorId: true },
    });
    if (filas.length === 0) return;

    const corren = await this.frecuencias.distribuidorasQueCorren(tarea, [
      ...new Set(filas.map((o) => o.distributorId)),
    ]);
    for (const distributorId of corren) {
      try {
        const candidatos = await this.orderRepository.find({
          where: { ...where, distributorId },
          order: opciones.order,
          relations: opciones.relations,
          take: ReservationService.LOTE_POR_DISTRIBUIDORA * 4,
        });
        await procesar(this.losMenosMirados(candidatos));
      } catch (error) {
        await this.frecuencias
          .liberarMarca(tarea, distributorId)
          .catch(() => undefined);
        this.logger.error(
          `Falló ${tarea} para la distribuidora ${distributorId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private losMenosMirados(pedidos: Order[]): Order[] {
    if (this.ultimaMirada.size > 5000) this.ultimaMirada.clear();
    const lote = [...pedidos]
      .sort(
        (a, b) =>
          (this.ultimaMirada.get(a.orderId) ?? 0) -
          (this.ultimaMirada.get(b.orderId) ?? 0),
      )
      .slice(0, ReservationService.LOTE_POR_DISTRIBUIDORA);
    const ahora = Date.now();
    for (const pedido of lote) this.ultimaMirada.set(pedido.orderId, ahora);
    return lote;
  }

  /**
   * Lista las reservas (pedidos RESERVED) de la distribuidora para el panel,
   * con el cliente, la fecha agendada y el estado de la seña. Ordenadas por
   * fecha agendada ascendente (las más próximas primero).
   */
  async findReservations(distributorId?: string | null) {
    const orders = await this.orderRepository.find({
      where: {
        status: OrderStatus.RESERVED,
        ...(distributorId ? { distributorId } : {}),
      },
      // Historial: el chofer, el cliente o la dirección dados de baja siguen
      // apareciendo en lo que ya pasó (H-74).
      withDeleted: true,
      relations: ['customer', 'items', 'items.gasCylinder', 'timeSlot'],
      order: { scheduledDate: 'ASC', createdAt: 'DESC' },
    });

    // La seña por MercadoPago se paga con un enlace: se vuelve a ofrecer acá
    // mientras la seña esté pendiente.
    const enlaces = await this.payments.findPendingCheckoutUrls(
      orders
        .filter(
          (o) =>
            !o.depositPaid && o.paymentMethod === PaymentMethod.MERCADOPAGO,
        )
        .map((o) => o.orderId),
    );
    return orders.map((order) => {
      const depositAmount = Number(order.depositAmount ?? 0);
      const total = Number(order.totalAmount);
      return {
        id: order.orderId,
        customerName: order.customer?.fullName ?? null,
        customerPhone: order.customer?.phoneNumber ?? null,
        scheduledDate: order.scheduledDate ?? null,
        paymentMethod: order.paymentMethod,
        total,
        depositAmount,
        depositPaid: !!order.depositPaid,
        remainingBalance: total - (order.depositPaid ? depositAmount : 0),
        balanceDue: saldoTrasLaSena(total, depositAmount).toNumber(),
        paymentUrl: enlaces.get(order.orderId) ?? null,
        timeSlot: order.timeSlot
          ? {
              name: order.timeSlot.name,
              startTime: order.timeSlot.startTime.slice(0, 5),
              endTime: order.timeSlot.endTime.slice(0, 5),
            }
          : null,
        createdAt: order.createdAt,
        items: (order.items ?? []).map((item) => ({
          quantity: item.quantity,
          type: item.gasCylinder?.type ?? null,
        })),
      };
    });
  }

  /**
   * Admin confirma la seña recibida en efectivo o por transferencia. Habilita la
   * activación automática. La seña entra a una caja en la misma transacción:
   * por transferencia, a la caja de transferencias configurada (sin caja, queda
   * sin asentar y se avisa); en efectivo, a la caja de efectivo que elige
   * (`cashBoxId`, obligatoria si la distribuidora tiene alguna activa). Repetir la
   * confirmación no asienta otra vez.
   */
  async confirmDeposit(
    orderId: string,
    distributorId?: string | null,
    adminUserId?: string | null,
    cashBoxId?: string | null,
  ): Promise<Order> {
    let asiento: ResultadoDelAsiento | undefined;
    const order = await this.orderRepository.manager.transaction(
      async (manager) => {
        const order = await manager.findOne(Order, {
          where: {
            orderId,
            ...(distributorId ? { distributorId } : {}),
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!order) throw new NotFoundException('Reserva no encontrada');
        if (order.status !== OrderStatus.RESERVED) {
          throw new BadRequestException(
            'El pedido no es una reserva pendiente',
          );
        }
        // CU-072/CU-074: la seña por MercadoPago la marca cobrada el aviso de la
        // pasarela (webhook); a mano sólo se confirma la que se recibe en efectivo
        // o por transferencia.
        if (order.paymentMethod === PaymentMethod.MERCADOPAGO) {
          throw new BadRequestException(
            'La seña por MercadoPago se confirma sola cuando la pasarela avisa el pago: no se confirma a mano',
          );
        }
        if (order.depositPaid) return order;
        const efectivo = order.paymentMethod === PaymentMethod.CASH;
        const cajaDeEfectivo = efectivo
          ? await this.pagoEnCaja.cajaDelPago(
              manager,
              order.distributorId,
              cashBoxId,
            )
          : null;
        order.depositPaid = true;
        order.depositPaidAt = new Date();
        const guardada = await manager.save(order);
        const sena = Number(order.depositAmount);
        if (adminUserId && sena > 0) {
          if (!efectivo) {
            asiento = await this.ventasEnCaja.asentarSena(manager, {
              distributorId: order.distributorId,
              orderId: order.orderId,
              amount: sena,
              metodo: CashMethod.TRANSFER,
              userId: adminUserId,
            });
          } else if (cajaDeEfectivo) {
            const resultado = await this.ventasEnCaja.asentarSena(manager, {
              distributorId: order.distributorId,
              orderId: order.orderId,
              amount: sena,
              metodo: CashMethod.CASH,
              cashBoxId: cajaDeEfectivo,
              userId: adminUserId,
            });
            // El administrador eligió esa caja: si la rechaza, se lo decimos y no se confirma.
            if (resultado === 'fallo') {
              throw new ConflictException(
                'La caja rechazó el ingreso de la seña: revisá que esté activa y con la sesión abierta',
              );
            }
          }
        }
        return guardada;
      },
    );
    if (asiento) {
      this.ventasEnCaja.avisarSinAsentar(order.distributorId, asiento, orderId);
    }
    return order;
  }

  /**
   * CRON: activa las reservas cuyo día llegó y tienen la seña paga.
   * RESERVED → PENDING + despacho automático. Sin intervención humana.
   */
  @Cron('0 */5 * * * *') // cada 5 minutos
  @ConRegistro(ProcessName.RESERVATIONS_ACTIVATE)
  async activateDueReservations(): Promise<void> {
    const today = diaArgentino();
    await this.porDistribuidora(
      'reservationActivationSeconds',
      {
        status: OrderStatus.RESERVED,
        depositPaid: true,
        // Una reserva retenida por una alerta de fraude no se activa.
        paymentFraudHold: false,
        scheduledDate: LessThanOrEqual(today),
      },
      { order: { scheduledDate: 'ASC', createdAt: 'ASC' } },
      (due) => this.activarReservas(due),
    );
  }

  private async activarReservas(due: Order[]): Promise<void> {
    if (due.length === 0) return;

    this.logger.log(`Activando ${due.length} reserva(s) con día cumplido`);
    for (const order of due) {
      try {
        transitionOrder(order, OrderStatus.PENDING);
        marcarOfrecible(order);
        await this.orderRepository.save(order);
        // Despacho con el pedido completo (coords + items) para armar la oferta.
        const full = await this.orders.findByIdFull(order.orderId);
        if (full) {
          await this.dispatchOrchestrator
            .offerToNextDriver(full)
            .catch(() => undefined);
        }
        this.logger.log(`Reserva ${order.orderId} activada → despachando`);
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `No se pudo activar la reserva ${order.orderId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * CRON: expira las reservas cuya seña no se pagó dentro del plazo.
   * RESERVED (deposit_paid=false, viejas) → CANCELLED + restituye stock.
   */
  @Cron('0 0 * * * *') // cada hora
  @ConRegistro(ProcessName.RESERVATIONS_EXPIRE_UNPAID)
  async expireUnpaidReservations(): Promise<void> {
    const cutoff = new Date(Date.now() - this.depositTtlHours * 3600 * 1000);
    await this.porDistribuidora(
      'unpaidReservationExpirySeconds',
      {
        status: OrderStatus.RESERVED,
        depositPaid: false,
        createdAt: LessThan(cutoff),
      },
      { order: { createdAt: 'ASC' }, relations: ['items'] },
      (stale) => this.expirarReservasSinSena(stale),
    );
  }

  private async expirarReservasSinSena(stale: Order[]): Promise<void> {
    if (stale.length === 0) return;

    this.logger.log(`Expirando ${stale.length} reserva(s) con seña impaga`);
    for (const order of stale) {
      // Una seña por Mercado Pago pudo pagarse sin que el aviso llegara: antes de
      // cancelar se le pregunta a la pasarela, igual que con un pedido común. Si hay
      // un pago cobrado se aplica (queda con la seña paga), si está en curso o la
      // pasarela no responde se espera.
      if (order.paymentMethod === PaymentMethod.MERCADOPAGO) {
        const cobro = await this.conciliacion.resolverCobro(order);
        if (cobro !== 'libre') {
          this.logger.log(
            `Reserva ${order.orderId} no se cancela por falta de seña (cobro: ${cobro})`,
          );
          continue;
        }
      }
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        // Re-chequeo con lock pesimista: si el webhook dio por paga la seña un
        // instante antes, no se toca la reserva.
        const locked = await queryRunner.manager
          .createQueryBuilder(Order, 'order')
          .setLock('pessimistic_write')
          .where('order.orderId = :id', { id: order.orderId })
          .getOne();
        if (
          !locked ||
          locked.status !== OrderStatus.RESERVED ||
          locked.depositPaid ||
          locked.gatewayPaymentId
        ) {
          await queryRunner.commitTransaction();
          continue;
        }
        transitionOrder(locked, OrderStatus.CANCELLED);
        locked.cancellationReason =
          'Reserva vencida: la seña no se pagó a tiempo';
        await queryRunner.manager.save(locked);
        await this.stock.restituirStock(
          queryRunner.manager,
          (order.items ?? []).map((it) => ({
            gasCylinderId: it.gasCylinderId,
            quantity: it.quantity,
          })),
        );
        await queryRunner.commitTransaction();
        this.logger.log(
          `Reserva ${order.orderId} expirada → cancelada + stock liberado`,
        );
        if (order.paymentMethod === PaymentMethod.MERCADOPAGO) {
          void this.payments.cerrarCheckoutsDelPedido(order.orderId);
        }
      } catch (error) {
        await queryRunner.rollbackTransaction();
        this.logger.error(
          `No se pudo expirar la reserva ${order.orderId}: ${errorMessage(error)}`,
        );
      } finally {
        await queryRunner.release();
      }
    }
  }

  /**
   * CRON: expira pedidos NORMALES (no reserva) con `paymentMethod=mercadopago`
   * cuyo checkout de MP nunca se pagó. PENDING + `gatewayPaymentId` null
   * (nunca confirmado por el webhook) + más viejo que el TTL → CANCELLED +
   * restituye stock. Sin este cron, el stock reservado por `CreateOrderUseCase`
   * al crear el pedido (ANTES de que el cliente pague, para evitar oversell)
   * queda bloqueado para siempre si el cliente abandona el checkout.
   *
   * Idempotencia / carrera pago-vs-expiración: dentro de la transacción,
   * re-lee el pedido con lock pesimista y solo lo cancela si SIGUE PENDING y
   * sin `gatewayPaymentId` — si el webhook confirmó el pago un instante antes,
   * no lo toca. Si el pago llegara a confirmarse recién DESPUÉS de expirado,
   * `ConfirmPaymentUseCase.handleApproved` ve el pedido en estado terminal
   * (CANCELLED) y no lo reactiva ni despacha (no-op idempotente, ver ese
   * use-case).
   */
  @Cron('0 */30 * * * *') // cada 30 minutos
  @ConRegistro(ProcessName.ORDERS_EXPIRE_MP_UNPAID)
  async expireUnpaidMercadoPagoOrders(): Promise<void> {
    const cutoff = new Date(Date.now() - this.mpPendingTtlMinutes * 60 * 1000);
    await this.porDistribuidora(
      'unpaidMercadoPagoExpirySeconds',
      {
        status: OrderStatus.PENDING,
        paymentMethod: PaymentMethod.MERCADOPAGO,
        gatewayPaymentId: IsNull(),
        createdAt: LessThan(cutoff),
      },
      { order: { createdAt: 'ASC' }, relations: ['items'] },
      (stale) => this.expirarPedidosMercadoPago(stale),
    );
  }

  private async expirarPedidosMercadoPago(stale: Order[]): Promise<void> {
    if (stale.length === 0) return;

    this.logger.log(
      `Expirando ${stale.length} pedido(s) MercadoPago sin pagar (TTL ${this.mpPendingTtlMinutes}min)`,
    );
    for (const order of stale) {
      // Antes de cancelar se le pregunta a Mercado Pago: si el cliente pagó y el
      // aviso no llegó, el pedido se confirma en vez de cancelarse; si la pasarela
      // no responde, no se cancela (se reintenta en la próxima pasada).
      const cobro = await this.conciliacion.resolverCobro(order);
      if (cobro !== 'libre') {
        this.logger.log(
          `Pedido ${order.orderId} no se cancela por vencimiento (cobro: ${cobro})`,
        );
        continue;
      }
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        // Re-chequeo con lock pesimista: si el webhook confirmó el pago justo
        // antes de este commit, `gatewayPaymentId` ya no es null y no tocamos
        // el pedido (evita la carrera pago-vs-expiración).
        const locked = await queryRunner.manager
          .createQueryBuilder(Order, 'order')
          .setLock('pessimistic_write')
          .where('order.orderId = :id', { id: order.orderId })
          .getOne();

        if (
          !locked ||
          locked.status !== OrderStatus.PENDING ||
          locked.gatewayPaymentId
        ) {
          await queryRunner.commitTransaction();
          continue;
        }

        transitionOrder(locked, OrderStatus.CANCELLED);
        locked.cancellationReason =
          'Pago con MercadoPago no completado dentro del plazo';
        await queryRunner.manager.save(locked);
        await this.stock.restituirStock(
          queryRunner.manager,
          (order.items ?? []).map((it) => ({
            gasCylinderId: it.gasCylinderId,
            quantity: it.quantity,
          })),
        );
        await queryRunner.commitTransaction();
        this.logger.log(
          `Pedido ${order.orderId} expirado (MercadoPago sin pagar) → cancelado + stock liberado`,
        );
        // El enlace de pago ya venció solo, pero se cierra igual: el vencimiento del
        // pedido puede adelantarse al del checkout hasta lo que tarda esta pasada.
        void this.payments.cerrarCheckoutsDelPedido(order.orderId);
      } catch (error) {
        await queryRunner.rollbackTransaction();
        this.logger.error(
          `No se pudo expirar el pedido ${order.orderId}: ${errorMessage(error)}`,
        );
      } finally {
        await queryRunner.release();
      }
    }
  }
}
