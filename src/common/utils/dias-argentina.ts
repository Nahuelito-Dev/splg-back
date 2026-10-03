/**
 * Días calendario en hora argentina (America/Argentina/Buenos_Aires).
 *
 * Argentina no tiene horario de verano desde 2009: el desfasaje contra UTC es
 * -3 todo el año, así que alcanza con una constante. Nada de acá depende de la
 * zona horaria del proceso (`TZ`): todo se calcula con componentes UTC.
 */
import { Logger } from '@nestjs/common';

export const ZONA_ARGENTINA = 'America/Argentina/Buenos_Aires';

let avisoZonaEmitido = false;
const DESFASAJE_EN_MS = 3 * 60 * 60 * 1000;
const UN_DIA_EN_MS = 24 * 60 * 60 * 1000;
const FORMATO_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Rango semiabierto de instantes: `[desde, hasta)`. */
export interface RangoDeInstantes {
  desde: Date;
  hasta: Date;
}

/** Acepta exactamente `YYYY-MM-DD` y devuelve [año, mes, día]. */
function partes(dia: string): [number, number, number] | null {
  const m = FORMATO_DIA.exec(dia);
  if (!m) return null;
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const d = Number(m[3]);
  const control = new Date(Date.UTC(anio, mes - 1, d));
  if (
    control.getUTCFullYear() !== anio ||
    control.getUTCMonth() !== mes - 1 ||
    control.getUTCDate() !== d
  ) {
    return null;
  }
  return [anio, mes, d];
}

/** Instante en que arranca (00:00 ART) el día `YYYY-MM-DD`; `null` si es inválido. */
export function inicioDelDiaArgentino(dia: string): Date | null {
  const p = partes(dia);
  if (!p) return null;
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]) + DESFASAJE_EN_MS);
}

/**
 * `[inicio del día, inicio del día siguiente)` en hora argentina.
 * `null` si el día no tiene formato `YYYY-MM-DD` válido.
 */
export function rangoDelDiaArgentino(dia: string): RangoDeInstantes | null {
  const desde = inicioDelDiaArgentino(dia);
  if (!desde) return null;
  return { desde, hasta: new Date(desde.getTime() + UN_DIA_EN_MS) };
}

/**
 * Rango de días con `hasta` INCLUSIVO: `[inicio de desde, inicio del día
 * siguiente a hasta)`. `null` si alguno de los dos días es inválido.
 */
export function rangoDeDiasArgentinos(
  desde: string,
  hasta: string,
): RangoDeInstantes | null {
  const inicio = inicioDelDiaArgentino(desde);
  const ultimo = rangoDelDiaArgentino(hasta);
  if (!inicio || !ultimo) return null;
  return { desde: inicio, hasta: ultimo.hasta };
}

/** El día calendario (`YYYY-MM-DD`) en Argentina al que pertenece un instante. */
export function diaArgentino(instante: Date = new Date()): string {
  return new Date(instante.getTime() - DESFASAJE_EN_MS)
    .toISOString()
    .slice(0, 10);
}

/** Suma `dias` (puede ser negativo) a un día `YYYY-MM-DD`. */
export function sumarDias(dia: string, dias: number): string {
  const p = partes(dia);
  if (!p) throw new Error(`Día inválido: ${dia}`);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + dias))
    .toISOString()
    .slice(0, 10);
}

/** Lunes de la semana ISO a la que pertenece un `YYYY-MM-DD`. */
export function lunesDeLaSemana(dia: string): string {
  return sumarDias(dia, -((diaDeLaSemana(dia) + 6) % 7));
}

/** Día de la semana de un `YYYY-MM-DD`: 0 = domingo … 6 = sábado. */
export function diaDeLaSemana(dia: string): number {
  const p = partes(dia);
  if (!p) throw new Error(`Día inválido: ${dia}`);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

/** Primer día del mes de un `YYYY-MM-DD`. */
export function primerDiaDelMes(dia: string): string {
  return `${dia.slice(0, 7)}-01`;
}

/** Primer día del mes siguiente al de un `YYYY-MM-DD`. */
export function primerDiaDelMesSiguiente(dia: string): string {
  const p = partes(dia);
  if (!p) throw new Error(`Día inválido: ${dia}`);
  return new Date(Date.UTC(p[0], p[1], 1)).toISOString().slice(0, 10);
}

/**
 * Zona en la que el driver `pg` guarda las columnas `timestamp` (sin zona): la
 * hora de pared del proceso Node. En un VPS suele ser UTC; en un equipo de
 * desarrollo, la local.
 */
export function zonaDelProceso(): string {
  const zona = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (/^[A-Za-z0-9_+\-/]+$/.test(zona)) return zona;
  if (!avisoZonaEmitido) {
    avisoZonaEmitido = true;
    new Logger('dias-argentina').warn(
      `Zona horaria del proceso no reconocida ("${zona}"): se asume UTC al agrupar por día`,
    );
  }
  return 'UTC';
}

/**
 * Expresión SQL que trunca `columna` (un `timestamp` sin zona, escrito por el
 * proceso Node en `zonaColumna`) a `granularidad` en hora argentina y devuelve
 * el instante (timestamptz) en que arranca ese período en Argentina.
 */
export function truncarEnArgentinaSql(
  granularidad: 'day' | 'week' | 'month',
  columna: string,
  zonaColumna: string = zonaDelProceso(),
): string {
  return `date_trunc('${granularidad}', ${columna} AT TIME ZONE '${zonaColumna}' AT TIME ZONE '${ZONA_ARGENTINA}') AT TIME ZONE '${ZONA_ARGENTINA}'`;
}
