import { COMPONENTES, Componente } from './componentes';

/** Cada cuánto se muestrea el estado: un bloque = una muestra por componente. */
export const BLOQUE_MS = 5 * 60_000;
export const BLOQUES_POR_DIA = (24 * 60 * 60_000) / BLOQUE_MS;
export const DIAS_HISTORIAL = 90;

/**
 * Los días se cuentan en hora de Argentina (UTC-3 todo el año, sin horario de
 * verano): así un día de la página coincide con el día de la operación.
 */
const OFFSET_ARGENTINA_MS = -3 * 60 * 60_000;
const DIA_MS = 24 * 60 * 60_000;

export type EstadoDia = 'ok' | 'parcial' | 'caido' | 'sin-datos';
export type TipoIncidente = 'caido' | 'sin-datos-servidor';

/** Clave `<día>` -> campo `<componente>:<bloque del día>` -> estaba bien. */
export type Muestras = ReadonlyMap<string, ReadonlyMap<string, boolean>>;

export function campoDeMuestra(componente: Componente, bloque: number): string {
  return `${componente}:${bloque}`;
}

export function inicioDeBloque(ts: number): number {
  return Math.floor(ts / BLOQUE_MS) * BLOQUE_MS;
}

/** `YYYY-MM-DD` del día argentino al que pertenece `ts`. */
export function claveDeDia(ts: number): string {
  return new Date(ts + OFFSET_ARGENTINA_MS).toISOString().slice(0, 10);
}

/** Número de bloque (0..287) de `ts` dentro de su día argentino. */
export function bloqueDelDia(ts: number): number {
  const local = ts + OFFSET_ARGENTINA_MS;
  return Math.floor((((local % DIA_MS) + DIA_MS) % DIA_MS) / BLOQUE_MS);
}

function inicioDeDia(dia: string): number {
  return Date.parse(`${dia}T00:00:00Z`) - OFFSET_ARGENTINA_MS;
}

function hhmm(ts: number): string {
  return new Date(ts + OFFSET_ARGENTINA_MS).toISOString().slice(11, 16);
}

export interface DiaHistorial {
  fecha: string;
  estado: EstadoDia;
  /** Porcentaje 0..100, o `null` si el día es anterior al primer registro. */
  disponibilidad: number | null;
  minutosCaidos: number;
}

export interface Incidente {
  fecha: string;
  desde: string;
  hasta: string;
  tipo: TipoIncidente;
  minutos: number;
}

export interface HistorialComponente {
  /** Del más viejo al de hoy. */
  dias: DiaHistorial[];
  /** Disponibilidad del período, truncada a 2 decimales; `null` sin datos. */
  disponibilidad: number | null;
  incidentes: Incidente[];
}

export interface EntradaDisponibilidad {
  ahora: number;
  /** Inicio del bloque de la primera muestra registrada, o `null` si no hay. */
  primeraMuestra: number | null;
  muestras: Muestras;
  dias?: number;
}

function truncar2(x: number): number {
  return Math.floor(x * 100) / 100;
}

function estadoDelDia(pct: number): EstadoDia {
  if (pct >= 100) return 'ok';
  return pct >= 95 ? 'parcial' : 'caido';
}

/**
 * Disponibilidad por día y componente. Un bloque cuenta si ya terminó y no es
 * anterior al primer registro. Un bloque sin muestra es una caída (servidor
 * apagado); los anteriores al primer registro no cuentan y el día sale gris.
 */
export function calcularHistorial(
  entrada: EntradaDisponibilidad,
): Record<Componente, HistorialComponente> {
  const { ahora, primeraMuestra, muestras } = entrada;
  const cantidadDias = entrada.dias ?? DIAS_HISTORIAL;
  const resultado = {} as Record<Componente, HistorialComponente>;

  for (const componente of COMPONENTES) {
    const dias: DiaHistorial[] = [];
    const incidentes: Incidente[] = [];
    let okTotal = 0;
    let contadosTotal = 0;

    for (let i = cantidadDias - 1; i >= 0; i--) {
      const fecha = claveDeDia(ahora - i * DIA_MS);
      const base = inicioDeDia(fecha);
      const delDia = muestras.get(fecha);
      let contados = 0;
      let ok = 0;
      let corrida: {
        tipo: TipoIncidente;
        desde: number;
        hasta: number;
        n: number;
      } | null = null;
      const cerrarCorrida = () => {
        if (!corrida) return;
        incidentes.push({
          fecha,
          desde: hhmm(corrida.desde),
          hasta:
            corrida.hasta === base + DIA_MS ? '24:00' : hhmm(corrida.hasta),
          tipo: corrida.tipo,
          minutos: corrida.n * (BLOQUE_MS / 60_000),
        });
        corrida = null;
      };

      for (let b = 0; b < BLOQUES_POR_DIA; b++) {
        const inicio = base + b * BLOQUE_MS;
        const fin = inicio + BLOQUE_MS;
        const cuenta =
          primeraMuestra !== null && inicio >= primeraMuestra && fin <= ahora;
        if (!cuenta) {
          cerrarCorrida();
          continue;
        }
        contados++;
        const muestra = delDia?.get(campoDeMuestra(componente, b));
        if (muestra === true) {
          ok++;
          cerrarCorrida();
          continue;
        }
        const tipo: TipoIncidente =
          muestra === false ? 'caido' : 'sin-datos-servidor';
        if (corrida && corrida.tipo === tipo) {
          corrida.hasta = fin;
          corrida.n++;
        } else {
          cerrarCorrida();
          corrida = { tipo, desde: inicio, hasta: fin, n: 1 };
        }
      }
      cerrarCorrida();

      okTotal += ok;
      contadosTotal += contados;
      if (contados === 0) {
        dias.push({
          fecha,
          estado: 'sin-datos',
          disponibilidad: null,
          minutosCaidos: 0,
        });
      } else {
        const pct = (ok / contados) * 100;
        dias.push({
          fecha,
          estado: estadoDelDia(pct),
          disponibilidad: truncar2(pct),
          minutosCaidos: (contados - ok) * (BLOQUE_MS / 60_000),
        });
      }
    }

    resultado[componente] = {
      dias,
      disponibilidad:
        contadosTotal === 0 ? null : truncar2((okTotal / contadosTotal) * 100),
      incidentes,
    };
  }
  return resultado;
}
