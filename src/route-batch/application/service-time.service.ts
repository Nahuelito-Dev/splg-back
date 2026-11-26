import {
  diaArgentino,
  inicioDelDiaArgentino,
  sumarDias,
} from '../../common/utils/dias-argentina';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { RouteServiceTimeStat } from '../../order/entities/route-service-time-stat.entity';
import {
  MUESTRAS_MINIMAS,
  VENTANA_DIAS,
  calcularTiempoDeAtencion,
  minutosDeServicio,
} from '../domain/tiempo-de-atencion';

export type ModoDeServicio = 'fixed' | 'learned';

/** `serviceMinutesMode` se guarda como número (0 fijo, 1 aprendido), como el resto de los parámetros. */
export const modoDeServicio = (valor: number | undefined): ModoDeServicio =>
  valor === 1 ? 'learned' : 'fixed';

export const MODO_COMO_NUMERO: Record<ModoDeServicio, number> = {
  fixed: 0,
  learned: 1,
};

export interface EstadoDelTiempoDeAtencion {
  mode: ModoDeServicio;
  /** El «Minutos por parada» que configuró el administrador. */
  fixedMinutes: number;
  /** La mediana aprendida, entera de 1 a 60; `null` si no hay muestras suficientes. */
  suggestedMinutes: number | null;
  p90Minutes: number | null;
  /** Con lo que se planifica hoy: el fijo, o el sugerido si el modo es `learned` y hay muestra. */
  effectiveMinutes: number;
  samples: number;
  minSamples: number;
  windowDays: number;
  computedAt: Date | null;
}

/**
 * Tiempo de atención aprendido (M4): calcula de noche la mediana de «Llegué» a
 * la entrega por distribuidora y dice con cuántos minutos se planifica.
 */
@Injectable()
export class ServiceTimeService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RouteServiceTimeStat)
    private readonly stats: Repository<RouteServiceTimeStat>,
    private readonly processConfig: ProcessConfigService,
  ) {}

  /**
   * Recalcula y guarda la estadística de la distribuidora. Idempotente: una
   * fila por distribuidora que se reescribe con lo que dicen los datos.
   */
  async calcular(
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<RouteServiceTimeStat> {
    // Días calendario argentinos completos: los últimos 30, sin el de hoy (que
    // a la hora de la corrida recién empieza).
    const hoy = diaArgentino(ahora);
    const desde = inicioDelDiaArgentino(sumarDias(hoy, -VENTANA_DIAS)) as Date;
    const hasta = inicioDelDiaArgentino(hoy) as Date;
    const filas: Array<{ minutes: string }> = await this.dataSource.query(
      `SELECT EXTRACT(EPOCH FROM (o."deliveredAt" - s."arrived_at")) / 60 AS minutes
         FROM "route_batch_stop" s
         JOIN "route_batch" b ON b."batch_id" = s."batch_id"
         JOIN "order" o ON o."order_id" = s."order_id"
        WHERE b."distributor_id" = $1
          AND o."distributor_id" = $1
          AND o."status" = 'delivered'
          AND o."deliveredAt" >= $2
          AND o."deliveredAt" < $3
          AND s."arrived_at" IS NOT NULL
          AND s."removed_reason" IS NULL
          AND s."failed_attempts" = 0`,
      [distributorId, desde, hasta],
    );
    const r = calcularTiempoDeAtencion(filas.map((f) => Number(f.minutes)));
    await this.stats.upsert(
      {
        distributorId,
        samples: r.samples,
        medianMin: r.medianMin,
        p90Min: r.p90Min,
        windowDays: VENTANA_DIAS,
        computedAt: ahora,
      },
      ['distributorId'],
    );
    return this.stats.findOneByOrFail({ distributorId });
  }

  /** La mediana aprendida (decimal, de 1 a 60) o `null` si no hay muestras suficientes. */
  async medianaAprendida(distributorId: string): Promise<number | null> {
    const fila = await this.stats.findOneBy({ distributorId });
    return fila?.medianMin ?? null;
  }

  async estado(distributorId: string): Promise<EstadoDelTiempoDeAtencion> {
    const v = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    const mode = modoDeServicio(v.serviceMinutesMode);
    const fila = await this.stats.findOneBy({ distributorId });
    const mediana = fila?.medianMin ?? null;
    return {
      mode,
      fixedMinutes: v.serviceMinutes,
      suggestedMinutes:
        mediana === null
          ? null
          : minutosDeServicio(v.serviceMinutes, 'learned', mediana),
      p90Minutes: fila?.p90Min ?? null,
      effectiveMinutes: minutosDeServicio(v.serviceMinutes, mode, mediana),
      samples: fila?.samples ?? 0,
      minSamples: MUESTRAS_MINIMAS,
      windowDays: fila?.windowDays ?? VENTANA_DIAS,
      computedAt: fila?.computedAt ?? null,
    };
  }
}
