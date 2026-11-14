import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import { RouteBatchStop } from '../../order/entities/route-batch-stop.entity';
import { RedisService } from '../../redis/redis.service';
import { RouteStop, computeSchedule } from '../domain/eta';
import {
  RecorridoPartido,
  StopProgress,
  insertarEnCola,
  ordenCompleto,
  reintentosAlFinal,
  partirRecorrido,
  progresoDeParada,
  reordenarCola,
} from '../domain/route-sheet-execution';
import { RouteSheetCalculator } from './route-sheet-calculator.service';
import {
  Deposito,
  PedidoDeHoja,
  RouteSheetDataService,
} from './route-sheet-data.service';
import { RouteSheetWriter } from './route-sheet-writer.service';

/** Una posición del chofer vale para el recálculo si tiene menos de esto. */
export const GPS_VIGENTE_MS = 5 * 60_000;

export interface ParadaEnCurso {
  stop: RouteBatchStop;
  pedido: PedidoDeHoja | null;
  progress: StopProgress;
}

/** Cómo quedó la cola de la hoja en curso tras el recálculo. */
export interface CalculoEnCurso {
  recorrido: RecorridoPartido;
  /** La cola (sin la parada en camino) en el orden final. */
  cola: string[];
  /** Hora estimada por pedido de la parada en camino y de la cola. */
  etas: Array<{
    orderId: string;
    etaMs: number;
    late: boolean;
    slotStartMs: number;
    slotEndMs: number;
  }>;
  /** De dónde se midió: el GPS del chofer, la última entrega o el depósito. */
  origen: 'gps' | 'last_stop' | 'warehouse' | 'none';
}

/**
 * La hoja en curso (F34 E4/E5): qué está hecho, qué está en camino y qué falta;
 * y el recálculo de la cola desde la posición actual, con o sin re-optimizar
 * (§6.5: nunca se mueven las paradas hechas ni la que está en camino). Todo
 * dentro de la transacción (y el cerrojo) de quien llama.
 */
@Injectable()
export class RouteSheetProgress {
  constructor(
    private readonly data: RouteSheetDataService,
    private readonly calc: RouteSheetCalculator,
    private readonly writer: RouteSheetWriter,
    private readonly redis: RedisService,
  ) {}

  /** Las paradas activas en orden, con su pedido y su avance. */
  async paradas(
    manager: EntityManager,
    sheet: RouteBatch,
    bloquear = true,
  ): Promise<ParadaEnCurso[]> {
    const activas = await this.writer.paradasActivas(
      manager,
      sheet.batchId,
      bloquear,
    );
    const pedidos = new Map(
      (
        await this.data.pedidos(
          sheet.distributorId,
          activas.map((s) => s.orderId),
          manager,
        )
      ).map((p) => [p.orderId, p]),
    );
    return activas.map((stop) => {
      const pedido = pedidos.get(stop.orderId) ?? null;
      return {
        stop,
        pedido,
        progress: progresoDeParada(stop, pedido?.status ?? null),
      };
    });
  }

  /**
   * La posición del chofer si es reciente; si no, `null` (se mide desde la
   * última entrega o el depósito). Redis caído no corta nada: sin posición.
   */
  async posicionDelChofer(
    userId: string,
    nowMs: number,
  ): Promise<{ lat: number; lng: number } | null> {
    try {
      const pos = await this.redis.getDriverLastLocation(userId);
      if (!pos?.at) return null;
      if (nowMs - new Date(pos.at).getTime() > GPS_VIGENTE_MS) return null;
      return { lat: pos.lat, lng: pos.lng };
    } catch {
      return null;
    }
  }

  /**
   * Recalcula la cola desde ahora: re-optimiza si `reordenar`, escribe el orden
   * (hechas, en camino, cola) y la hora estimada de lo que falta. Las paradas
   * hechas conservan la hora en que se las estimó.
   */
  async rehacer(
    manager: EntityManager,
    sheet: RouteBatch,
    o: {
      reordenar: boolean;
      nowMs: number;
      posicion: { lat: number; lng: number } | null;
      /** Parada recién agregada: va en la mejor posición de la cola (o en `en`). */
      insertar?: { orderId: string; en?: number };
    },
  ): Promise<CalculoEnCurso> {
    const params = await this.writer.parametros(sheet.distributorId);
    const paradas = await this.paradas(manager, sheet);
    const recorrido = partirRecorrido(
      paradas.map((p) => ({ orderId: p.stop.orderId, progress: p.progress })),
    );
    const porId = new Map(paradas.map((p) => [p.stop.orderId, p]));
    const { origen, punto } = await this.origen(
      sheet,
      recorrido,
      porId,
      o.posicion,
    );
    const enJuego = [
      ...(recorrido.enCamino ? [recorrido.enCamino] : []),
      ...recorrido.pendientes,
    ];
    if (enJuego.length === 0 || !punto) {
      await this.writer.escribirOrden(
        manager,
        sheet.batchId,
        ordenCompleto(recorrido, recorrido.pendientes),
      );
      return { recorrido, cola: recorrido.pendientes, etas: [], origen };
    }
    const pedidos = enJuego
      .map((id) => porId.get(id))
      .filter((p): p is ParadaEnCurso & { pedido: PedidoDeHoja } => !!p?.pedido)
      .map((p) => sinFranjaSiReintenta(p.pedido, p.stop.failedAttempts));
    const escenario = await this.calc.escenario(
      pedidos,
      punto,
      o.nowMs,
      params,
    );
    const conPunto = new Set(escenario.stops.map((s) => s.id));
    const sinPunto = recorrido.pendientes.filter((id) => !conPunto.has(id));
    let cola = recorrido.pendientes.filter((id) => conPunto.has(id));
    const nueva = o.insertar
      ? escenario.stops.find((s) => s.id === o.insertar?.orderId)
      : undefined;
    if (o.insertar && nueva) {
      const porStop = new Map(escenario.stops.map((s) => [s.id, s]));
      const fija = recorrido.enCamino
        ? (porStop.get(recorrido.enCamino) ?? null)
        : null;
      cola = insertarEnCola(
        fija,
        cola
          .filter((id) => id !== nueva.id)
          .map((id) => porStop.get(id) as RouteStop),
        nueva,
        escenario.schedule,
        o.insertar.en,
      );
    } else if (o.reordenar) {
      cola = reordenarCola(
        escenario.stops,
        escenario.schedule,
        recorrido.enCamino,
      );
    }
    // Lo que ya falló una vez va al final, en el orden en que falló.
    const reintentos = new Map(
      paradas
        .filter((p) => p.stop.failedAttempts > 0)
        .map((p) => [p.stop.orderId, p.stop.lastFailedAt?.getTime() ?? 0]),
    );
    cola = reintentosAlFinal([...cola, ...sinPunto], reintentos);
    const stopPorId = new Map(escenario.stops.map((s) => [s.id, s]));
    const enOrden = [
      ...(recorrido.enCamino ? [recorrido.enCamino] : []),
      ...cola,
    ]
      .map((id) => stopPorId.get(id))
      .filter((s): s is RouteStop => !!s);
    const sch = computeSchedule(enOrden, escenario.schedule);
    await this.writer.escribirOrden(
      manager,
      sheet.batchId,
      ordenCompleto(recorrido, cola),
    );
    for (const s of sch.stops) {
      await manager.update(
        RouteBatchStop,
        { batchId: sheet.batchId, orderId: s.id, active: true },
        {
          etaAt: new Date(s.etaMs),
          legDistanceKm: Math.round(s.legKm * 100) / 100,
          legDurationMin: Math.round(s.legMin * 10) / 10,
        },
      );
    }
    return {
      // El recorrido ya reordenado (el que quedó escrito): la próxima parada
      // sale de acá, no del orden anterior al recálculo.
      recorrido: { ...recorrido, pendientes: cola },
      cola,
      etas: sch.stops.map((s) => {
        const stop = stopPorId.get(s.id) as RouteStop;
        return {
          orderId: s.id,
          etaMs: s.etaMs,
          late: s.late,
          slotStartMs: stop.windowStartMs,
          slotEndMs: stop.windowEndMs,
        };
      }),
      origen,
    };
  }

  /** Desde dónde se mide lo que falta: GPS vigente, la última entrega o el depósito. */
  private async origen(
    sheet: RouteBatch,
    r: RecorridoPartido,
    porId: ReadonlyMap<string, ParadaEnCurso>,
    posicion: { lat: number; lng: number } | null,
  ): Promise<{
    origen: CalculoEnCurso['origen'];
    punto: Deposito | null;
  }> {
    if (posicion) {
      return {
        origen: 'gps',
        punto: { warehouseId: null, lat: posicion.lat, lng: posicion.lng },
      };
    }
    const ultima = [...r.hechas]
      .reverse()
      .map((id) => porId.get(id)?.pedido)
      .find((p) => p && p.lat !== null && p.lng !== null);
    if (ultima) {
      return {
        origen: 'last_stop',
        punto: {
          warehouseId: null,
          lat: ultima.lat as number,
          lng: ultima.lng as number,
        },
      };
    }
    const deposito = await this.data.deposito(
      sheet.distributorId,
      sheet.originWarehouseId,
    );
    return deposito
      ? { origen: 'warehouse', punto: deposito }
      : { origen: 'none', punto: null };
  }
}

/**
 * Un reintento (ya falló una vez) no conserva la franja comprada: se lo espera
 * en cualquier momento de la jornada, y su hora sale del recálculo de la cola
 * (rediseño del 15/11). Sin jornada conocida, queda con su franja.
 */
export function sinFranjaSiReintenta(
  p: PedidoDeHoja,
  intentosFallidos: number,
): PedidoDeHoja {
  if (!(intentosFallidos > 0) || p.dayStartMs === null || p.dayEndMs === null) {
    return p;
  }
  return { ...p, slotStartMs: p.dayStartMs, slotEndMs: p.dayEndMs };
}
