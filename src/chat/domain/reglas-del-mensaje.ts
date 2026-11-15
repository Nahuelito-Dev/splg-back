import { Channel, MessageKind, MessageVisibility, Party } from './chat.enums';
import { CitaInvalidaError, NotaInternaNoPermitidaError } from './chat.errors';

/** Lo que importa de un mensaje para decidir si el canal lo admite. */
export interface MensajeAValidar {
  party: Party;
  kind: MessageKind;
  visibility: MessageVisibility;
}

/**
 * Reglas del mensaje según el canal (también en la base: CHECK y trigger de
 * `message`). Las notas internas sólo las deja la plataforma y sólo en el hilo
 * de un ticket (D-C8); la cita de mensajes sólo va en un ticket.
 */
export function assertMensajeAdmitido(
  canal: Channel,
  mensaje: MensajeAValidar,
): void {
  if (mensaje.visibility === MessageVisibility.INTERNAL) {
    const admitida =
      canal === Channel.PLATFORM_TICKET && mensaje.party === Party.PLATFORM;
    if (!admitida) throw new NotaInternaNoPermitidaError();
  }
  if (
    mensaje.kind === MessageKind.QUOTED_EXCERPT &&
    canal !== Channel.PLATFORM_TICKET
  ) {
    throw new CitaInvalidaError();
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
