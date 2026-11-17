import { AsyncLocalStorage } from 'async_hooks';
import { errorMessage } from '../common/errors/error-message';
import { reportarErrorAtrapado } from '../common/sentry/reportar-a-sentry';
import { RunTrigger } from './domain/process-catalog';

/** Lo que una corrida en curso le cuenta al registrador sin cambiar lo que devuelve. */
export interface CorridaEnCurso {
  /** El proceso que corre (`ProcessName`), para etiquetar lo que se manda a Sentry. */
  proceso: string | null;
  /** La empresa de la corrida, si es por empresa. */
  distributorId: string | null;
  /** La corrida no hizo nada porque otra instancia tenía el cerrojo. */
  skipped: boolean;
  /** Errores atrapados dentro de la corrida (el proceso sigue). */
  errors: number;
  /** Un error que cortó la corrida entera, atrapado por el propio proceso. */
  fatal: string | null;
  lastError: string | null;
  /**
   * Cuántas empresas terminaron en cada estado cuando el proceso las recorre con
   * `EmpresasParaProceso` (`{ ok: 7, failed: 1, skipped: 3, … }`); `null` si
   * el proceso no recorre empresas.
   */
  companies: Record<string, number> | null;
  /**
   * Los elementos que el proceso recorre (un ticket, un chat, un día, un
   * lote, una empresa) con su clave: los que fallaron en esta corrida (con
   * el error) y los que salieron bien. Con eso `RachasDeFallas` lleva cuántas
   * corridas seguidas lleva fallando cada uno.
   */
  elementos: {
    fallidos: Map<string, string>;
    bien: Set<string>;
  };
}

/** Los estados por empresa que suma `companies`, siempre presentes en el resumen. */
export const ESTADOS_DE_EMPRESA = [
  'ok',
  'failed',
  'timeout',
  'locked',
  'circuit_open',
  'paused',
  'skipped',
] as const;

const corrida = new AsyncLocalStorage<CorridaEnCurso>();
const disparo = new AsyncLocalStorage<RunTrigger>();

export function nuevaCorrida(
  proceso: string | null = null,
  distributorId: string | null = null,
): CorridaEnCurso {
  return {
    proceso,
    distributorId,
    skipped: false,
    errors: 0,
    fatal: null,
    lastError: null,
    companies: null,
    elementos: { fallidos: new Map(), bien: new Set() },
  };
}

export function dentroDeCorrida<T>(estado: CorridaEnCurso, fn: () => T): T {
  return corrida.run(estado, fn);
}

/** Los helpers de cerrojo avisan que esta corrida no hizo nada por no tenerlo. Fuera de una corrida registrada no hace nada. */
export function marcarSaltada(): void {
  const actual = corrida.getStore();
  if (actual) actual.skipped = true;
}

/**
 * Un proceso que atrapa su error (y lo loguea) avisa al registrador. `fatal`:
 * la corrida entera quedó cortada (`failed`); si no, falló una parte y el resto
 * siguió (`partial`). El error también va a Sentry, con el proceso como tag
 * (dentro o fuera de una corrida registrada), salvo que en HTTP sea un 4xx o
 * que el mismo error ya haya salido hace menos de 10 minutos.
 */
export function registrarErrorAtrapado(error: unknown, fatal = false): void {
  const actual = corrida.getStore();
  reportarErrorAtrapado(error, {
    proceso: actual?.proceso ?? null,
    distribuidora: actual?.distributorId ?? null,
    fatal,
  });
  if (!actual) return;
  const mensaje = errorMessage(error);
  actual.errors += 1;
  actual.lastError = mensaje;
  if (fatal) actual.fatal = mensaje;
}

/**
 * Falló un elemento de los que recorre el proceso (el resto sigue): cuenta
 * como error atrapado (la corrida queda `partial`) y suma a la racha de ese
 * elemento. A las 3 corridas seguidas fallando, `RachasDeFallas` avisa una
 * vez a la plataforma. `elemento` es una clave estable (`ticket:<id>`).
 */
export function registrarFallaDeElemento(
  elemento: string,
  error: unknown,
): void {
  registrarErrorAtrapado(error);
  corrida.getStore()?.elementos.fallidos.set(elemento, errorMessage(error));
}

/** El elemento salió bien: si venía fallando, su racha se corta. */
export function registrarElementoBien(elemento: string): void {
  corrida.getStore()?.elementos.bien.add(elemento);
}

/**
 * `EmpresasParaProceso` suma lo que pasó con cada empresa en la corrida en
 * curso (si el proceso recorre empresas más de una vez, se acumula). Fuera de
 * una corrida registrada no hace nada.
 */
export function anotarEmpresas(resumen: Record<string, number>): void {
  const actual = corrida.getStore();
  if (!actual) return;
  const total: Record<string, number> =
    actual.companies ??
    Object.fromEntries(ESTADOS_DE_EMPRESA.map((e) => [e, 0]));
  for (const [estado, cuantas] of Object.entries(resumen)) {
    total[estado] = (total[estado] ?? 0) + cuantas;
  }
  actual.companies = total;
}

/** Cuántos errores atrapó la corrida en curso hasta ahora (0 fuera de una corrida registrada). */
export function erroresAtrapados(): number {
  return corrida.getStore()?.errors ?? 0;
}

/** Ejecuta `fn` marcando que no la disparó el cron (p. ej. el webhook que adelanta el procesamiento). */
export function conDisparo<T>(origen: RunTrigger, fn: () => T): T {
  return disparo.run(origen, fn);
}

export function disparoActual(): RunTrigger {
  return disparo.getStore() ?? RunTrigger.CRON;
}
