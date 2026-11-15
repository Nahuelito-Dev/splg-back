import { AsyncLocalStorage } from 'async_hooks';
import { errorMessage } from '../common/errors/error-message';
import { RunTrigger } from './domain/process-catalog';

/** Lo que una corrida en curso le cuenta al registrador sin cambiar lo que devuelve. */
export interface CorridaEnCurso {
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

export function nuevaCorrida(): CorridaEnCurso {
  return {
    skipped: false,
    errors: 0,
    fatal: null,
    lastError: null,
    companies: null,
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
 * siguió (`partial`).
 */
export function registrarErrorAtrapado(error: unknown, fatal = false): void {
  const actual = corrida.getStore();
  if (!actual) return;
  const mensaje = errorMessage(error);
  actual.errors += 1;
  actual.lastError = mensaje;
  if (fatal) actual.fatal = mensaje;
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
