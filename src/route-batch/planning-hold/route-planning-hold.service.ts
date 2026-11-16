import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { condicionEsperandoAlAdmin } from '../../order/infrastructure/lote-de-recorrido.sql';
import { retenidoPorLaPlanificacion } from '../domain/planificacion-automatica';

/**
 * Retención de la hoja de ruta frente al despacho individual (M1, §7.4). Un
 * pedido está retenido si:
 *  - es parada activa de una hoja en borrador o confirmada (la lleva el chofer
 *    de la hoja), o
 *  - salió de una hoja en la calle y espera que el admin decida (no se entregó
 *    en el segundo intento, el admin la sacó o quedó pendiente al cerrar), o
 *  - la propuesta automática lo va a tomar (`retenidoPorLaPlanificacion`, el
 *    mismo criterio de distribuidora que `paraProponer`: activa, `enabled` y
 *    `autoPropose` efectivos): programado para un día posterior a hoy cuya
 *    planificación no se cerró y creado antes de su cierre, tenga franja o no.
 *    No es para siempre: el día del reparto o con el día cerrado deja de estar
 *    retenido y vuelve al despacho común, haya hoja posible o no.
 *
 * Vive aparte (sin dependencias de módulo) para que `OrderModule` la importe sin
 * ciclo con `RouteBatchModule`.
 */
@Injectable()
export class RoutePlanningHoldService {
  constructor(private readonly dataSource: DataSource) {}

  async isHeldForPlanning(orderIds: readonly string[]): Promise<Set<string>> {
    if (orderIds.length === 0) return new Set();
    const filas: Array<{
      orderId: string;
      enHoja: boolean;
      scheduledDate: string | null;
      deliveryMode: string;
      createdAt: Date | string;
      distributorStatus: string;
      distributorDeletedAt: Date | string | null;
      params: Record<string, unknown> | null;
      planStatus: string | null;
      planCutoffAt: Date | string | null;
    }> = await this.dataSource.query(
      `SELECT o."order_id" AS "orderId",
              (
                ${condicionEsperandoAlAdmin('o."order_id"')}
                OR EXISTS (SELECT 1 FROM "route_batch_stop" s
                          JOIN "route_batch" b ON b."batch_id" = s."batch_id"
                         WHERE s."order_id" = o."order_id" AND s."active"
                           AND b."kind" = 'planned' AND b."status" IN ('draft', 'confirmed'))
              ) AS "enHoja",
              to_char(o."scheduled_date", 'YYYY-MM-DD') AS "scheduledDate",
              o."delivery_mode"::text AS "deliveryMode",
              o."createdAt" AS "createdAt",
              d."status"::text AS "distributorStatus",
              d."deletedAt" AS "distributorDeletedAt",
              mc."params" AS "params",
              p."status"::text AS "planStatus",
              p."cutoff_at" AS "planCutoffAt"
         FROM "order" o
         JOIN "distributor" d ON d."distributor_id" = o."distributor_id"
         LEFT JOIN "module_config" mc ON mc."distributor_id" = o."distributor_id"
                                     AND mc."module"::text = 'route_planning'
         LEFT JOIN "route_plan" p ON p."distributor_id" = o."distributor_id"
                                 AND p."plan_date" = o."scheduled_date"
        WHERE o."order_id" = ANY($1::uuid[])`,
      [orderIds],
    );
    const hoy = diaArgentino();
    return new Set(
      filas
        .filter(
          (f) =>
            f.enHoja ||
            retenidoPorLaPlanificacion(
              {
                scheduledDate: f.scheduledDate,
                deliveryMode: f.deliveryMode,
                createdAt: new Date(f.createdAt),
                distribuidora: {
                  status: f.distributorStatus,
                  deletedAt: f.distributorDeletedAt,
                  params: f.params,
                },
                plan:
                  f.planStatus === null || f.planCutoffAt === null
                    ? null
                    : {
                        status: f.planStatus,
                        cutoffAt: new Date(f.planCutoffAt),
                      },
              },
              hoy,
            ),
        )
        .map((f) => f.orderId),
    );
  }
}
