import { PuntoDeRuta } from './polyline';

/** De dónde salieron los tiempos: el OSRM real o la línea recta de respaldo. */
export type MatrixProvider = 'osrm' | 'haversine';

export interface RouteMatrix {
  /** `minutes[a][b]`: minutos de manejo de `a` a `b`, a flujo libre. */
  minutes: number[][];
  /** `km[a][b]`: kilómetros por calle de `a` a `b`. */
  km: number[][];
  source: MatrixProvider;
  /** Pares que OSRM no pudo resolver y salen de la línea recta (siempre 0 con `haversine`). */
  approximatedPairs?: number;
}

/** Minutos de manejo de cada origen a un mismo destino, en el orden de los orígenes. */
export interface DurationsToDestination {
  minutes: number[];
  source: MatrixProvider;
  /** Fuente de cada origen, cuando no todos salieron de la misma (OSRM sin ruta para uno: línea recta). */
  sources?: MatrixProvider[];
}

/**
 * Matriz de tiempos y distancias entre N puntos para armar y ordenar las hojas
 * de ruta. Nunca falla por el proveedor: si OSRM no responde, devuelve la
 * estimación en línea recta (`source: 'haversine'`) y el llamador lo muestra.
 */
export abstract class RouteMatrixPort {
  abstract matrix(points: readonly PuntoDeRuta[]): Promise<RouteMatrix>;

  /**
   * Minutos de manejo de N orígenes a UN destino (no calcula N×N). Misma
   * garantía que `matrix`: si el proveedor falla, devuelve la línea recta con
   * `source: 'haversine'`.
   */
  abstract durationsTo(
    origins: readonly PuntoDeRuta[],
    destination: PuntoDeRuta,
  ): Promise<DurationsToDestination>;
}
