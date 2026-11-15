import { Channel, ConversationStatus, MessageKind, Party } from './chat.enums';

/**
 * Cuándo se encarga el asistente con IA de un mensaje (DISENO-CH-BOT §4.1.1,
 * B3). Es la misma regla para el envío (que no manda las respuestas fijas si
 * la IA se encarga) y para el asistente (que vuelve a mirarla antes de
 * consultar y antes de publicar). Se decide sobre las filas del hilo, no con
 * condiciones sueltas en SQL.
 */

/** Si alguien del equipo escribió hace menos que esto, el asistente se calla. */
export const MINUTOS_DE_SILENCIO_TRAS_UNA_PERSONA = 120;

/** Quién pregunta y quién atiende en cada canal del asistente (C3 y C1). */
export interface PuntasDelAsistente {
  pregunta: Party;
  atiende: Party;
}

const PUNTAS: Partial<Record<Channel, PuntasDelAsistente>> = {
  [Channel.STAFF_CUSTOMER]: {
    pregunta: Party.CUSTOMER,
    atiende: Party.COMPANY,
  },
  [Channel.PLATFORM_CHAT]: { pregunta: Party.COMPANY, atiende: Party.PLATFORM },
};

/** `null`: un canal donde el asistente nunca contesta (C2, C4, tickets). */
export function puntasDelAsistente(canal: Channel): PuntasDelAsistente | null {
  return PUNTAS[canal] ?? null;
}

/** Lo que importa de cada mensaje del hilo (nunca el texto). */
export interface FilaDelHilo {
  seq: number;
  messageId: string;
  senderParty: Party;
  kind: MessageKind;
  /** Lo mandó el asistente con IA (`payload.ai`). */
  deLaIa: boolean;
  createdAt: Date;
  /** Retirado por su autor, redactado o dado de baja. */
  retirado: boolean;
}

/** Lo que importa de la conversación. */
export interface ConversacionDelAsistente {
  status: ConversationStatus;
  assignedToUserId: string | null;
  awaitingHumanSince: Date | null;
}

/** Por qué el asistente no atiende (o descarta lo que ya consultó). */
export type MotivoParaCallarse =
  /** La conversación se cerró. */
  | 'closed'
  /** El mensaje que lo disparó se retiró o se borró. */
  | 'withdrawn'
  /** Llegó otro mensaje de la misma punta: lo atiende su propio trabajo. */
  | 'superseded'
  /** La atiende una persona: asignada, esperando persona, alguien del equipo escribió hace poco o ya se contestó. */
  | 'taken';

/**
 * `null` si el asistente tiene que atender el mensaje `disparador`; si no, por
 * qué se calla. `filas` son las del hilo desde el disparador más las de las
 * últimas horas (en cualquier orden).
 */
export function motivoParaCallarse(
  c: ConversacionDelAsistente,
  filas: readonly FilaDelHilo[],
  disparador: { seq: number; messageId: string },
  puntas: PuntasDelAsistente,
  ahora: Date,
): MotivoParaCallarse | null {
  if (c.status !== ConversationStatus.OPEN) return 'closed';
  const propio = filas.find((f) => f.messageId === disparador.messageId);
  if (!propio || propio.retirado) return 'withdrawn';
  const despues = filas.filter((f) => f.seq > disparador.seq);
  if (
    despues.some(
      (f) =>
        f.senderParty === puntas.pregunta &&
        f.kind === MessageKind.TEXT &&
        !f.retirado,
    )
  ) {
    return 'superseded';
  }
  const limite =
    ahora.getTime() - MINUTOS_DE_SILENCIO_TRAS_UNA_PERSONA * 60_000;
  const personaReciente = filas.some(
    (f) =>
      f.senderParty === puntas.atiende &&
      f.kind === MessageKind.TEXT &&
      f.createdAt.getTime() >= limite,
  );
  const yaContestado = despues.some(
    (f) =>
      f.senderParty === puntas.atiende ||
      (f.senderParty === Party.SYSTEM &&
        f.kind === MessageKind.AUTO_REPLY &&
        f.deLaIa),
  );
  if (
    Boolean(c.assignedToUserId) ||
    Boolean(c.awaitingHumanSince) ||
    personaReciente ||
    yaContestado
  ) {
    return 'taken';
  }
  return null;
}
