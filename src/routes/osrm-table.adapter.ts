import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../common/errors/error-message';
import { urlDeOsrm } from './osrm-url';
import { PuntoDeRuta } from './polyline';
import {
  DurationsToDestination,
  MatrixProvider,
  RouteMatrix,
  RouteMatrixPort,
} from './route-matrix.port';
import {
  haversineDurationsTo,
  haversineMatrix,
  haversinePair,
} from './route-matrix';
import { ROUTES_FETCH } from './routes.service';
import type { FetchFn } from './routes.service';

/** Coordenadas máximas por pedido a `/table` (el demo público tope en 100). */
export const OSRM_MAX_COORDENADAS = 100;
/** Tiempo máximo de cada pedido a `/table`. */
export const TIMEOUT_MS = 8000;
/** Tiempo máximo de toda la matriz, con todos sus bloques. */
export const PLAZO_TOTAL_MS = 15000;
/** Plazo del despacho: ofrecer un pedido no puede esperar más que esto a OSRM; después, línea recta. */
export const PLAZO_DESPACHO_MS = 2500;

interface OsrmTable {
  code?: string;
  /** Segundos; `null` si no hay camino entre los dos puntos. */
  durations?: Array<Array<number | null>>;
  /** Metros. */
  distances?: Array<Array<number | null>>;
}

/**
 * Matriz de OSRM `/table`. Hasta `OSRM_MAX_COORDENADAS` puntos va en un solo
 * pedido; si son más se pide por bloques de origen × destino. Cualquier falla
 * (sin servidor, HTTP, `code` distinto de `Ok`, un par sin camino, tiempo
 * agotado) devuelve la matriz en línea recta: una hoja se puede armar igual,
 * con `source: 'haversine'` a la vista. Toda la matriz tiene un plazo total
 * (`PLAZO_TOTAL_MS`): con muchos bloques no se suman los tiempos de cada uno.
 * Un par que OSRM informa sin camino (`null`) se completa sólo ese par con la
 * línea recta, y la matriz lo cuenta en `approximatedPairs`.
 */
@Injectable()
export class OsrmTableMatrixAdapter extends RouteMatrixPort {
  private readonly logger = new Logger(OsrmTableMatrixAdapter.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(ROUTES_FETCH) private readonly http: FetchFn,
  ) {
    super();
  }

  async matrix(points: readonly PuntoDeRuta[]): Promise<RouteMatrix> {
    if (points.length < 2) return haversineMatrix(points);
    const base = urlDeOsrm(this.config);
    if (!base) {
      this.logger.warn('Sin OSRM configurado: matriz en línea recta');
      return haversineMatrix(points);
    }
    try {
      const matriz = await this.deOsrm(base, points);
      if (matriz.approximatedPairs) {
        this.logger.warn(
          `OSRM /table sin camino en ${matriz.approximatedPairs} pares: se completaron con la línea recta`,
        );
      }
      return matriz;
    } catch (error) {
      this.logger.warn(
        `OSRM /table falló, matriz en línea recta: ${errorMessage(error)}`,
      );
      return haversineMatrix(points);
    }
  }

  /**
   * N orígenes a un destino en un solo pedido a `/table` (`sources` = los
   * orígenes, `destinations` = el último punto). Un origen sin camino se
   * completa con su línea recta; cualquier otra falla, o más de
   * `OSRM_MAX_COORDENADAS` puntos, devuelve todo en línea recta.
   */
  async durationsTo(
    origins: readonly PuntoDeRuta[],
    destination: PuntoDeRuta,
  ): Promise<DurationsToDestination> {
    if (origins.length === 0) return { minutes: [], source: 'haversine' };
    const base = urlDeOsrm(this.config);
    if (!base) {
      this.logger.warn('Sin OSRM configurado: tiempos en línea recta');
      return haversineDurationsTo(origins, destination);
    }
    if (origins.length + 1 > OSRM_MAX_COORDENADAS) {
      this.logger.warn('Demasiados orígenes para /table: línea recta');
      return haversineDurationsTo(origins, destination);
    }
    try {
      const puntos = [...origins, destination];
      const tabla = await this.pedir(
        base,
        puntos,
        rango(0, origins.length),
        [origins.length],
        Date.now() + PLAZO_DESPACHO_MS,
      );
      const sources: MatrixProvider[] = [];
      const minutes = origins.map((origen, i) => {
        const seg = tabla.durations?.[i]?.[0];
        if (seg === null) {
          sources.push('haversine');
          return haversinePair(origen, destination).minutes;
        }
        if (typeof seg !== 'number') {
          throw new Error(`respuesta incompleta del origen ${i}`);
        }
        sources.push('osrm');
        return seg / 60;
      });
      return { minutes, source: 'osrm', sources };
    } catch (error) {
      this.logger.warn(
        `OSRM /table falló, tiempos en línea recta: ${errorMessage(error)}`,
      );
      return haversineDurationsTo(origins, destination);
    }
  }

  private async deOsrm(
    base: string,
    points: readonly PuntoDeRuta[],
  ): Promise<RouteMatrix> {
    const n = points.length;
    const vence = Date.now() + PLAZO_TOTAL_MS;
    let aproximados = 0;
    const minutes = Array.from({ length: n }, () =>
      new Array<number>(n).fill(0),
    );
    const km = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const bloque =
      n <= OSRM_MAX_COORDENADAS ? n : Math.floor(OSRM_MAX_COORDENADAS / 2);

    for (let s0 = 0; s0 < n; s0 += bloque) {
      for (let d0 = 0; d0 < n; d0 += bloque) {
        const fuentes = rango(s0, Math.min(s0 + bloque, n));
        const destinos = rango(d0, Math.min(d0 + bloque, n));
        // Un solo bloque usa todos los puntos; varios, la unión de sus dos lados.
        const usados =
          bloque === n ? fuentes : [...new Set([...fuentes, ...destinos])];
        const en = new Map(usados.map((p, i) => [p, i]));
        const tabla = await this.pedir(
          base,
          usados.map((p) => points[p]),
          fuentes.map((p) => en.get(p) as number),
          destinos.map((p) => en.get(p) as number),
          vence,
        );
        fuentes.forEach((a, i) =>
          destinos.forEach((b, j) => {
            const seg = tabla.durations?.[i]?.[j];
            const m = tabla.distances?.[i]?.[j];
            if (seg === null || m === null) {
              // Sin camino entre los dos: sólo ese par sale de la línea recta.
              const recta = haversinePair(points[a], points[b]);
              minutes[a][b] = recta.minutes;
              km[a][b] = recta.km;
              aproximados++;
              return;
            }
            if (typeof seg !== 'number' || typeof m !== 'number') {
              throw new Error(`respuesta incompleta entre ${a} y ${b}`);
            }
            minutes[a][b] = seg / 60;
            km[a][b] = m / 1000;
          }),
        );
      }
    }
    return { minutes, km, source: 'osrm', approximatedPairs: aproximados };
  }

  private async pedir(
    base: string,
    puntos: readonly PuntoDeRuta[],
    fuentes: number[],
    destinos: number[],
    vence: number,
  ): Promise<OsrmTable> {
    const queda = vence - Date.now();
    if (queda <= 0) throw new Error('se agotó el plazo de la matriz');
    const coordenadas = puntos
      .map((p) => `${coordenada(p.lng)},${coordenada(p.lat)}`)
      .join(';');
    const completo =
      fuentes.length === puntos.length && destinos.length === puntos.length;
    const url =
      `${base}/table/v1/driving/${coordenadas}?annotations=duration,distance` +
      (completo
        ? ''
        : `&sources=${fuentes.join(';')}&destinations=${destinos.join(';')}`);
    const control = new AbortController();
    const timer = setTimeout(
      () => control.abort(),
      Math.min(TIMEOUT_MS, queda),
    );
    try {
      const res = await this.http(url, { signal: control.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as OsrmTable;
      if (data.code !== 'Ok') throw new Error(`code ${data.code}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Seis decimales (≈ 10 cm) alcanzan y evitan colas de punto flotante en la URL. */
const coordenada = (n: number): string => String(Number(n.toFixed(6)));

const rango = (desde: number, hasta: number): number[] =>
  Array.from({ length: hasta - desde }, (_, i) => desde + i);
