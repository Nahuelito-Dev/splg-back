import { medioDelMensaje, vistaPreviaDelAdjunto } from './adjuntos';
import {
  Channel,
  esCanalDeLaBandeja,
  MessageKind,
  MessageVisibility,
  Party,
} from './chat.enums';
import {
  CitaInvalidaError,
  NotaInternaNoPermitidaError,
  PuntaFueraDeSuCanalError,
} from './chat.errors';

/** Lo que importa de un mensaje para decidir si el canal lo admite. */
export interface MensajeAValidar {
  party: Party;
  kind: MessageKind;
  visibility: MessageVisibility;
}

/**
 * Nota interna admitida (también `CHK_message_visibilidad` y el trigger
 * `TRG_message_canal`): la plataforma en el hilo de un ticket (D-C8); en la
 * bandeja de la empresa (C3, C2), el texto del personal y la nota de
 * derivación del asistente con IA (mensaje de sistema `handoff_note`, sólo C3).
 */
export function notaInternaAdmitida(
  canal: Channel,
  mensaje: Pick<MensajeAValidar, 'party' | 'kind'>,
): boolean {
  if (canal === Channel.PLATFORM_TICKET) {
    return (
      mensaje.party === Party.PLATFORM && mensaje.kind === MessageKind.TEXT
    );
  }
  if (!esCanalDeLaBandeja(canal)) return false;
  if (mensaje.party === Party.COMPANY) return mensaje.kind === MessageKind.TEXT;
  return (
    canal === Channel.STAFF_CUSTOMER &&
    mensaje.party === Party.SYSTEM &&
    mensaje.kind === MessageKind.SYSTEM
  );
}

/**
 * Quién ve las notas internas de un canal: la plataforma las de sus tickets;
 * el personal de la empresa las de su bandeja. Nunca el cliente ni el chofer,
 * ni la empresa las de la plataforma.
 */
export function veNotasInternas(party: Party, canal: Channel): boolean {
  if (party === Party.PLATFORM) return true;
  return party === Party.COMPANY && esCanalDeLaBandeja(canal);
}

/**
 * Reglas del mensaje según el canal (también en la base: CHECK y trigger de
 * `message`). Las notas internas, las de `notaInternaAdmitida`; la cita de
 * mensajes sólo va en un ticket.
 */
export function assertMensajeAdmitido(
  canal: Channel,
  mensaje: MensajeAValidar,
): void {
  if (!puntaEscribeEnElCanal(canal, mensaje.party)) {
    throw new PuntaFueraDeSuCanalError();
  }
  if (
    mensaje.visibility === MessageVisibility.INTERNAL &&
    !notaInternaAdmitida(canal, mensaje)
  ) {
    throw new NotaInternaNoPermitidaError();
  }
  if (
    mensaje.kind === MessageKind.QUOTED_EXCERPT &&
    canal !== Channel.PLATFORM_TICKET
  ) {
    throw new CitaInvalidaError();
  }
}

/**
 * Quién escribe en cada canal (también el trigger `TRG_message_canal`): la
 * empresa y el sistema en todos; la plataforma sólo en C1; el cliente sólo con
 * la empresa (C3) y el chofer sólo con la empresa (C2).
 */
export function puntaEscribeEnElCanal(canal: Channel, party: Party): boolean {
  switch (party) {
    case Party.COMPANY:
    case Party.SYSTEM:
      return true;
    case Party.PLATFORM:
      return (
        canal === Channel.PLATFORM_CHAT || canal === Channel.PLATFORM_TICKET
      );
    case Party.CUSTOMER:
      return canal === Channel.STAFF_CUSTOMER;
    case Party.DRIVER:
      return canal === Channel.STAFF_DRIVER;
  }
}

/** Largo de la vista previa que se guarda en la conversación. */
export const LARGO_DE_LA_VISTA_PREVIA = 140;

/**
 * Vista previa para la bandeja: nunca de una nota interna (la otra punta la
 * vería), y nada para lo que no tiene texto.
 */
export function vistaPrevia(
  body: string | null,
  visibility: MessageVisibility,
): string | null {
  if (visibility !== MessageVisibility.ALL || body === null) return null;
  const limpio = body.replace(/\s+/g, ' ').trim();
  if (limpio.length <= LARGO_DE_LA_VISTA_PREVIA) return limpio;
  return `${limpio.slice(0, LARGO_DE_LA_VISTA_PREVIA - 1)}…`;
}

/**
 * Vista previa de un mensaje: la de su texto o, si es un adjunto, «📎 Foto» o
 * «📎 Archivo» (§9.4: el epígrafe no se muestra en la lista). Nunca de una
 * nota interna.
 */
export function vistaPreviaDelMensaje(m: {
  kind: MessageKind;
  body: string | null;
  visibility: MessageVisibility;
  payload: unknown;
}): string | null {
  const medio = medioDelMensaje(m);
  if (medio === null) return vistaPrevia(m.body, m.visibility);
  return m.visibility === MessageVisibility.ALL
    ? vistaPreviaDelAdjunto(medio)
    : null;
}
