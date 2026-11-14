import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { condicionEsperandoAlAdmin } from '../../order/infrastructure/lote-de-recorrido.sql';

/**
 * Retención de la hoja de ruta frente al despacho individual (M1, §7.4). Un
 * pedido está retenido si:
 *  - es parada activa de una hoja en borrador o confirmada (la lleva el chofer
 *    de la hoja), o
 *  - salió de una hoja en la calle y espera que el admin decida (no se entregó
 *    en el segundo intento, el admin la sacó o quedó pendiente al cerrar), o
 *  - con `route_planning.enabled`, está programado para un día cuya
 *    planificación no se cerró y se creó antes de su cierre (el sistema lo va a
 *    proponer en una hoja), tenga franja o no (sin franja fija la hora la
 *    calcula el planificador).
 *
 * Vive aparte (sin dependencias de módulo) para que `OrderModule` la importe sin
 * ciclo con `RouteBatchModule`.
 */
@Injectable()
export class RoutePlanningHoldService {
  constructor(private readonly dataSource: DataSource) {}

  async isHeldForPlanning(orderIds: readonly string[]): Promise<Set<string>> {
    if (orderIds.length === 0) return new Set();
    const filas: Array<{ orderId: string }> = await this.dataSource.query(
      `SELECT o."order_id" AS "orderId"
         FROM "order" o
        WHERE o."order_id" = ANY($1::uuid[])
          AND (
            ${condicionEsperandoAlAdmin('o."order_id"')}
            OR EXISTS (SELECT 1 FROM "route_batch_stop" s
                      JOIN "route_batch" b ON b."batch_id" = s."batch_id"
                     WHERE s."order_id" = o."order_id" AND s."active"
                       AND b."kind" = 'planned' AND b."status" IN ('draft', 'confirmed'))
            OR (
              o."scheduled_date" IS NOT NULL
              -- Con o sin franja: sin franja fija (reprogramado por la hoja, o
              -- agendado sólo con fecha) el planificador le calcula la hora.
              AND o."delivery_mode"::text = 'standard'
              AND o."scheduled_date" > (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
              AND EXISTS (SELECT 1 FROM "module_config" mc
                           WHERE mc."distributor_id" = o."distributor_id"
                             AND mc."module"::text = 'route_planning'
                             AND COALESCE((mc."params" ->> 'enabled')::numeric, 0) = 1
                             -- creado antes del cierre de su día (D−1 a la hora del parámetro)
                             AND o."createdAt" < ((o."scheduled_date" - 1)::timestamp
                                   + make_interval(
                                       hours => COALESCE((mc."params" ->> 'cutoffHour')::int, 18),
                                       mins => COALESCE((mc."params" ->> 'cutoffMinute')::int, 0)))
                                   AT TIME ZONE 'America/Argentina/Buenos_Aires')
              AND NOT EXISTS (SELECT 1 FROM "route_plan" p
                               WHERE p."distributor_id" = o."distributor_id"
                                 AND p."plan_date" = o."scheduled_date"
                                 AND (p."status" = 'closed' OR o."createdAt" >= p."cutoff_at"))
            )
          )`,
      [orderIds],
    );
    return new Set(filas.map((f) => f.orderId));
  }
}
