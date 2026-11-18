import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { diaArgentino, sumarDias } from '../../common/utils/dias-argentina';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import {
  diaLegible,
  horaArgentina,
} from '../application/route-sheet-notifier.service';
import {
  calcularReparto,
  type DatosDelReparto,
  type RepartoCalculado,
  type SituacionDelReparto,
  type VentanaMs,
} from '../domain/reparto-del-cliente';
import { instanteDelDia } from '../domain/route-sheet-rules';

/**
 * El bloque `reparto` que ve el asistente por cada pedido del cliente. Sólo
 * lo que el cliente puede saber de SU pedido: nada de otras paradas
 * (direcciones, nombres, pedidos) ni la posición del chofer.
 */
export interface RepartoDelPedido {
  situacion: SituacionDelReparto;
  /** «hoy», «mañana» o «jueves 19/11». */
  diaDelReparto: string | null;
  viajeIniciado: boolean;
  /** Con el viaje en curso: entregas pendientes antes que la suya (0 = es la próxima). */
  entregasAntes: number | null;
  /** «entre las 15:05 y las 15:40, aprox.»: estimación redondeada, nunca una hora puntual. */
  llegadaEstimada: string | null;
  pasoAlFinalDelRecorrido: boolean;
  /** «mañana» o «jueves 19/11». */
  reprogramadoPara: string | null;
}

interface FilaDelPedido {
  orderId: string;
  status: string;
  orderDate: string | null;
  sheetId: string | null;
  sheetStatus: string | null;
  planDate: string | null;
  etaAt: Date | null;
  ws: Date | null;
  we: Date | null;
  failedAttempts: number | null;
  slotStart: string | null;
  slotEnd: string | null;
  dayStart: string | null;
  dayEnd: string | null;
  before: number | string | null;
}

interface FilaDeSalida {
  orderId: string;
  reason: string | null;
  planDate: string | null;
}

/**
 * Los pedidos de ESTE cliente en ESTA empresa con su parada activa en una hoja
 * planificada confirmada o en curso (si la tiene). De las demás paradas de la
 * hoja sólo sale un número: las activas antes que la suya y sin entregar.
 */
const SQL_PEDIDOS = `
  SELECT o."order_id" AS "orderId", o."status"::text AS "status",
         to_char(o."scheduled_date", 'YYYY-MM-DD') AS "orderDate",
         b."batch_id" AS "sheetId", b."status"::text AS "sheetStatus",
         to_char(b."plan_date", 'YYYY-MM-DD') AS "planDate",
         CASE WHEN b."batch_id" IS NULL THEN NULL ELSE s."eta_at" END AS "etaAt",
         CASE WHEN b."batch_id" IS NULL THEN NULL ELSE s."notified_window_start" END AS "ws",
         CASE WHEN b."batch_id" IS NULL THEN NULL ELSE s."notified_window_end" END AS "we",
         CASE WHEN b."batch_id" IS NULL THEN NULL ELSE s."failed_attempts" END AS "failedAttempts",
         ts."startTime"::text AS "slotStart", ts."endTime"::text AS "slotEnd",
         (SELECT min(j."startTime")::text FROM "time_slot" j
           WHERE j."distributor_id" = o."distributor_id" AND j."isActive") AS "dayStart",
         (SELECT max(j."endTime")::text FROM "time_slot" j
           WHERE j."distributor_id" = o."distributor_id" AND j."isActive") AS "dayEnd",
         CASE WHEN b."batch_id" IS NULL THEN NULL ELSE
           (SELECT count(*)::int FROM "route_batch_stop" x
              JOIN "order" xo ON xo."order_id" = x."order_id"
             WHERE x."batch_id" = s."batch_id" AND x."active" AND x."sequence" < s."sequence"
               AND xo."status"::text NOT IN ('delivered', 'cancelled'))
         END AS "before"
    FROM "order" o
    LEFT JOIN "route_batch_stop" s ON s."order_id" = o."order_id" AND s."active"
    LEFT JOIN "route_batch" b ON b."batch_id" = s."batch_id"
          AND b."distributor_id" = o."distributor_id" AND b."kind" = 'planned'
          AND b."status" IN ('confirmed', 'assigned')
    LEFT JOIN "time_slot" ts ON ts."time_slot_id" = o."time_slot_id"
   WHERE o."distributor_id" = $1 AND o."customer_id" = $2 AND o."order_id" = ANY($3::uuid[])`;

/** La última salida de cada pedido de una hoja planificada de la empresa (el más reciente primero). */
const SQL_SALIDAS = `
  SELECT DISTINCT ON (s."order_id") s."order_id" AS "orderId",
         s."removed_reason"::text AS "reason", to_char(b."plan_date", 'YYYY-MM-DD') AS "planDate"
    FROM "route_batch_stop" s
    JOIN "route_batch" b ON b."batch_id" = s."batch_id"
    JOIN "order" o ON o."order_id" = s."order_id"
   WHERE o."distributor_id" = $1 AND o."customer_id" = $2 AND s."order_id" = ANY($3::uuid[])
     AND b."distributor_id" = $1 AND b."kind" = 'planned'
     AND NOT s."active" AND s."removed_at" IS NOT NULL
   ORDER BY s."order_id", s."removed_at" DESC`;

/** «hoy», «mañana» o «jueves 19/11». */
export function diaParaElCliente(fecha: string, hoy: string): string {
  if (fecha === hoy) return 'hoy';
  if (fecha === sumarDias(hoy, 1)) return 'mañana';
  return diaLegible(fecha);
}

/** «entre las 15:05 y las 15:40, aprox.» en hora argentina. */
export function textoDeLaVentana(v: VentanaMs): string {
  return `entre las ${horaArgentina(v.startMs)} y las ${horaArgentina(v.endMs)}, aprox.`;
}

function franjaDe(f: FilaDelPedido): VentanaMs | null {
  const fecha = f.orderDate;
  if (!fecha) return null;
  const inicio = f.slotStart ?? f.dayStart;
  const fin = f.slotStart !== null ? f.slotEnd : f.dayEnd;
  if (!inicio || !fin) return null;
  return {
    startMs: instanteDelDia(fecha, inicio),
    endMs: instanteDelDia(fecha, fin),
  };
}

function datosDe(
  f: FilaDelPedido,
  salida: FilaDeSalida | undefined,
): DatosDelReparto {
  return {
    estadoDelPedido: f.status,
    fechaDelPedido: f.orderDate,
    hoja: f.sheetId
      ? {
          enCurso: f.sheetStatus === 'assigned',
          fecha: f.planDate,
          etaMs: f.etaAt ? new Date(f.etaAt).getTime() : null,
          ventanaAvisada:
            f.ws && f.we
              ? {
                  startMs: new Date(f.ws).getTime(),
                  endMs: new Date(f.we).getTime(),
                }
              : null,
          franja: franjaDe(f),
          intentosFallidos: Number(f.failedAttempts ?? 0),
          entregasAntes: Number(f.before ?? 0),
        }
      : null,
    ultimaSalida: salida
      ? { motivo: salida.reason, fechaDeLaHoja: salida.planDate }
      : null,
  };
}

function aTexto(r: RepartoCalculado, hoy: string): RepartoDelPedido {
  return {
    situacion: r.situacion,
    diaDelReparto: r.diaDelReparto
      ? diaParaElCliente(r.diaDelReparto, hoy)
      : null,
    viajeIniciado: r.viajeIniciado,
    entregasAntes: r.entregasAntes,
    llegadaEstimada: r.ventana ? textoDeLaVentana(r.ventana) : null,
    pasoAlFinalDelRecorrido: r.pasoAlFinalDelRecorrido,
    reprogramadoPara: r.reprogramadoPara
      ? diaParaElCliente(r.reprogramadoPara, hoy)
      : null,
  };
}

/**
 * Cómo viene el reparto de los pedidos de un cliente (hoja de ruta, F34), para
 * el asistente del chat y cualquier respuesta a «¿dónde está mi pedido?». Sólo
 * lee; siempre filtra por la empresa y el cliente (un pedido ajeno no vuelve).
 * La franja es la misma que ve el cliente en la app (la avisada o la de su
 * hora estimada), redondeada; no recalcula nada.
 */
@Injectable()
export class SeguimientoDelPedido {
  constructor(
    private readonly dataSource: DataSource,
    private readonly processConfig: ProcessConfigService,
  ) {}

  /**
   * Por pedido (id completo): su reparto, o `null` si ya se entregó o canceló.
   * Los pedidos que no son del cliente en esa empresa no vienen en el mapa.
   */
  async deLosPedidos(
    distributorId: string,
    customerUserId: string,
    orderIds: readonly string[],
    ahora: Date,
  ): Promise<Map<string, RepartoDelPedido | null>> {
    const resultado = new Map<string, RepartoDelPedido | null>();
    if (orderIds.length === 0) return resultado;
    const params = [distributorId, customerUserId, [...orderIds]];
    const [filas, salidas] = await Promise.all([
      this.dataSource.query<FilaDelPedido[]>(SQL_PEDIDOS, params),
      this.dataSource.query<FilaDeSalida[]>(SQL_SALIDAS, params),
    ]);
    const salidaDe = new Map(salidas.map((s) => [s.orderId, s]));
    const hoy = diaArgentino(ahora);
    let media: number | null = null;
    for (const f of filas) {
      const datos = datosDe(f, salidaDe.get(f.orderId));
      // Los parámetros sólo hacen falta si hay que armar la franja.
      if (datos.hoja && !datos.hoja.ventanaAvisada && media === null) {
        media = (
          await this.processConfig.obtener(
            distributorId,
            ConfigurableProcess.ROUTE_PLANNING,
          )
        ).etaWindowMinutes;
      }
      const r = calcularReparto(datos, {
        hoy,
        mediaVentanaMinutos: media ?? 0,
      });
      resultado.set(f.orderId, r ? aTexto(r, hoy) : null);
    }
    return resultado;
  }
}
