import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { DispatchSettingsService } from '../../distributor/dispatch-settings.service';
import { errorMessage } from '../../common/errors/error-message';
import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';
import { registrarErrorAtrapado } from '../../process-run/process-run.context';
import { Order, OrderStatus } from '../entities/order.entity';
import {
  MOTIVO_VENCIMIENTO_SIN_CHOFER,
  vencioSinChofer,
} from '../domain/vencimiento-sin-chofer';
import { sqlPedidoEnLoteVivo } from '../infrastructure/lote-de-recorrido.sql';
import { CancelOrderUseCase } from './cancel-order.use-case';

/**
 * Inicio de la espera en SQL, igual que `inicioDeLaEspera`: lo último entre que
 * se pudo ofrecer y el inicio de su agenda (día agendado a la hora de su franja,
 * o 00:00, en hora argentina). `GREATEST` ignora el NULL de un inmediato.
 */
const SQL_INICIO_DE_LA_ESPERA = `GREATEST(
    COALESCE(o."available_since", o."createdAt"),
    (o."scheduled_date" + COALESCE(ts."startTime", time '00:00')) AT TIME ZONE '${ZONA_ARGENTINA}'
  )`;

/** Cuántos pedidos vence, como máximo, por distribuidora y por tic. */
export const VENCIDOS_POR_TIC = 50;

/**
 * Un pedido pendiente que nadie toma vence solo: pasados los minutos sin chofer
 * de su distribuidora (`noDriverExpiryMinutes`, CU-171), el sistema lo cancela
 * por el camino de siempre (`CancelOrderUseCase`, actor `system`): restituye el
 * stock, pide la devolución si estaba pagado, cierra la oferta abierta y avisa
 * al cliente. Lo corre el tic del despacho.
 */
@Injectable()
export class VencimientoSinChoferService {
  private readonly logger = new Logger(VencimientoSinChoferService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly settings: DispatchSettingsService,
    private readonly cancelaciones: CancelOrderUseCase,
  ) {}

  /** Vence los pedidos de cada distribuidora; un pedido que falla no corta a los demás. */
  async vencer(
    distribuidoras: Iterable<string>,
    ahora: () => Date = () => new Date(),
  ): Promise<number> {
    let vencidos = 0;
    for (const distributorId of distribuidoras) {
      try {
        vencidos += await this.vencerDe(distributorId, ahora);
      } catch (err) {
        registrarErrorAtrapado(err);
        this.logger.error(
          `No se pudieron vencer los pedidos sin chofer de la distribuidora ${distributorId}: ${errorMessage(err)}`,
        );
      }
    }
    return vencidos;
  }

  private async vencerDe(
    distributorId: string,
    ahora: () => Date,
  ): Promise<number> {
    const { noDriverExpiryMinutes: minutos } =
      await this.settings.obtener(distributorId);
    const candidatos = await this.candidatos(distributorId, minutos, ahora());
    let vencidos = 0;
    for (const orderId of candidatos) {
      try {
        const pedido = await this.cancelaciones.execute(
          orderId,
          'system',
          'system',
          MOTIVO_VENCIMIENTO_SIN_CHOFER,
          {
            siSigueCorrespondiendo: (locked, manager) =>
              this.sigueVencido(locked, manager, minutos, ahora()),
          },
        );
        if (pedido.status === OrderStatus.CANCELLED) {
          vencidos += 1;
          this.logger.log(
            `Pedido ${orderId} cancelado: ${minutos} min sin chofer`,
          );
        }
      } catch (err) {
        registrarErrorAtrapado(err);
        this.logger.error(
          `No se pudo vencer el pedido sin chofer ${orderId}: ${errorMessage(err)}`,
        );
      }
    }
    return vencidos;
  }

  /**
   * Sólo los que ya vencieron, del más viejo al más nuevo: el vencimiento se
   * calcula en la consulta, así los agendados para más adelante no ocupan lugar.
   */
  async candidatos(
    distributorId: string,
    minutos: number,
    ahora: Date,
  ): Promise<string[]> {
    const filas: Array<{ orderId: string }> = await this.dataSource.query(
      `SELECT o."order_id" AS "orderId"
         FROM "order" o
         LEFT JOIN "time_slot" ts ON ts."time_slot_id" = o."time_slot_id"
        WHERE o."distributor_id" = $1
          AND o."status" = 'pending'
          AND o."delivery_id" IS NULL
          AND o."delivery_mode" <> 'express'
          AND NOT o."payment_fraud_hold"
          AND (o."paymentMethod" <> 'mercadopago' OR o."paymentStatus" = 'paid' OR o."deposit_paid")
          AND NOT ${sqlPedidoEnLoteVivo('o.order_id')}
          AND ${SQL_INICIO_DE_LA_ESPERA} + make_interval(mins => $2) <= $3
        ORDER BY ${SQL_INICIO_DE_LA_ESPERA} ASC, o."order_id" ASC
        LIMIT ${VENCIDOS_POR_TIC}`,
      [distributorId, minutos, ahora],
    );
    return filas.map((f) => f.orderId);
  }

  /**
   * El predicado completo con la fila bloqueada: si un chofer lo aceptó, se
   * pagó tarde, se liberó, se reagendó o entró a un lote entre la consulta y el
   * lock, ya no vence.
   */
  private async sigueVencido(
    locked: Order,
    manager: EntityManager,
    minutos: number,
    ahora: Date,
  ): Promise<boolean> {
    const franja: Array<{ startTime: string }> = locked.timeSlotId
      ? await manager.query(
          `SELECT "startTime" FROM "time_slot" WHERE "time_slot_id" = $1`,
          [locked.timeSlotId],
        )
      : [];
    const vencio = vencioSinChofer(
      {
        status: locked.status,
        deliveryId: locked.deliveryId,
        deliveryMode: locked.deliveryMode,
        paymentMethod: locked.paymentMethod,
        paymentStatus: locked.paymentStatus,
        depositPaid: locked.depositPaid,
        paymentFraudHold: locked.paymentFraudHold,
        createdAt: locked.createdAt,
        availableSince: locked.availableSince,
        scheduledDate: locked.scheduledDate ?? null,
        inicioDeFranja: franja[0]?.startTime ?? null,
      },
      minutos,
      ahora,
    );
    if (!vencio) return false;
    const enLote: unknown[] = await manager.query(
      `SELECT 1 FROM "order" o WHERE o."order_id" = $1 AND ${sqlPedidoEnLoteVivo('o.order_id')}`,
      [locked.orderId],
    );
    return enLote.length === 0;
  }
}
