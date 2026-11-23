import {
  claveDeSalida,
  efectivoDelPedido,
} from '../../order/domain/efectivo-a-cobrar';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { EVENTO_POSICION_DEL_CHOFER } from '../../gateways/drivers.gateway';
import type { PosicionDelChofer } from '../../gateways/drivers.gateway';
import { RedisService } from '../../redis/redis.service';
import { estimatedWindow, notificationFor } from '../domain/eta';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import {
  UltimoRecalculo,
  tocaRecalcular,
} from '../domain/route-sheet-execution';
import {
  CalculoEnCurso,
  RouteSheetProgress,
} from './route-sheet-progress.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import {
  FranjaEstimada,
  RouteSheetNotifier,
} from './route-sheet-notifier.service';
import { ROUTE_PLAN_CODES } from './route-sheet.exceptions';

/** Cuánto se recuerda qué hoja en curso tiene un chofer (evita ir a la base en cada GPS). */
const HOJA_DEL_CHOFER_TTL_S = 60;
const SIN_HOJA = '-';
/** Sin moverse, la hora estimada se recalcula igual cada tanto (el reloj corre). */
export const RECALCULO_POR_RELOJ_MS = 2 * 60_000;

const claveHojaDelChofer = (userId: string) =>
  `route-sheet:eta:driver:${userId}`;
const claveUltimo = (sheetId: string) => `route-sheet:eta:last:${sheetId}`;

interface HojaEnCursoDelChofer {
  sheetId: string;
  distributorId: string;
}

/**
 * Hora estimada por parada de la hoja en curso (F34 E5, §8.2): se recalcula
 * con la posición del chofer (con un mínimo de tiempo o de distancia entre
 * recálculos: `etaRecalcMinSeconds` / `etaRecalcMinMeters`), con el reloj
 * cuando el chofer no se mueve, y en cada cambio de la hoja. Al cliente se le
 * avisa la franja estimada la primera vez y cuando se corre
 * `etaNotifyShiftMinutes` o sale de la franja comprada (como mucho uno cada 10
 * minutos); al panel, cada recálculo y las paradas que van a llegar tarde.
 *
 * Nada de esto corta el seguimiento: si Redis o la base fallan, se registra y
 * la posición sigue llegando al cliente como siempre.
 */
@Injectable()
export class RouteSheetEtaService {
  private readonly logger = new Logger(RouteSheetEtaService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly locks: RouteSheetLocks,
    private readonly progress: RouteSheetProgress,
    private readonly processConfig: ProcessConfigService,
    private readonly redis: RedisService,
    private readonly notifier: RouteSheetNotifier,
  ) {}

  /**
   * Recalcula (y si `reordenar`, re-optimiza) la hoja en curso bajo su cerrojo
   * y avisa. Devuelve `null` si la hoja ya no está en curso o la tiene otra
   * operación (la próxima posición la recalcula).
   */
  async recalcular(
    distributorId: string,
    sheetId: string,
    o: { reordenar: boolean; nowMs?: number },
  ): Promise<CalculoEnCurso | null> {
    const nowMs = o.nowMs ?? Date.now();
    let driverUserId: string | null = null;
    let calculo: CalculoEnCurso | null = null;
    try {
      calculo = await this.locks.conHojas(
        distributorId,
        [{ id: sheetId }],
        async (manager, [sheet]) => {
          if (sheet.status !== RouteBatchStatus.ASSIGNED) return null;
          driverUserId = await this.usuarioDelChofer(sheet.deliveryId);
          const posicion = driverUserId
            ? await this.progress.posicionDelChofer(driverUserId, nowMs)
            : null;
          return this.progress.rehacer(manager, sheet, {
            reordenar: o.reordenar,
            nowMs,
            posicion,
          });
        },
      );
    } catch (error) {
      if (codigoDe(error) === ROUTE_PLAN_CODES.SHEET_BUSY) return null;
      throw error;
    }
    if (!calculo) return null;
    await this.avisar(distributorId, sheetId, calculo, nowMs, driverUserId);
    return calculo;
  }

  /**
   * Lo que se le avisa al cliente y al panel después de un recálculo (fuera de
   * la transacción). Con `postergado` (el pedido que no se pudo entregar en el
   * primer intento y pasó al final de la cola), a ese cliente se le avisa
   * SIEMPRE que se reprogramó para más tarde con su franja estimada nueva (no
   * el aviso de corrimiento), y esa franja queda como la avisada. Devuelve la
   * franja del postergado, o `null` si no tiene hora estimada (sin punto o sin
   * origen).
   */
  async avisar(
    distributorId: string,
    sheetId: string,
    calculo: CalculoEnCurso,
    nowMs: number,
    driverUserId: string | null,
    o: { postergado?: string } = {},
  ): Promise<FranjaEstimada | null> {
    await this.recordar(sheetId, nowMs, driverUserId);
    this.notifier.alPanel(distributorId, 'route-sheet:eta-updated', {
      sheetId,
      source: calculo.origen,
      stops: calculo.etas.map((e) => ({
        orderId: e.orderId,
        etaAt: new Date(e.etaMs).toISOString(),
        late: e.late,
      })),
    });
    if (calculo.etas.length === 0) return null;
    const params = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    let postergado: FranjaEstimada | null = null;
    const filas: Array<{
      orderId: string;
      customerId: string;
      ws: Date | null;
      we: Date | null;
      at: Date | null;
    }> = await this.dataSource.query(
      `SELECT s."order_id" AS "orderId", o."customer_id" AS "customerId",
              s."notified_window_start" AS "ws", s."notified_window_end" AS "we", s."notified_at" AS "at"
         FROM "route_batch_stop" s JOIN "order" o ON o."order_id" = s."order_id"
        WHERE s."batch_id" = $1 AND s."active" AND s."order_id" = ANY($2::uuid[])`,
      [sheetId, calculo.etas.map((e) => e.orderId)],
    );
    const porPedido = new Map(filas.map((f) => [f.orderId, f]));
    for (const e of calculo.etas) {
      const f = porPedido.get(e.orderId);
      if (!f) continue;
      const ventana = estimatedWindow(
        e.etaMs,
        e.slotStartMs,
        e.slotEndMs,
        params.etaWindowMinutes,
      );
      if (e.orderId === o.postergado) {
        postergado = await this.avisarPostergado(
          sheetId,
          e.orderId,
          f.customerId,
          {
            windowStartMs: ventana.startMs,
            windowEndMs: ventana.endMs,
            etaMs: e.etaMs,
          },
          nowMs,
        );
        continue;
      }
      const decision = notificationFor(
        ventana,
        f.ws && f.we && f.at
          ? {
              startMs: f.ws.getTime(),
              endMs: f.we.getTime(),
              notifiedAtMs: f.at.getTime(),
            }
          : null,
        { startMs: e.slotStartMs, endMs: e.slotEndMs },
        nowMs,
        params.etaNotifyShiftMinutes,
      );
      if (!decision.notify) continue;
      // El recálculo suelta el cerrojo antes de avisar. Reclamamos el aviso
      // comparando la última franja que acabamos de leer: si otro recálculo ya
      // la movió, éste perdió la carrera y no duplica el push.
      // Un UPDATE con RETURNING devuelve [filas, cantidad] (TypeORM sobre Postgres).
      const [reclamadas]: [Array<{ orderId: string }>, number] =
        await this.dataSource.query(
          `UPDATE "route_batch_stop"
            SET "notified_window_start" = $6,
                "notified_window_end" = $7,
                "notified_at" = $8
          WHERE "batch_id" = $1 AND "order_id" = $2 AND "active"
            AND "notified_window_start" IS NOT DISTINCT FROM $3
            AND "notified_window_end" IS NOT DISTINCT FROM $4
            AND "notified_at" IS NOT DISTINCT FROM $5
          RETURNING "order_id" AS "orderId"`,
          [
            sheetId,
            e.orderId,
            f.ws,
            f.we,
            f.at,
            new Date(ventana.startMs),
            new Date(ventana.endMs),
            new Date(nowMs),
          ],
        );
      if (reclamadas.length === 0) continue;
      await this.notifier.franjaAlCliente(
        f.customerId,
        e.orderId,
        {
          windowStartMs: ventana.startMs,
          windowEndMs: ventana.endMs,
          etaMs: e.etaMs,
        },
        true,
      );
      if (decision.reason === 'outside_slot') {
        this.notifier.alPanel(distributorId, 'route-sheet:stop-late', {
          sheetId,
          orderId: e.orderId,
          etaAt: new Date(e.etaMs).toISOString(),
          slotEnd: new Date(e.slotEndMs).toISOString(),
        });
      }
    }
    return postergado;
  }

  /**
   * El pedido que no se pudo entregar en el primer intento: su franja nueva
   * queda como la avisada (los avisos siguientes comparan contra ella) y al
   * cliente se le avisa que se reprogramó para más tarde (socket y push).
   */
  private async avisarPostergado(
    sheetId: string,
    orderId: string,
    customerId: string,
    franja: FranjaEstimada,
    nowMs: number,
  ): Promise<FranjaEstimada> {
    await this.dataSource.query(
      `UPDATE "route_batch_stop"
          SET "notified_window_start" = $3, "notified_window_end" = $4, "notified_at" = $5
        WHERE "batch_id" = $1 AND "order_id" = $2 AND "active"`,
      [
        sheetId,
        orderId,
        new Date(franja.windowStartMs),
        new Date(franja.windowEndMs),
        new Date(nowMs),
      ],
    );
    await this.notifier
      .postergadoAlCliente(customerId, orderId, franja)
      .catch((e: unknown) =>
        this.logger.warn(
          `Pedido ${orderId}: no se avisó la reprogramación para más tarde: ${errorMessage(e)}`,
        ),
      );
    return franja;
  }

  /**
   * Al iniciar el viaje: a TODOS los clientes de la hoja se les avisa (push y
   * socket) que su pedido está en camino, con la franja estimada, y esa franja
   * queda como la avisada (los avisos siguientes comparan contra ella).
   * Devuelve a cuántos se les avisó.
   */
  async avisarSalida(
    distributorId: string,
    sheetId: string,
    calculo: CalculoEnCurso,
    nowMs: number,
    driverUserId: string | null,
  ): Promise<number> {
    await this.recordar(sheetId, nowMs, driverUserId);
    this.notifier.alPanel(distributorId, 'route-sheet:eta-updated', {
      sheetId,
      source: calculo.origen,
      stops: calculo.etas.map((e) => ({
        orderId: e.orderId,
        etaAt: new Date(e.etaMs).toISOString(),
        late: e.late,
      })),
    });
    if (calculo.etas.length === 0) return 0;
    const params = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    const clientes: Array<{
      orderId: string;
      customerId: string;
      deliveryId: string | null;
      intentos: number;
      status: string;
      paymentMethod: string;
      paymentStatus: string;
      totalAmount: string;
      depositAmount: string;
      depositPaid: boolean;
    }> = await this.dataSource.query(
      `SELECT o."order_id" AS "orderId", o."customer_id" AS "customerId", o."delivery_id" AS "deliveryId",
              COALESCE((SELECT s."failed_attempts" FROM "route_batch_stop" s
                         WHERE s."order_id" = o."order_id" AND s."batch_id" = $2 AND s."active"
                         LIMIT 1), 0) AS "intentos",
              o."status"::text AS "status",
              o."paymentMethod"::text AS "paymentMethod", o."paymentStatus"::text AS "paymentStatus",
              o."totalAmount"::text AS "totalAmount", COALESCE(o."deposit_amount", 0)::text AS "depositAmount",
              COALESCE(o."deposit_paid", false) AS "depositPaid"
         FROM "order" o WHERE o."order_id" = ANY($1::uuid[])`,
      [calculo.etas.map((e) => e.orderId), sheetId],
    );
    const pedidoDe = new Map(clientes.map((c) => [c.orderId, c]));
    // Un solo push por parada (en camino + efectivo, si lo hay), todos en
    // paralelo: la respuesta del chofer no espera a que salga cada aviso.
    const envios: Array<Promise<void>> = [];
    let avisados = 0;
    for (const e of calculo.etas) {
      const pedido = pedidoDe.get(e.orderId);
      if (!pedido) continue;
      const ventana = estimatedWindow(
        e.etaMs,
        e.slotStartMs,
        e.slotEndMs,
        params.etaWindowMinutes,
      );
      // La salida se avisa siempre (es el primer aviso del viaje) y queda
      // como la franja avisada contra la que comparan los avisos siguientes.
      await this.dataSource.query(
        `UPDATE "route_batch_stop"
            SET "notified_window_start" = $3, "notified_window_end" = $4, "notified_at" = $5
          WHERE "batch_id" = $1 AND "order_id" = $2 AND "active"`,
        [
          sheetId,
          e.orderId,
          new Date(ventana.startMs),
          new Date(ventana.endMs),
          new Date(nowMs),
        ],
      );
      const monto = efectivoDelPedido(pedido);
      envios.push(
        this.notifier.salidaAlCliente(
          pedido.customerId,
          e.orderId,
          {
            windowStartMs: ventana.startMs,
            windowEndMs: ventana.endMs,
            etaMs: e.etaMs,
          },
          monto === null
            ? undefined
            : {
                monto,
                salida: claveDeSalida(pedido.deliveryId, pedido.intentos),
              },
        ),
      );
      avisados += 1;
    }
    const resultados = await Promise.allSettled(envios);
    for (const r of resultados) {
      if (r.status === 'rejected') {
        this.logger.warn(
          `Hoja ${sheetId}: no se pudo avisar la salida a un cliente: ${errorMessage(r.reason)}`,
        );
      }
    }
    return avisados;
  }

  /**
   * Al confirmar la hoja: a los clientes de los pedidos SIN franja fija (los
   * que reprogramó la hoja de ruta) se les avisa la hora estimada de ese día,
   * la franja de ±`etaWindowMinutes` sobre la hora prometida al confirmar.
   * Los que tienen franja ya la conocen. Sólo pedidos vigentes (ni cancelados
   * ni entregados) y una vez por franja: la franja avisada de la parada
   * (`notified_window_*`) es la marca (al iniciar el viaje se pisa con la de la
   * salida). Devuelve a cuántos se les avisó.
   */
  async avisarHorarioSinFranja(
    distributorId: string,
    sheetId: string,
  ): Promise<number> {
    const filas: Array<{
      orderId: string;
      customerId: string;
      fecha: string;
      eta: Date;
    }> = await this.dataSource.query(
      `SELECT s."order_id" AS "orderId", o."customer_id" AS "customerId",
              to_char(b."plan_date", 'YYYY-MM-DD') AS "fecha", s."planned_eta_at" AS "eta"
         FROM "route_batch_stop" s
         JOIN "route_batch" b ON b."batch_id" = s."batch_id"
         JOIN "order" o ON o."order_id" = s."order_id"
        WHERE s."batch_id" = $1 AND b."distributor_id" = $2 AND s."active"
          AND o."time_slot_id" IS NULL AND s."planned_eta_at" IS NOT NULL
          AND o."status"::text NOT IN ('cancelled', 'delivered')`,
      [sheetId, distributorId],
    );
    if (filas.length === 0) return 0;
    const params = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    const medio = params.etaWindowMinutes * 60_000;
    let avisados = 0;
    const ahora = new Date();
    for (const f of filas) {
      const etaMs = new Date(f.eta).getTime();
      const inicio = new Date(etaMs - medio);
      const fin = new Date(etaMs + medio);
      // Dedupe persistente con la franja avisada de la parada (no hay dedupe en
      // los push al cliente): se reclama sólo si esa franja no se le avisó ya, y
      // con el pedido todavía vigente. Una reconfirmación con la misma hora no
      // repite el push; con otra hora, sí.
      // Un UPDATE con RETURNING devuelve [filas, cantidad] (TypeORM sobre Postgres).
      const [reclamadas]: [Array<{ orderId: string }>, number] =
        await this.dataSource.query(
          `UPDATE "route_batch_stop" s
            SET "notified_window_start" = $3, "notified_window_end" = $4, "notified_at" = $5
           FROM "order" o
          WHERE s."batch_id" = $1 AND s."order_id" = $2 AND s."active"
            AND o."order_id" = s."order_id" AND o."status"::text NOT IN ('cancelled', 'delivered')
            AND (s."notified_window_start" IS DISTINCT FROM $3 OR s."notified_window_end" IS DISTINCT FROM $4)
          RETURNING s."order_id" AS "orderId"`,
          [sheetId, f.orderId, inicio, fin, ahora],
        );
      if (reclamadas.length === 0) continue;
      try {
        await this.notifier.horarioAlCliente(f.customerId, f.orderId, f.fecha, {
          windowStartMs: etaMs - medio,
          windowEndMs: etaMs + medio,
          etaMs,
        });
        avisados += 1;
      } catch (error) {
        this.logger.warn(
          `Pedido ${f.orderId}: no se avisó el horario: ${errorMessage(error)}`,
        );
      }
    }
    return avisados;
  }

  /** Posición nueva del chofer (socket): recalcula si toca (§8.2). Nunca lanza. */
  @OnEvent(EVENTO_POSICION_DEL_CHOFER, { async: true })
  async onPosition(pos: PosicionDelChofer): Promise<void> {
    try {
      const hoja = await this.hojaDelChofer(pos.userId);
      if (!hoja) return;
      const params = await this.processConfig.obtener(
        hoja.distributorId,
        ConfigurableProcess.ROUTE_PLANNING,
      );
      const nowMs = Date.now();
      if (
        !tocaRecalcular(
          await this.ultimo(hoja.sheetId),
          pos,
          nowMs,
          params.etaRecalcMinSeconds,
          params.etaRecalcMinMeters,
        )
      ) {
        return;
      }
      // El panel sigue al chofer durante toda la hoja en curso (no sólo con una
      // parada en camino), al mismo ritmo que el recálculo.
      this.notifier.alPanel(hoja.distributorId, 'route-sheet:driver-location', {
        sheetId: hoja.sheetId,
        driverUserId: pos.userId,
        lat: pos.lat,
        lng: pos.lng,
        at: new Date(nowMs).toISOString(),
      });
      await this.recalcular(hoja.distributorId, hoja.sheetId, {
        reordenar: false,
        nowMs,
      });
    } catch (error) {
      this.logger.warn(
        `Hora estimada del chofer ${pos.userId}: no se recalculó: ${errorMessage(error)}`,
      );
    }
  }

  /** Recálculo por reloj de las hojas en curso que hace rato no se recalculan. Devuelve cuántas. */
  async porReloj(nowMs: number): Promise<number> {
    const hojas: Array<{ batchId: string; distributorId: string }> =
      await this.dataSource.query(
        `SELECT "batch_id" AS "batchId", "distributor_id" AS "distributorId" FROM "route_batch"
          WHERE "kind" = 'planned' AND "status" = 'assigned'`,
      );
    let hechas = 0;
    for (const h of hojas) {
      const u = await this.ultimo(h.batchId);
      if (u && nowMs - u.atMs < RECALCULO_POR_RELOJ_MS) continue;
      try {
        if (
          await this.recalcular(h.distributorId, h.batchId, {
            reordenar: false,
            nowMs,
          })
        ) {
          hechas += 1;
        }
      } catch (error) {
        this.logger.warn(
          `Hoja ${h.batchId}: el recálculo por reloj falló: ${errorMessage(error)}`,
        );
      }
    }
    return hechas;
  }

  /**
   * La hoja se recalculó hace menos de `ventanaMs` (la operación que cambió el
   * pedido ya lo hizo): el aviso del cambio no la recalcula de nuevo.
   */
  async recienRecalculada(
    sheetId: string,
    nowMs: number,
    ventanaMs = 5_000,
  ): Promise<boolean> {
    const u = await this.ultimo(sheetId);
    return !!u && nowMs - u.atMs < ventanaMs;
  }

  /** Olvida qué hoja tiene el chofer (al iniciar o cerrar una). */
  async olvidarChofer(userId: string | null): Promise<void> {
    if (!userId) return;
    await this.redis.del(claveHojaDelChofer(userId)).catch(() => undefined);
  }

  private async hojaDelChofer(
    userId: string,
  ): Promise<HojaEnCursoDelChofer | null> {
    const cache = await this.redis
      .get(claveHojaDelChofer(userId))
      .catch(() => null);
    if (cache === SIN_HOJA) return null;
    if (cache) return JSON.parse(cache) as HojaEnCursoDelChofer;
    const [fila]: Array<{ sheetId: string; distributorId: string }> =
      await this.dataSource.query(
        `SELECT b."batch_id" AS "sheetId", b."distributor_id" AS "distributorId"
           FROM "route_batch" b JOIN "delivery" d ON d."delivery_id" = b."delivery_id"
          WHERE d."user_id" = $1 AND b."kind" = 'planned' AND b."status" = 'assigned'
          ORDER BY b."started_at" DESC LIMIT 1`,
        [userId],
      );
    await this.redis
      .setex(
        claveHojaDelChofer(userId),
        HOJA_DEL_CHOFER_TTL_S,
        fila ? JSON.stringify(fila) : SIN_HOJA,
      )
      .catch(() => undefined);
    return fila ?? null;
  }

  private async ultimo(sheetId: string): Promise<UltimoRecalculo | null> {
    const v = await this.redis.get(claveUltimo(sheetId)).catch(() => null);
    return v ? (JSON.parse(v) as UltimoRecalculo) : null;
  }

  /** Anota cuándo y desde dónde se recalculó (para el mínimo entre recálculos). */
  private async recordar(
    sheetId: string,
    nowMs: number,
    driverUserId: string | null,
  ): Promise<void> {
    const pos = driverUserId
      ? await this.progress.posicionDelChofer(driverUserId, nowMs)
      : null;
    const valor: UltimoRecalculo = {
      atMs: nowMs,
      lat: pos?.lat ?? 0,
      lng: pos?.lng ?? 0,
    };
    await this.redis
      .setex(claveUltimo(sheetId), 24 * 3600, JSON.stringify(valor))
      .catch(() => undefined);
  }

  private async usuarioDelChofer(
    deliveryId: string | null,
  ): Promise<string | null> {
    if (!deliveryId) return null;
    const [f]: Array<{ userId: string }> = await this.dataSource.query(
      `SELECT "user_id" AS "userId" FROM "delivery" WHERE "delivery_id" = $1`,
      [deliveryId],
    );
    return f?.userId ?? null;
  }
}

function codigoDe(error: unknown): string | undefined {
  return (error as { getResponse?: () => { code?: string } }).getResponse?.()
    ?.code;
}
