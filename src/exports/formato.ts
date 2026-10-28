import { diaArgentino } from '../common/utils/dias-argentina';
import type { Celda, TipoDeColumna } from './export.types';

/** Argentina no tiene horario de verano: -3 todo el año. */
const DESFASAJE_ARGENTINA_MS = 3 * 60 * 60 * 1000;
const DIA = /^\d{4}-\d{2}-\d{2}/;

/** Una celda que empieza así la interpreta una planilla como fórmula. */
const INICIO_DE_FORMULA = /^[=+\-@\t\r]/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Convierte lo que venga en un instante válido; `null` si no se puede. */
export function aInstante(valor: Celda): Date | null {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'boolean') return null;
  const fecha = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/** `YYYY-MM-DD` en hora argentina; un texto que ya es un día se respeta tal cual. */
export function aDia(valor: Celda): string | null {
  if (typeof valor === 'string' && DIA.test(valor) && valor.length === 10) {
    return valor;
  }
  const instante = aInstante(valor);
  return instante ? diaArgentino(instante) : null;
}

/** `YYYY-MM-DD HH:mm` en hora argentina. */
export function aDiaYHora(valor: Celda): string | null {
  const instante = aInstante(valor);
  if (!instante) return null;
  const local = new Date(instante.getTime() - DESFASAJE_ARGENTINA_MS);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  );
}

/**
 * El instante como lo muestra una planilla: Excel no guarda zona, así que la
 * hora argentina se escribe como si fuera UTC.
 */
export function aInstanteDePlanilla(valor: Celda): Date | null {
  const instante = aInstante(valor);
  return instante
    ? new Date(instante.getTime() - DESFASAJE_ARGENTINA_MS)
    : null;
}

/** El día como medianoche UTC, para una celda de fecha de Excel. */
export function aDiaDePlanilla(valor: Celda): Date | null {
  const dia = aDia(valor);
  return dia ? new Date(`${dia}T00:00:00.000Z`) : null;
}

/** Número finito; las columnas numéricas de SQL crudo pueden llegar como texto. */
export function aNumero(valor: Celda): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'boolean' || valor instanceof Date) return null;
  const n = typeof valor === 'number' ? valor : Number(valor);
  return Number.isFinite(n) ? n : null;
}

export function aTextoDeBooleano(valor: Celda): string {
  if (valor === null || valor === undefined || valor === '') return '';
  return valor === true || valor === 'true' || valor === 1 ? 'Sí' : 'No';
}

export function esNumerico(tipo: TipoDeColumna): boolean {
  return tipo === 'entero' || tipo === 'decimal' || tipo === 'moneda';
}

/** Neutraliza una celda de texto que una planilla leería como fórmula. */
export function neutralizarFormula(texto: string): string {
  return INICIO_DE_FORMULA.test(texto) ? `'${texto}` : texto;
}
