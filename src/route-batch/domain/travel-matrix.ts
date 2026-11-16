/**
 * Tiempos y distancias entre los puntos de un recorrido. La fila y la columna 0
 * suelen ser el punto de salida (depósito); el resto, las paradas. El dominio
 * no sabe de dónde salió: el adaptador de `routes` (OSRM o línea recta) la arma.
 */
export type MatrixSource = 'osrm' | 'google' | 'haversine';

export interface TravelMatrix {
  /** `minutes[a][b]`: minutos de manejo de `a` a `b`. */
  readonly minutes: readonly (readonly number[])[];
  /** `km[a][b]`: kilómetros por calle de `a` a `b`. */
  readonly km: readonly (readonly number[])[];
}

/**
 * Los tiempos de OSRM son a flujo libre: se multiplican por el factor de
 * tránsito. Los de línea recta ya traen la velocidad urbana media, así que no se
 * vuelven a inflar. Devuelve una matriz nueva.
 */
export function applyTrafficFactor(
  matrix: TravelMatrix,
  factor: number,
  source: MatrixSource,
): TravelMatrix {
  if (source === 'haversine' || factor === 1) return matrix;
  return {
    minutes: matrix.minutes.map((fila) => fila.map((m) => m * factor)),
    km: matrix.km,
  };
}
