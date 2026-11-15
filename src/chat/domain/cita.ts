import { MessageKind, MessageVisibility, Party } from './chat.enums';
import { CitaInvalidaError } from './chat.errors';

/** Tope de mensajes de una cita del chat en un ticket (§6.12). */
export const MAXIMO_DE_MENSAJES_CITADOS = 200;

/**
 * El rango elegido del chat tiene que existir, estar en orden y no pasar de
 * 200 mensajes. `ultimoSeq` es el último número asignado en el chat.
 */
export function assertRangoValido(
  desde: number,
  hasta: number,
  ultimoSeq: number,
): void {
  const valido =
    Number.isInteger(desde) &&
    Number.isInteger(hasta) &&
    desde >= 1 &&
    desde <= hasta &&
    hasta <= ultimoSeq &&
    hasta - desde + 1 <= MAXIMO_DE_MENSAJES_CITADOS;
  if (!valido) throw new CitaInvalidaError();
}

/** Lo que se copia de cada mensaje citado. */
export interface MensajeACitar {
  messageId: string;
  seq: number;
  party: Party;
  kind: MessageKind;
  visibility: MessageVisibility;
  body: string | null;
  createdAt: Date;
  redacted: boolean;
}

export interface RenglonDeCita {
  seq: number;
  party: Party;
  body: string | null;
  at: string;
}

/** Copia congelada del rango (`kind = 'quoted_excerpt'`, D-C21). */
export interface PayloadDeCita {
  sourceConversationId: string;
  fromSeq: number;
  toSeq: number;
  items: RenglonDeCita[];
}

/**
 * Arma la cita: sólo lo que la otra punta podía ver (nunca una nota interna),
 * en orden de `seq`. El texto de un mensaje redactado queda en `null`. Si no
 * queda ningún mensaje que citar, el rango no sirve.
 */
export function armarCita(
  conversacionDeOrigen: string,
  desde: number,
  hasta: number,
  mensajes: readonly MensajeACitar[],
): { payload: PayloadDeCita; citados: string[] } {
  const elegidos = mensajes
    .filter((m) => m.seq >= desde && m.seq <= hasta)
    .filter((m) => m.visibility === MessageVisibility.ALL)
    .sort((a, b) => a.seq - b.seq);
  if (elegidos.length === 0) throw new CitaInvalidaError();
  return {
    payload: {
      sourceConversationId: conversacionDeOrigen,
      fromSeq: desde,
      toSeq: hasta,
      items: elegidos.map((m) => ({
        seq: m.seq,
        party: m.party,
        body: m.redacted ? null : m.body,
        at: m.createdAt.toISOString(),
      })),
    },
    citados: elegidos.map((m) => m.messageId),
  };
}

/**
 * Cuándo respondió la plataforma dentro de lo citado (el primer mensaje suyo):
 * un ticket abierto desde un chat ya atendido registra esa primera respuesta.
 */
export function primeraRespuestaEnLaCita(
  mensajes: readonly MensajeACitar[],
  desde: number,
  hasta: number,
): Date | null {
  const dePlataforma = mensajes
    .filter(
      (m) =>
        m.seq >= desde &&
        m.seq <= hasta &&
        m.party === Party.PLATFORM &&
        m.visibility === MessageVisibility.ALL,
    )
    .sort((a, b) => a.seq - b.seq);
  return dePlataforma[0]?.createdAt ?? null;
}
