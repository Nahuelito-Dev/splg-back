import { diaArgentino, minutosDelDiaArgentino } from './dias-argentina';

/** Cuánto se recuerda la última corrida de una empresa (cubre el día y el cambio de día). */
export const MEMORIA_CORRIDA_DIARIA_SEG = 48 * 3600;

/**
 * Si el proceso diario de una empresa toca correr ahora: la hora argentina ya
 * llegó a la configurada y todavía no hubo corrida en el día argentino actual.
 * Así, si el servidor estaba caído en la hora exacta, se recupera en el
 * siguiente tic.
 */
export function tocaCorrerHoy(
  ahora: Date,
  horaConfigurada: number,
  ultimaCorridaDelDia: string | null | undefined,
): boolean {
  const hora = Math.floor(minutosDelDiaArgentino(ahora) / 60);
  if (hora < horaConfigurada) return false;
  return ultimaCorridaDelDia !== diaArgentino(ahora);
}

interface RedisClave {
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSec: number, value: string): Promise<void>;
}

const claveDe = (proceso: string, distributorId: string) =>
  `corrida-diaria:${proceso}:${distributorId}`;

export async function ultimaCorridaDeLaEmpresa(
  redis: RedisClave,
  proceso: string,
  distributorId: string,
): Promise<string | null> {
  return redis.get(claveDe(proceso, distributorId));
}

export async function marcarCorridaDeHoy(
  redis: RedisClave,
  proceso: string,
  distributorId: string,
  ahora: Date,
): Promise<void> {
  await redis.setex(
    claveDe(proceso, distributorId),
    MEMORIA_CORRIDA_DIARIA_SEG,
    diaArgentino(ahora),
  );
}
