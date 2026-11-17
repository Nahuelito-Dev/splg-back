import {
  MOTIVOS_EN_CASTELLANO,
  MotivoDeDerivacion,
} from '../../assistant-ai/asistente-ia.dominio';
import {
  diaArgentino,
  sumarDias,
  diasEntre,
} from '../../common/utils/dias-argentina';
import { type Periodo, periodoDe } from '../../platform/application/periodo';
import {
  type HorarioDeLaEmpresa,
  minutosHabiles,
} from './horario-de-la-empresa';

/**
 * Métricas del chat y del asistente (DISENO-COMUNICACION §16, DISENO-CH-BOT
 * §8, etapa B4): los cálculos que no dependen de la base. Todo lo que no tiene
 * datos sale `null` (nunca `NaN`); los conteos, 0.
 */

/** Días que mira el tablero si no se pide un período (hoy incluido). */
export const DIAS_POR_DEFECTO = 30;

/**
 * El período de las métricas: días argentinos `from`..`to`, inclusive. Sin
 * `to`, hoy; sin `from`, los 30 días que terminan en `to`. Hasta 366 días
 * (400 si es más largo, si `from` es posterior a `to` o si una fecha no existe).
 */
export function periodoDeLasMetricas(
  from: string | undefined,
  to: string | undefined,
  ahora: Date = new Date(),
): Periodo {
  const hasta = to ?? diaArgentino(ahora);
  const desde =
    from ?? (esDia(hasta) ? sumarDias(hasta, 1 - DIAS_POR_DEFECTO) : hasta);
  return periodoDe(desde, hasta, ahora);
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;

function esDia(valor: string): boolean {
  if (!DIA.test(valor)) return false;
  const [a, m, d] = valor.split('-').map(Number);
  const fecha = new Date(Date.UTC(a, m - 1, d));
  return fecha.getUTCMonth() === m - 1 && fecha.getUTCDate() === d;
}

/** Los días del período, en orden. */
export function diasDelPeriodo(p: Pick<Periodo, 'from' | 'to'>): string[] {
  const n = diasEntre(p.from, p.to);
  return Array.from({ length: n + 1 }, (_, i) => sumarDias(p.from, i));
}

const redondear = (n: number, decimales: number): number => {
  const f = 10 ** decimales;
  return Math.round(n * f) / f;
};

/** La mediana (con un decimal); `null` sin valores. */
export function mediana(valores: readonly number[]): number | null {
  if (valores.length === 0) return null;
  const v = [...valores].sort((a, b) => a - b);
  const medio = Math.floor(v.length / 2);
  return v.length % 2 === 1
    ? v[medio]
    : redondear((v[medio - 1] + v[medio]) / 2, 1);
}

/**
 * El percentil `p` (0 a 100) por rango más cercano: el menor valor que deja
 * al menos el p % de los valores por debajo o igual. `null` sin valores.
 */
export function percentil(
  valores: readonly number[],
  p: number,
): number | null {
  if (valores.length === 0) return null;
  const v = [...valores].sort((a, b) => a - b);
  const rango = Math.max(1, Math.ceil((p / 100) * v.length));
  return v[Math.min(rango, v.length) - 1];
}

/** `parte / total` con tres decimales (0 a 1); `null` si no hay total. */
export function proporcion(parte: number, total: number): number | null {
  return total > 0 ? redondear(parte / total, 3) : null;
}

/** Minutos de reloj corrido entre dos momentos (redondeados; nunca negativos). */
export function minutosCorridos(desde: Date, hasta: Date): number {
  return Math.max(0, Math.round((hasta.getTime() - desde.getTime()) / 60_000));
}

/** Cumplimiento de un objetivo: a tiempo, fuera de término y la proporción a tiempo. */
export interface Cumplimiento {
  met: number;
  missed: number;
  rate: number | null;
}

/** Tiempo de primera respuesta de un conjunto de conversaciones o tickets. */
export interface ResumenDeRespuesta {
  /** Con primera respuesta. */
  responded: number;
  /** Abiertas, esperando todavía la primera respuesta de una persona. */
  unanswered: number;
  /**
   * Cerradas sin respuesta de una persona (las resolvió el asistente, se
   * cerraron por inactividad, se resolvió el ticket sin escribir): no entran
   * en el TPR ni en el objetivo.
   */
  closedWithoutHumanReply: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  /** Contra el objetivo; `null` si no hay objetivo. */
  target: Cumplimiento | null;
}

/**
 * Cuándo empezó a esperar, cuándo le respondió una persona (`null`: todavía
 * no) y si ya se cerró.
 */
export interface Espera {
  desde: Date;
  hasta: Date | null;
  cerrada: boolean;
}

/**
 * Lo que se sabe de una espera, medido una sola vez (los minutos hábiles son
 * lo caro):
 * - `respondida`: sus minutos hábiles.
 * - `esperando`: abierta sin respuesta; `vencida` si ya pasó el objetivo
 *   (`null` sin objetivo).
 * - `cerrada`: cerrada sin respuesta de una persona.
 * - `excluida`: la respuesta es anterior al inicio de la espera (un ticket
 *   abierto desde un chat ya respondido): no se puede medir.
 */
export type MedidaDeEspera =
  | { estado: 'respondida'; minutos: number }
  | { estado: 'esperando'; vencida: boolean | null }
  | { estado: 'cerrada' }
  | { estado: 'excluida' };

export function medirEspera(
  e: Espera,
  horario: HorarioDeLaEmpresa,
  objetivoMinutos: number | null,
  ahora: Date,
): MedidaDeEspera {
  if (e.hasta) {
    return e.hasta.getTime() < e.desde.getTime()
      ? { estado: 'excluida' }
      : {
          estado: 'respondida',
          minutos: minutosHabiles(horario, e.desde, e.hasta),
        };
  }
  if (e.cerrada) return { estado: 'cerrada' };
  return {
    estado: 'esperando',
    // Con tope: alcanza con saber si pasó el objetivo.
    vencida:
      objetivoMinutos === null
        ? null
        : minutosHabiles(horario, e.desde, ahora, objetivoMinutos) >
          objetivoMinutos,
  };
}

/**
 * TPR en minutos hábiles (§16): mediana y p90 de las respondidas y, con
 * objetivo, cuántas respondieron dentro de él y cuántas no. Una que espera
 * todavía cuenta fuera de término sólo si ya pasó el objetivo (antes, no se
 * sabe); una cerrada sin respuesta o una excluida no cuentan.
 */
export function resumirMedidas(
  medidas: readonly MedidaDeEspera[],
  objetivoMinutos: number | null,
): ResumenDeRespuesta {
  const minutos: number[] = [];
  let unanswered = 0;
  let cerradas = 0;
  let met = 0;
  let missed = 0;
  for (const m of medidas) {
    if (m.estado === 'respondida') {
      minutos.push(m.minutos);
      if (objetivoMinutos !== null) {
        if (m.minutos <= objetivoMinutos) met++;
        else missed++;
      }
    } else if (m.estado === 'esperando') {
      unanswered++;
      if (m.vencida === true) missed++;
    } else if (m.estado === 'cerrada') {
      cerradas++;
    }
  }
  return {
    responded: minutos.length,
    unanswered,
    closedWithoutHumanReply: cerradas,
    medianMinutes: mediana(minutos),
    p90Minutes: percentil(minutos, 90),
    target:
      objetivoMinutos === null
        ? null
        : { met, missed, rate: proporcion(met, met + missed) },
  };
}

/** Mide y resume (para quien no reusa las medidas). */
export function resumirRespuestas(
  esperas: readonly Espera[],
  horario: HorarioDeLaEmpresa,
  objetivoMinutos: number | null,
  ahora: Date,
): ResumenDeRespuesta {
  return resumirMedidas(
    esperas.map((e) => medirEspera(e, horario, objetivoMinutos, ahora)),
    objetivoMinutos,
  );
}

/** Un ticket contra su vencimiento de primera respuesta (§16: `first_response_due_at`). */
export interface PlazoDeTicket {
  creado: Date;
  respondido: Date | null;
  vence: Date | null;
  /** Resuelto o cerrado. */
  terminado: boolean;
}

/**
 * A tiempo: respondido hasta el vencimiento. Fuera de término: respondido
 * después, o sin responder, abierto y ya vencido. No cuentan: sin
 * vencimiento, sin responder todavía en plazo, terminado sin respuesta, o con
 * la respuesta anterior a la apertura (la misma regla que el TPR).
 */
export function cumplimientoDeTickets(
  tickets: readonly PlazoDeTicket[],
  ahora: Date,
): Cumplimiento {
  let met = 0;
  let missed = 0;
  for (const t of tickets) {
    if (!t.vence) continue;
    if (t.respondido) {
      if (t.respondido.getTime() < t.creado.getTime()) continue;
      if (t.respondido.getTime() <= t.vence.getTime()) met++;
      else missed++;
    } else if (!t.terminado && t.vence.getTime() < ahora.getTime()) {
      missed++;
    }
  }
  return { met, missed, rate: proporcion(met, met + missed) };
}

/** Un motivo de derivación del asistente y cuántas veces pasó. */
export interface MotivoContado {
  reason: string;
  label: string;
  count: number;
}

const MOTIVOS_CONOCIDOS: ReadonlySet<string> = new Set(
  Object.values(MotivoDeDerivacion),
);

/** El motivo en castellano (el de la nota del equipo); uno desconocido, «Otro motivo». */
export function etiquetaDelMotivo(reason: string): string {
  return MOTIVOS_CONOCIDOS.has(reason)
    ? MOTIVOS_EN_CASTELLANO[reason as MotivoDeDerivacion]
    : 'Otro motivo';
}

/** Las derivaciones por motivo, la más frecuente primero (a igual cantidad, por clave). */
export function motivosDeDerivacion(
  filas: ReadonlyArray<{ reason: string | null; count: number }>,
): MotivoContado[] {
  const cuentas = new Map<string, number>();
  for (const f of filas) {
    const r = f.reason ?? 'unknown';
    cuentas.set(r, (cuentas.get(r) ?? 0) + f.count);
  }
  return [...cuentas.entries()]
    .map(([reason, count]) => ({
      reason,
      label: etiquetaDelMotivo(reason),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Una clave contada (plantillas, respuestas automáticas). */
export interface ClaveContada {
  key: string;
  count: number;
}

/** Total y detalle por clave, la más usada primero. */
export function porClave(filas: readonly ClaveContada[]): {
  total: number;
  byKey: ClaveContada[];
} {
  const cuentas = new Map<string, number>();
  for (const f of filas) {
    cuentas.set(f.key, (cuentas.get(f.key) ?? 0) + f.count);
  }
  const byKey = [...cuentas.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { total: byKey.reduce((s, f) => s + f.count, 0), byKey };
}

/** Distribución de puntajes 1 a 5 (todos presentes, en 0 si no hubo). */
export function distribucionDePuntajes(
  puntajes: ReadonlyArray<{ score: number; count: number }>,
): Array<{ score: number; count: number }> {
  return [1, 2, 3, 4, 5].map((score) => ({
    score,
    count: puntajes
      .filter((p) => p.score === score)
      .reduce((s, p) => s + p.count, 0),
  }));
}

/** Promedio ponderado de puntajes (dos decimales); `null` sin puntajes. */
export function promedioDePuntajes(
  puntajes: ReadonlyArray<{ score: number; count: number }>,
): number | null {
  const n = puntajes.reduce((s, p) => s + p.count, 0);
  if (n === 0) return null;
  const suma = puntajes.reduce((s, p) => s + p.score * p.count, 0);
  return redondear(suma / n, 2);
}

/** Un día de la serie del gráfico. */
export interface DiaDeLaSerie {
  date: string;
  newConversations: number;
  firstResponseMedianMinutes: number | null;
}

/**
 * La serie diaria (día argentino de creación): conversaciones nuevas y la
 * mediana del TPR hábil de las que se crearon ese día y ya tienen respuesta.
 * Todos los días del período, aunque estén vacíos.
 */
export function serieDiaria(
  dias: readonly string[],
  conversaciones: ReadonlyArray<{ creada: Date; minutos: number | null }>,
): DiaDeLaSerie[] {
  const porDia = new Map<string, { n: number; minutos: number[] }>(
    dias.map((d) => [d, { n: 0, minutos: [] }]),
  );
  for (const c of conversaciones) {
    const dia = porDia.get(diaArgentino(c.creada));
    if (!dia) continue;
    dia.n++;
    if (c.minutos !== null) dia.minutos.push(c.minutos);
  }
  return dias.map((date) => {
    const d = porDia.get(date) ?? { n: 0, minutos: [] };
    return {
      date,
      newConversations: d.n,
      firstResponseMedianMinutes: mediana(d.minutos),
    };
  });
}

/** Lo que hizo el asistente en un período (de las trazas y las conversaciones cerradas). */
export interface MetricasDelAsistente {
  /** Respuestas que publicó. */
  aiReplies: number;
  /** Veces que pasó la conversación a una persona. */
  handoffs: number;
  handoffReasons: MotivoContado[];
  /** Conversaciones en las que respondió o derivó. */
  conversationsAttended: number;
  /** Cerradas (creadas en el período) en las que respondió al menos una vez. */
  closedWithAssistant: number;
  /** De ésas, las que nadie del equipo atendió y no derivó. */
  resolvedWithoutHuman: number;
  resolvedWithoutHumanRate: number | null;
}

export interface TrazaContada {
  outcome: string;
  reason: string | null;
  count: number;
  conversations: number;
}

/** Arma las métricas del asistente con las trazas agrupadas y las resueltas sin persona. */
export function metricasDelAsistente(
  trazas: readonly TrazaContada[],
  atendidas: number,
  resueltas: { closedWithAssistant: number; resolvedWithoutHuman: number },
): MetricasDelAsistente {
  const de = (outcome: string) => trazas.filter((t) => t.outcome === outcome);
  const derivadas = de('handed_off');
  return {
    aiReplies: de('answered').reduce((s, t) => s + t.count, 0),
    handoffs: derivadas.reduce((s, t) => s + t.count, 0),
    handoffReasons: motivosDeDerivacion(derivadas),
    conversationsAttended: atendidas,
    closedWithAssistant: resueltas.closedWithAssistant,
    resolvedWithoutHuman: resueltas.resolvedWithoutHuman,
    resolvedWithoutHumanRate: proporcion(
      resueltas.resolvedWithoutHuman,
      resueltas.closedWithAssistant,
    ),
  };
}
