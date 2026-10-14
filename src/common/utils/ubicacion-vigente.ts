import { enteroPositivoDeEnv } from '../config/entero-positivo';

export interface UbicacionConHora {
  lat: number;
  lng: number;
  at: string | null;
}

/**
 * La posición sólo si es reciente: el radar no vence solo, y una posición de
 * hace una hora dibujaría la camioneta donde ya no está. Sin hora anotada o
 * más vieja que `DRIVER_LOCATION_MAX_AGE_MIN` (10 por defecto), es `null`.
 */
export function ubicacionVigente(
  ubicacion: UbicacionConHora | null,
  ahora: number = Date.now(),
): UbicacionConHora | null {
  if (!ubicacion?.at) return null;
  const maxMs =
    enteroPositivoDeEnv(
      'DRIVER_LOCATION_MAX_AGE_MIN',
      process.env.DRIVER_LOCATION_MAX_AGE_MIN,
      10,
    ) * 60_000;
  return ahora - new Date(ubicacion.at).getTime() <= maxMs ? ubicacion : null;
}
