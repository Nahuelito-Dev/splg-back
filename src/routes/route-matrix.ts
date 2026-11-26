import {
  FACTOR_DE_CALLES,
  VELOCIDAD_MEDIA_KMH,
} from '../route-batch/domain/route-planning';
import { PuntoDeRuta } from './polyline';
import { DurationsToDestination, RouteMatrix } from './route-matrix.port';
import { distanciaEnMetros } from './routes.service';

/**
 * Respaldo cuando OSRM no responde: kilómetros en línea recta por 1,3 (las
 * calles no son rectas) y los minutos a la velocidad media urbana. La diagonal
 * es 0 y la matriz es simétrica.
 */
export function haversinePair(
  a: PuntoDeRuta,
  b: PuntoDeRuta,
): { km: number; minutes: number } {
  const km = (distanciaEnMetros(a, b) / 1000) * FACTOR_DE_CALLES;
  return { km, minutes: (km / VELOCIDAD_MEDIA_KMH) * 60 };
}

export function haversineMatrix(points: readonly PuntoDeRuta[]): RouteMatrix {
  const n = points.length;
  const km: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  const minutes: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const par = haversinePair(points[a], points[b]);
      km[a][b] = km[b][a] = par.km;
      minutes[a][b] = minutes[b][a] = par.minutes;
    }
  }
  return { km, minutes, source: 'haversine' };
}

/** Respaldo de N orígenes a un destino: la línea recta de cada uno. */
export function haversineDurationsTo(
  origins: readonly PuntoDeRuta[],
  destination: PuntoDeRuta,
): DurationsToDestination {
  return {
    minutes: origins.map((o) => haversinePair(o, destination).minutes),
    source: 'haversine',
  };
}
