import type { EntityManager } from 'typeorm';
import type {
  MessageKind,
  MessageVisibility,
  Party,
  SystemCode,
} from '../domain/chat.enums';
import type { Conversation } from '../entities/conversation.entity';
import type { Message, PayloadDelMensaje } from '../entities/message.entity';

/** Lo que hace falta para escribir un mensaje en una conversación. */
export interface NuevoMensaje {
  conversationId: string;
  distributorId: string;
  senderParty: Party;
  /** Nulo: el sistema. */
  senderUserId: string | null;
  /** Idempotencia: el mismo id del mismo autor en la misma conversación es el mismo mensaje. */
  clientMessageId: string | null;
  kind: MessageKind;
  visibility: MessageVisibility;
  body: string | null;
  payload: PayloadDelMensaje | null;
  systemCode: SystemCode | null;
  templateKey: string | null;
}

/**
 * Puerto de persistencia del envío (§7.4). Separado para poder probar la
 * asignación del `seq` y la idempotencia con concurrencia simulada.
 */
export abstract class MensajesRepositorio {
  /** La conversación con la fila bloqueada (`FOR UPDATE`), o `null` si no es de esa empresa. */
  abstract bloquearConversacion(
    manager: EntityManager,
    conversationId: string,
    distributorId: string,
  ): Promise<Conversation | null>;

  /** El mensaje ya escrito con ese `clientMessageId`, si existe. */
  abstract buscarPorClientId(
    manager: EntityManager,
    conversationId: string,
    senderUserId: string,
    clientMessageId: string,
  ): Promise<Message | null>;

  /**
   * Suma uno al contador de la conversación (bloqueada por quien llama) y
   * devuelve el número asignado. La vista previa sólo cambia si viene.
   */
  abstract siguienteSeq(
    manager: EntityManager,
    conversation: Conversation,
    vistaPrevia: string | null,
  ): Promise<number>;

  abstract insertar(
    manager: EntityManager,
    mensaje: NuevoMensaje & { seq: number },
  ): Promise<Message>;
}
