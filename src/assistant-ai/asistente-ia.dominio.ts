/**
 * Capa inteligente del asistente del chat (DISENO-CH-BOT §4, etapa B3): las
 * reglas que no dependen de la base ni de la API de Anthropic.
 */

/** Modelo que eligió nahue (D-B): rápido y barato para un chat breve. */
export const MODELO_DEL_ASISTENTE = 'claude-haiku-5-5';

/** Tope de salida de cada consulta: un chat breve no necesita más. */
export const MAX_TOKENS_DEL_ASISTENTE = 1024;

/** Cada consulta al modelo: 8 s y sin reintentos (§4.1.5). */
export const TIMEOUT_DE_LA_CONSULTA_MS = 8000;

/** Vueltas de herramientas por respuesta; si el modelo sigue pidiendo, se deriva. */
export const VUELTAS_DE_HERRAMIENTAS = 3;

/** Mensajes de la conversación que van como contexto (los últimos). */
export const MENSAJES_DE_CONTEXTO = 12;

/** Valores por omisión de los topes (§6), los de la migración. */
export const RESPUESTAS_POR_CONVERSACION_POR_DEFECTO = 10;
export const TOKENS_POR_MES_POR_DEFECTO = 2_000_000;
export const RANGO_DE_RESPUESTAS_POR_CONVERSACION = {
  min: 1,
  max: 50,
} as const;
export const RANGO_DE_TOKENS_POR_MES = {
  min: 10_000,
  max: 1_000_000_000,
} as const;

/** Lo que hizo el asistente con un mensaje: respondió o pasó la conversación a una persona. */
export enum ResultadoDelAsistente {
  ANSWERED = 'answered',
  HANDED_OFF = 'handed_off',
  /** Se consultó al modelo pero no se publicó (queda la traza con sus tokens). */
  DISCARDED = 'discarded',
}

/**
 * Por qué derivó. El texto del cliente nunca va en la traza: sólo el motivo.
 *
 * - `requested`: el modelo llamó `pasar_a_persona`.
 * - `refusal`, `max_tokens`, `no_text`: la respuesta no sirve para publicar.
 * - `invalid_text`: el texto no cumple las reglas de un mensaje (HTML, largo).
 * - `tool_rounds`: siguió pidiendo herramientas después del tope de vueltas.
 * - `timeout`, `rate_limited`, `api_error`, `unavailable`: la API falló o no está configurada.
 * - `reply_limit`, `monthly_limit`: se pasó un tope (§6); sólo capa fija y derivar.
 * - `unverified_amount`: la respuesta menciona un importe que no salió de una
 *   herramienta en esa misma consulta (defensa contra inventar o inyectar plata).
 * - `not_processed`: el trabajo no corrió; lo derivó el rescate con las fijas.
 */
export enum MotivoDeDerivacion {
  REQUESTED = 'requested',
  REFUSAL = 'refusal',
  MAX_TOKENS = 'max_tokens',
  NO_TEXT = 'no_text',
  INVALID_TEXT = 'invalid_text',
  TOOL_ROUNDS = 'tool_rounds',
  TIMEOUT = 'timeout',
  RATE_LIMITED = 'rate_limited',
  API_ERROR = 'api_error',
  UNAVAILABLE = 'unavailable',
  REPLY_LIMIT = 'reply_limit',
  MONTHLY_LIMIT = 'monthly_limit',
  UNVERIFIED_AMOUNT = 'unverified_amount',
  /**
   * El trabajo del asistente no llegó a correr (el proceso se cayó, no tomó el
   * lock): lo encontró el rescate (`AsistenteIaRescateCron`).
   */
  NOT_PROCESSED = 'not_processed',
}

/**
 * Derivaciones en las que la IA no corrió (tope o falla de la API): salen las
 * respuestas fijas como si el asistente estuviera apagado, y se deriva.
 */
export const DERIVACIONES_SIN_IA: ReadonlySet<MotivoDeDerivacion> = new Set([
  MotivoDeDerivacion.TIMEOUT,
  MotivoDeDerivacion.RATE_LIMITED,
  MotivoDeDerivacion.API_ERROR,
  MotivoDeDerivacion.UNAVAILABLE,
  MotivoDeDerivacion.REPLY_LIMIT,
  MotivoDeDerivacion.MONTHLY_LIMIT,
  MotivoDeDerivacion.NOT_PROCESSED,
]);

/** Cuánto espera el rescate antes de dar por perdido el trabajo de un mensaje. */
export const SEGUNDOS_PARA_RESCATAR = 60;
/** Hasta dónde mira para atrás el rescate (no barre la historia). */
export const HORAS_QUE_MIRA_EL_RESCATE = 24;
/** Mensajes por corrida del rescate. */
export const TOPE_DEL_RESCATE = 100;
/**
 * Mensajes de una misma empresa en un mismo canal (C3 o C1) por corrida del
 * rescate: una empresa con muchos pendientes no ocupa la corrida entera (el
 * resto, en las siguientes).
 */
export const TOPE_DEL_RESCATE_POR_EMPRESA = 20;

/**
 * Por qué se descartó una consulta ya hecha: los de `motivoParaCallarse`
 * (cerrada, mensaje retirado, otro más nuevo, la tomó una persona) y
 * `duplicate` (otro trabajo ya publicó la respuesta a ese mensaje).
 */
export enum MotivoDeDescarte {
  CLOSED = 'closed',
  WITHDRAWN = 'withdrawn',
  SUPERSEDED = 'superseded',
  TAKEN = 'taken',
  DUPLICATE = 'duplicate',
}

export const MOTIVOS_DE_DERIVACION = Object.values(MotivoDeDerivacion);

/** Todo lo que puede ir en `assistant_trace.reason`. */
export const MOTIVOS_DE_LA_TRAZA: readonly string[] = [
  ...MOTIVOS_DE_DERIVACION,
  ...Object.values(MotivoDeDescarte),
];

/** Tokens de una o varias consultas (lo que cobra la API). */
export interface UsoDelModelo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export const SIN_USO: UsoDelModelo = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export function sumarUso(a: UsoDelModelo, b: UsoDelModelo): UsoDelModelo {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/** Lo que cuenta para el tope mensual: todo lo que se procesó (entrada, caché y salida). */
export function tokensQueCuentan(u: UsoDelModelo): number {
  return (
    u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens
  );
}

/** Lo que sale de la consulta al modelo. */
export type RespuestaDelModelo =
  | {
      tipo: 'respuesta';
      texto: string;
      modelo: string;
      uso: UsoDelModelo;
      herramientas: string[];
    }
  | {
      tipo: 'derivar';
      motivo: MotivoDeDerivacion;
      modelo: string | null;
      uso: UsoDelModelo;
      herramientas: string[];
    };

/** Largo máximo de un mensaje (CHECK `CHK_message_texto`). */
export const LARGO_MAXIMO_DEL_MENSAJE = 2000;

const ETIQUETA_O_ENTIDAD_HTML = /<[A-Za-z/!?]|&[A-Za-z#]/;

/**
 * Deja la respuesta del modelo como texto plano para el chat: sin el énfasis
 * de Markdown (`**`, `__`), sin espacios de los bordes ni saltos de más.
 * `null` si queda vacía, trae HTML o se pasa del largo de un mensaje: en esos
 * casos se deriva (nunca se publica HTML, §5).
 */
export function textoPublicable(crudo: string): string | null {
  const texto = crudo
    .replace(/\*\*|__/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (texto.length === 0) return null;
  if (ETIQUETA_O_ENTIDAD_HTML.test(texto)) return null;
  if ([...texto].length > LARGO_MAXIMO_DEL_MENSAJE) return null;
  return texto;
}

/** Lo que decide si el asistente contesta un mensaje (§2, §4.1.1, §6). */
export interface SituacionDelAsistente {
  /** C3: módulo habilitado e interruptor de la empresa; C1: interruptor de la plataforma. */
  activo: boolean;
  conversacionAbierta: boolean;
  /** Alguien la tomó: el asistente se calla. */
  personaAsignada: boolean;
  /** Ya derivó y espera a una persona: no vuelve a contestar. */
  esperandoPersona: boolean;
  /** Después del mensaje ya escribió alguien del equipo o el asistente (otro trabajo lo atendió). */
  yaRespondido: boolean;
  /** Llegó un mensaje más nuevo de la misma punta: lo contesta su propio trabajo. */
  hayUnoMasNuevo: boolean;
}

/** `true` si el asistente tiene que atender el mensaje. */
export function correspondeAtender(s: SituacionDelAsistente): boolean {
  return (
    s.activo &&
    s.conversacionAbierta &&
    !s.personaAsignada &&
    !s.esperandoPersona &&
    !s.yaRespondido &&
    !s.hayUnoMasNuevo
  );
}

/** Topes del asistente (§6). */
export interface TopesDelAsistente {
  respuestasPorConversacion: number;
  /** Tokens del mes: los de la empresa con sus clientes (C3) o los de todo el soporte (C1). */
  tokensPorMes: number;
  /**
   * Sólo en el soporte (C1): el cupo de cada empresa dentro del total de la
   * plataforma, para que una empresa no se lo gaste a las demás. `null` en C3.
   */
  tokensPorMesPorEmpresa: number | null;
}

/** Tokens del mes que cuentan para los topes. */
export interface TokensDelMes {
  /** Los de la empresa en C3; los de todo el soporte en C1. */
  total: number;
  /** En C1, los de la empresa que pregunta; 0 en C3 (ya es `total`). */
  deLaEmpresa: number;
}

/** El tope que se pasó, si alguno: al pasarlo sólo queda la capa fija y derivar. */
export function topeAlcanzado(
  topes: TopesDelAsistente,
  respuestasEnLaConversacion: number,
  tokensDelMes: TokensDelMes,
): MotivoDeDerivacion | null {
  if (respuestasEnLaConversacion >= topes.respuestasPorConversacion) {
    return MotivoDeDerivacion.REPLY_LIMIT;
  }
  if (tokensDelMes.total >= topes.tokensPorMes) {
    return MotivoDeDerivacion.MONTHLY_LIMIT;
  }
  if (
    topes.tokensPorMesPorEmpresa !== null &&
    tokensDelMes.deLaEmpresa >= topes.tokensPorMesPorEmpresa
  ) {
    return MotivoDeDerivacion.MONTHLY_LIMIT;
  }
  return null;
}

const IMPORTE_CON_SIGNO = /\$\s*(\d[\d.,]*)/g;
const IMPORTE_EN_PESOS = /(\d[\d.,]*)\s*(?:pesos|ARS)\b/gi;
const MILES_CON_PUNTO = /^\d{1,3}(\.\d{3})+$/;

/**
 * Un número escrito como en Argentina («12.345,50», «15.000», «1500») a su
 * forma canónica con dos decimales («12345.50»); `null` si no es un número.
 */
export function importeCanonico(crudo: string): string | null {
  let n = crudo.replace(/[.,]+$/, '');
  if (n.includes(',')) n = n.replace(/\./g, '').replace(',', '.');
  else if (MILES_CON_PUNTO.test(n)) n = n.replace(/\./g, '');
  if (!/^\d+(\.\d+)?$/.test(n)) return null;
  const [entero, decimales = ''] = n.split('.');
  return `${BigInt(entero).toString()}.${(decimales + '00').slice(0, 2)}`;
}

/** Los importes de plata que menciona un texto («$ 1.500», «1500 pesos»), canónicos. */
export function importesDelTexto(texto: string): string[] {
  const importes: string[] = [];
  for (const regla of [IMPORTE_CON_SIGNO, IMPORTE_EN_PESOS]) {
    for (const m of texto.matchAll(regla)) {
      const canonico = importeCanonico(m[1]);
      if (canonico !== null) importes.push(canonico);
    }
  }
  return importes;
}

/**
 * Los importes que menciona la respuesta y que NO salieron de los datos que
 * devolvieron las herramientas en esa misma consulta. Si hay alguno, no se
 * publica: se deriva (la plata la calcula el back, §4.2).
 */
export function importesNoVerificados(
  respuesta: string,
  datosDeLasHerramientas: readonly string[],
): string[] {
  const permitidos = new Set(datosDeLasHerramientas.flatMap(importesDelTexto));
  return importesDelTexto(respuesta).filter((i) => !permitidos.has(i));
}
