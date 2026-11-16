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
  /** Responde a otro mensaje de la misma conversación (D-C25; sólo en la bandeja). */
  replyToSeq?: number | null;
  /** La vista previa del citado, congelada al citarlo (la completa el envío). */
  replyToPreview?: string | null;
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
   * devuelve el número asignado. La vista previa sólo cambia si viene. Una
   * nota interna (`visible` falso) no mueve `last_message_at` ni `updated_at`:
   * la otra punta no ve la conversación subir en su lista ni volver en su
   * `updatedSince` por algo que no puede leer. El panel se entera de la nota
   * por el socket y por `afterSeq`.
   */
  abstract siguienteSeq(
    manager: EntityManager,
    conversation: Conversation,
    vistaPrevia: string | null,
    visible?: boolean,
  ): Promise<number>;

  /** Un mensaje de la conversación por su número (para la vista previa de la cita). */
  abstract mensajePorSeq(
    manager: EntityManager,
    conversationId: string,
    seq: number,
  ): Promise<Message | null>;

  abstract insertar(
    manager: EntityManager,
    mensaje: NuevoMensaje & { seq: number },
  ): Promise<Message>;
}
