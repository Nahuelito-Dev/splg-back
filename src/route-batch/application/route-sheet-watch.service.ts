import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { EVENTO_PARADA_EN_CURSO } from '../planning-hold/route-sheet-stop-release.subscriber';
import type { ParadaEnCursoCambiada } from '../planning-hold/route-sheet-stop-release.subscriber';
import { RouteSheetAssignmentService } from './route-sheet-assignment.service';
import { RouteSheetCloseService } from './route-sheet-close.service';
import { RouteSheetEtaService } from './route-sheet-eta.service';
import { RouteSheetInProgress } from './route-sheet-in-progress.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';

export interface ResumenDeSeguimiento {
  /** Hojas confirmadas de hoy que se le asignaron a su chofer. */
  assigned: number;
  /** Esperas en la puerta que vencieron (se le sugirió al chofer «No pude entregar»). */
  waitExpired: number;
  reconciled: number;
  completed: number;
  etaRecalculated: number;
  notStartedAlerts: number;
}

/**
 * La hoja en curso sigue a sus pedidos (§7.4, §10):
 *  - en vivo, con el aviso de cada cambio del pedido (`EVENTO_PARADA_EN_CURSO`,
 *    después del commit): una parada que salió reordena la cola y se le avisa
 *    al chofer; una entrega puede cerrar la hoja; el resto recalcula la hora;
 *  - cada minuto (`route_sheet_watch`), como red si un aviso se perdió: saca
 *    las paradas cuyo pedido ya no es del chofer, cierra las hojas terminadas,
 *    recalcula por reloj y avisa las confirmadas de hoy que no arrancaron.
 */
@Injectable()
export class RouteSheetWatchService {
  private readonly logger = new Logger(RouteSheetWatchService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly close: RouteSheetCloseService,
    private readonly eta: RouteSheetEtaService,
    private readonly hoja: RouteSheetInProgress,
    private readonly notifier: RouteSheetNotifier,
    private readonly asignacion: RouteSheetAssignmentService,
  ) {}

  @OnEvent(EVENTO_PARADA_EN_CURSO, { async: true })
  async onParada(c: ParadaEnCursoCambiada): Promise<void> {
    try {
      const [fila]: Array<{ distributorId: string }> =
        await this.dataSource.query(
          `SELECT "distributor_id" AS "distributorId" FROM "route_batch" WHERE "batch_id" = $1`,
          [c.batchId],
        );
      if (!fila) return;
      const d = fila.distributorId;
      if (await this.close.completarSiTermino(d, c.batchId)) return;
      const salio =
        c.cause === 'cancelled' ||
        c.cause === 'released' ||
        c.cause === 'reassigned';
      if (salio) {
        await this.eta.recalcular(d, c.batchId, { reordenar: true });
        await this.avisarAlChofer(d, c.batchId, c.orderId, c.cause);
        this.notifier.alPanel(d, 'route-sheet:updated', {
          sheetId: c.batchId,
          orderId: c.orderId,
          cause: c.cause,
        });
        return;
      }
      this.notifier.alPanel(d, 'route-sheet:stop-progress', {
        sheetId: c.batchId,
        orderId: c.orderId,
        progress: c.cause,
      });
      if (!(await this.eta.recienRecalculada(c.batchId, Date.now()))) {
        await this.eta.recalcular(d, c.batchId, { reordenar: false });
      }
    } catch (error) {
      this.logger.warn(
        `Hoja ${c.batchId}: no se pudo seguir el cambio del pedido ${c.orderId}: ${errorMessage(error)}`,
      );
    }
  }

  /** La pasada de cada minuto. */
  async vigilar(nowMs: number): Promise<ResumenDeSeguimiento> {
    const assigned = await this.asignacion.asignarLasDeHoy();
    const waitExpired = await this.esperasVencidas(nowMs);
    const sacadas = await this.reconciliar();
    for (const s of sacadas) {
      await this.onParada(s);
    }
    let completed = 0;
    for (const h of await this.terminadas()) {
      if (await this.close.completarSiTermino(h.distributorId, h.batchId)) {
        completed += 1;
      }
    }
    const etaRecalculated = await this.eta.porReloj(nowMs);
    const notStartedAlerts = await this.sinIniciar(nowMs);
    return {
      assigned,
      waitExpired,
      reconciled: sacadas.length,
      completed,
      etaRecalculated,
      notStartedAlerts,
    };
  }

  /**
   * Paradas en las que el chofer avisó «Llegué» hace `arrivalWaitMinutes` (10
   * por omisión) y el pedido sigue en camino: se le sugiere marcar «No pude
   * entregar» (socket y push) y el panel se entera. Una vez por llegada
   * (`wait_alerted_at`, marcado en el mismo UPDATE: dos pasadas a la vez no
   * avisan dos veces). El sistema no la marca solo: lo decide el chofer.
   */
  private async esperasVencidas(nowMs: number): Promise<number> {
    // Un UPDATE con RETURNING devuelve [filas, cantidad] (TypeORM sobre Postgres).
    const [filas]: [
      Array<{
        batchId: string;
        orderId: string;
        distributorId: string;
        driverUserId: string | null;
        token: string | null;
        arrivedAt: Date;
        waitMinutes: number;
      }>,
      number,
    ] = await this.dataSource.query(
      `UPDATE "route_batch_stop" s
          SET "wait_alerted_at" = $1::timestamptz
         FROM "route_batch" b
         JOIN "order" o ON TRUE
         LEFT JOIN "delivery" d ON d."delivery_id" = b."delivery_id"
         LEFT JOIN "module_config" mc ON mc."distributor_id" = b."distributor_id"
                                     AND mc."module"::text = 'route_planning'
        WHERE b."batch_id" = s."batch_id" AND o."order_id" = s."order_id" AND s."active"
          AND b."kind" = 'planned' AND b."status" = 'assigned'
          AND o."status"::text = 'on_the_way'
          AND s."arrived_at" IS NOT NULL AND s."wait_alerted_at" IS NULL
          AND s."arrived_at" + make_interval(mins => COALESCE((mc."params" ->> 'arrivalWaitMinutes')::int, 10))
              <= $1::timestamptz
      RETURNING s."batch_id" AS "batchId", s."order_id" AS "orderId", b."distributor_id" AS "distributorId",
                d."user_id" AS "driverUserId", d."notification_token" AS "token", s."arrived_at" AS "arrivedAt",
                COALESCE((mc."params" ->> 'arrivalWaitMinutes')::int, 10) AS "waitMinutes"`,
      [new Date(nowMs).toISOString()],
    );
    for (const f of filas) {
      const payload = {
        sheetId: f.batchId,
        orderId: f.orderId,
        arrivedAt: new Date(f.arrivedAt).toISOString(),
        waitMinutes: f.waitMinutes,
      };
      if (f.driverUserId) {
        this.notifier.alChofer(
          f.driverUserId,
          'route-sheet:wait-expired',
          payload,
        );
      }
      void this.notifier.pushAlChofer(
        f.token,
        f.batchId,
        `Pasaron ${f.waitMinutes} minutos en la puerta. Si nadie atiende, marcá «No pude entregar»: el pedido pasa al final de tu recorrido.`,
        'Venció la espera',
        'ROUTE_SHEET_WAIT_EXPIRED',
      );
      this.notifier.alPanel(
        f.distributorId,
        'route-sheet:wait-expired',
        payload,
      );
    }
    return filas.length;
  }

  /**
   * Paradas activas de hojas en curso cuyo pedido ya no es del chofer de la
   * hoja (cancelado, liberado o de otro chofer): salen con su motivo.
   */
  private async reconciliar(): Promise<ParadaEnCursoCambiada[]> {
    // Un UPDATE con RETURNING devuelve [filas, cantidad] (TypeORM sobre Postgres).
    const [filas]: [
      Array<{
        batchId: string;
        orderId: string;
        cause: 'cancelled' | 'released' | 'reassigned';
      }>,
      number,
    ] = await this.dataSource.query(
      `UPDATE "route_batch_stop" s
          SET "active" = false, "removed_at" = now(),
              "removed_reason" = (CASE
                WHEN o."status"::text = 'cancelled' THEN 'cancelled'
                WHEN o."delivery_id" IS NULL THEN 'needs_reschedule'
                ELSE 'reassigned' END)::"route_batch_stop_removed_reason_enum"
         FROM "route_batch" b, "order" o
        WHERE b."batch_id" = s."batch_id" AND o."order_id" = s."order_id" AND s."active"
          AND b."kind" = 'planned' AND b."status" = 'assigned'
          AND o."status"::text <> 'delivered'
          AND (o."status"::text = 'cancelled' OR o."delivery_id" IS DISTINCT FROM b."delivery_id")
      RETURNING s."batch_id" AS "batchId", s."order_id" AS "orderId",
                (CASE WHEN s."removed_reason"::text = 'cancelled' THEN 'cancelled'
                      WHEN s."removed_reason"::text = 'needs_reschedule' THEN 'released'
                      ELSE 'reassigned' END) AS "cause"`,
    );
    return filas;
  }

  private terminadas(): Promise<
    Array<{ batchId: string; distributorId: string }>
  > {
    return this.dataSource.query(
      `SELECT b."batch_id" AS "batchId", b."distributor_id" AS "distributorId" FROM "route_batch" b
        WHERE b."kind" = 'planned' AND b."status" = 'assigned'
          AND NOT EXISTS (SELECT 1 FROM "route_batch_stop" s
                            JOIN "order" o ON o."order_id" = s."order_id"
                           WHERE s."batch_id" = b."batch_id" AND s."active"
                             AND o."status"::text NOT IN ('delivered', 'cancelled'))`,
    );
  }

  /** Confirmadas de hoy que no arrancaron pasado `notStartedAlertMinutes` desde la salida prevista. */
  private async sinIniciar(nowMs: number): Promise<number> {
    const filas: Array<{
      batchId: string;
      distributorId: string;
      number: number | null;
      driverName: string | null;
    }> = await this.dataSource.query(
      `SELECT b."batch_id" AS "batchId", b."distributor_id" AS "distributorId", b."number",
              u."full_name" AS "driverName"
         FROM "route_batch" b
         LEFT JOIN "delivery" d ON d."delivery_id" = b."delivery_id"
         LEFT JOIN "user" u ON u."user_id" = d."user_id"
         LEFT JOIN "module_config" mc ON mc."distributor_id" = b."distributor_id"
                                     AND mc."module"::text = 'route_planning'
        WHERE b."kind" = 'planned' AND b."status" = 'confirmed'
          AND b."plan_date" = ($1::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
          AND b."planned_start_at" IS NOT NULL
          AND COALESCE((mc."params" ->> 'notStartedAlertMinutes')::int, 30) > 0
          AND b."planned_start_at"
              + make_interval(mins => COALESCE((mc."params" ->> 'notStartedAlertMinutes')::int, 30))
              < $1::timestamptz`,
      [new Date(nowMs).toISOString()],
    );
    for (const f of filas) {
      this.notifier.aLaBandeja(f.distributorId, {
        kind: 'route_sheet_not_started',
        title: 'Hoja de ruta sin iniciar',
        body: `La hoja${f.number ? ` N° ${f.number}` : ''} de ${f.driverName ?? 'un chofer'} ya debería haber salido y todavía no se inició.`,
        dedupeKey: `route-sheet-not-started:${f.batchId}`,
      });
    }
    return filas.length;
  }

  private async avisarAlChofer(
    distributorId: string,
    sheetId: string,
    orderId: string,
    cause: string,
  ): Promise<void> {
    const [fila]: Array<{ deliveryId: string | null }> =
      await this.dataSource.query(
        `SELECT "delivery_id" AS "deliveryId" FROM "route_batch" WHERE "batch_id" = $1 AND "distributor_id" = $2`,
        [sheetId, distributorId],
      );
    if (!fila?.deliveryId) return;
    const chofer = await this.hoja.choferDe({ deliveryId: fila.deliveryId });
    if (chofer) {
      this.hoja.avisarCambio(chofer, sheetId, 'stop_removed', {
        orderId,
        cause,
      });
    }
  }
}
