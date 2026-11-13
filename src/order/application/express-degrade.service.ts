import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';

import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
} from '../entities/order.entity';
import { marcarOfrecible } from '../domain/vencimiento-sin-chofer';
import { RefundStatus } from '../../payments/domain/payment.enums';
import { RefundsService } from '../../payments/application/refunds.service';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { NotificationPort } from '../domain/ports/notification.port';
import { errorMessage } from '../../common/errors/error-message';

/** Resultado de pasar un pedido express al reparto común. */
export interface PaseAlRepartoComun {
  orderId: string;
  /** Recargo express que dejó de cobrarse. */
  surchargeRemoved: number;
  /** Total del pedido sin el recargo. */
  total: number;
  /** Se pidió la devolución del recargo a la pasarela (el cliente había pagado en línea). */
  refundRequested: boolean;
  /** La pasarela rechazó la devolución: queda pendiente para el reintento del administrador. */
  refundFailed: boolean;
}

/**
 * CU-149 paso 7 y 8: ningún chofer en moto aceptó, así que el pedido pierde la
 * modalidad express. Se descuenta el recargo del total (queda guardado en
 * `express_surcharge_amount` para explicarlo), se avisa al cliente en ese
 * momento y, si ya había pagado en línea, se pide la devolución de esa parte
 * (CU-168, PE-10) fuera de la transacción: un fallo de la pasarela no deshace
 * el pase.
 */
@Injectable()
export class ExpressDegradeService {
  private readonly logger = new Logger(ExpressDegradeService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly refunds: RefundsService,
    private readonly realtime: RealtimeDispatchPort,
    private readonly notifications: NotificationPort,
  ) {}

  /**
   * Con el pedido bloqueado: si sigue siendo un express pendiente y sin chofer,
   * lo pasa al reparto común. `null` si ya no corresponde (lo aceptó alguien, se
   * canceló o ya había pasado: dos llamadas no descuentan el recargo dos veces).
   */
  async pasarAlRepartoComun(
    orderId: string,
  ): Promise<PaseAlRepartoComun | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let pase: PaseAlRepartoComun;
    let hayDevolucion = false;
    let order: Order;
    try {
      const locked = await queryRunner.manager
        .createQueryBuilder(Order, 'ord')
        .setLock('pessimistic_write', undefined, ['ord'])
        .where('ord.orderId = :id', { id: orderId })
        .getOne();
      if (
        !locked ||
        locked.deliveryMode !== OrderDeliveryMode.EXPRESS ||
        locked.status !== OrderStatus.PENDING ||
        locked.deliveryId
      ) {
        await queryRunner.commitTransaction();
        return null;
      }

      const recargo = locked.expressSurchargeAmount;
      locked.deliveryMode = OrderDeliveryMode.STANDARD;
      locked.expressDegradedAt = new Date();
      // Recién ahora se ofrece a los choferes comunes: desde acá corre su espera.
      marcarOfrecible(locked, locked.expressDegradedAt);
      locked.totalAmount = new Decimal(locked.totalAmount)
        .minus(recargo)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toNumber();
      order = await queryRunner.manager.save(locked);
      // Outbox: la solicitud de devolución del recargo se registra en la MISMA
      // transacción; hablar con la pasarela es después y puede reintentarse.
      hayDevolucion = await this.refunds.registrarRecargoExpress(
        queryRunner.manager,
        orderId,
        recargo,
      );
      await queryRunner.commitTransaction();
      pase = {
        orderId,
        surchargeRemoved: recargo,
        total: order.totalAmount,
        refundRequested: false,
        refundFailed: false,
      };
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }

    pase.refundRequested = hayDevolucion;
    if (hayDevolucion) {
      try {
        const devoluciones = await this.refunds.reintegrarRecargoExpress(
          orderId,
          pase.surchargeRemoved,
        );
        pase.refundFailed = devoluciones.some(
          (d) => d.status === RefundStatus.FAILED,
        );
      } catch (error) {
        // La solicitud ya está registrada: la retoma el reintento o el cron.
        pase.refundFailed = true;
        this.logger.error(
          `No se pudo pedir la devolución del recargo express del pedido ${orderId}: ${errorMessage(error)}`,
        );
      }
    }
    this.avisar(order, pase);
    return pase;
  }

  private avisar(order: Order, pase: PaseAlRepartoComun): void {
    const payload = {
      orderId: pase.orderId,
      surchargeRemoved: pase.surchargeRemoved,
      total: pase.total,
      refundRequested: pase.refundRequested,
      refundFailed: pase.refundFailed,
      message:
        'No hay motos disponibles: tu pedido sale por el reparto común, sin el recargo express.',
    };
    try {
      this.realtime.notifyCustomer(
        order.customerId,
        'order:express-degraded',
        payload,
      );
      this.realtime.notifyAdmins(
        'order:express-degraded',
        { ...payload, distributorId: order.distributorId },
        order.distributorId,
      );
      void this.notifications
        .sendOrderNoticePush(order.customerId, order.orderId, {
          title: 'Tu pedido sale por reparto común',
          body: !pase.refundRequested
            ? 'No encontramos una moto disponible. No se te cobra el recargo express.'
            : pase.refundFailed
              ? 'No encontramos una moto disponible. La devolución del recargo express está en trámite.'
              : 'No encontramos una moto disponible. Te devolvemos el recargo express.',
          event: 'EXPRESS_DEGRADED',
        })
        .catch(() => undefined);
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar el pase al reparto común del pedido ${pase.orderId}: ${errorMessage(error)}`,
      );
    }
  }
}
