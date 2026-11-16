import {
  CalificacionAnuladaError,
  CalificacionNoDisponibleError,
  CalificacionVencidaError,
  CalificacionYaRespondidaError,
} from './chat.errors';

/**
 * Encuesta de satisfacción al cerrar una conversación con un cliente (4b).
 * Puras: sin base ni Nest.
 *
 * Escala de 1 a 5 con botones: es la de Zendesk e Intercom, la misma que va a
 * leer el tablero (B4) para comparar al asistente con el equipo, y un 4 o 5 se
 * lee como «satisfecho» (CSAT = % de 4 y 5). Tres caritas alcanzan para el
 * cliente pero pierden matiz para el tablero; con cinco botones el toque sigue
 * siendo uno solo.
 */
export const ESCALA_DE_LA_ENCUESTA = 5;

/** La encuesta vence a las 48 h de pedida. */
export const HORAS_PARA_RESPONDER = 48;

/** Largo del comentario opcional. */
export const LARGO_DEL_COMENTARIO = 280;

/** Texto por omisión del pedido de calificación (con variables). */
export const ENCUESTA_POR_DEFECTO =
  '¿Cómo te atendimos en {{empresa.nombre}}? Tocá de 1 a 5 para calificar la conversación.';

/** Quién atendió la conversación que se califica (para el CSAT del asistente contra el del equipo). */
export type QuienAtendio = 'assistant' | 'team' | 'none';

/** Alguien del equipo escribió algo visible: lo atendió el equipo; si no, el asistente con IA; si no, nadie. */
export function quienAtendio(
  equipoEscribio: boolean,
  asistenteRespondio: boolean,
): QuienAtendio {
  if (equipoEscribio) return 'team';
  return asistenteRespondio ? 'assistant' : 'none';
}

export function venceLaEncuesta(pedida: Date): Date {
  return new Date(pedida.getTime() + HORAS_PARA_RESPONDER * 3_600_000);
}

/** Lo que importa de una encuesta para responderla. */
export interface EncuestaPedida {
  score: number | null;
  comment: string | null;
  answeredAt: Date | null;
  /** Se anuló al reabrir la conversación: ese cierre ya no se califica. */
  cancelledAt: Date | null;
  expiresAt: Date;
}

/** La respuesta del cliente. */
export interface RespuestaALaEncuesta {
  score: number;
  comment: string | null;
}

/**
 * Se responde ESA encuesta una sola vez, con la conversación cerrada y antes
 * de que venza. Sin encuesta (o de otra conversación o persona) → 404;
 * anulada (se reabrió la conversación) → 409; vencida → 409. Ya respondida:
 * la misma respuesta es un reintento (`'repetida'`, 200); otra → 409.
 */
export function respuestaALaEncuesta(
  e: EncuestaPedida | null,
  respuesta: RespuestaALaEncuesta,
  conversacionAbierta: boolean,
  ahora: Date,
): 'nueva' | 'repetida' {
  if (!e) throw new CalificacionNoDisponibleError();
  if (e.answeredAt) {
    if (e.score === respuesta.score && e.comment === respuesta.comment) {
      return 'repetida';
    }
    throw new CalificacionYaRespondidaError();
  }
  if (e.cancelledAt || conversacionAbierta) {
    throw new CalificacionAnuladaError();
  }
  if (ahora.getTime() > e.expiresAt.getTime()) {
    throw new CalificacionVencidaError(HORAS_PARA_RESPONDER);
  }
  return 'nueva';
}

export type EstadoDeLaEncuesta =
  | 'answered'
  | 'pending'
  | 'expired'
  | 'cancelled';

/** El estado de una encuesta para mostrarla. */
export function estadoDeLaEncuesta(
  e: Pick<EncuestaPedida, 'answeredAt' | 'cancelledAt' | 'expiresAt'>,
  ahora: Date,
): EstadoDeLaEncuesta {
  if (e.answeredAt) return 'answered';
  if (e.cancelledAt) return 'cancelled';
  return ahora.getTime() > e.expiresAt.getTime() ? 'expired' : 'pending';
}
