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

/**
 * Matriz de tiempos y distancias entre N puntos para armar y ordenar las hojas
 * de ruta. Nunca falla por el proveedor: si OSRM no responde, devuelve la
 * estimación en línea recta (`source: 'haversine'`) y el llamador lo muestra.
 */
export abstract class RouteMatrixPort {
  abstract matrix(points: readonly PuntoDeRuta[]): Promise<RouteMatrix>;
}
