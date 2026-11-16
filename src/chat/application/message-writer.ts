import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  ConversationStatus,
  esCanalDeLaBandeja,
  MessageVisibility,
} from '../domain/chat.enums';
import {
  ConversacionCerradaError,
  ConversacionNoEncontradaError,
  RespuestaInvalidaError,
} from '../domain/chat.errors';
import {
  assertMensajeAdmitido,
  vistaPreviaDelMensaje,
} from '../domain/reglas-del-mensaje';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import { MensajesRepositorio, NuevoMensaje } from './mensajes.port';

/** Resultado de un envío: `created` falso si era un reintento con el mismo `clientMessageId`. */
export interface MensajeEscrito {
  message: Message;
  created: boolean;
  conversation: Conversation;
}

/**
 * El único camino para escribir un mensaje (diseño §7.4), dentro de la
 * transacción de quien llama:
 *
 *  1. Bloquea la conversación (`FOR UPDATE`): dos envíos simultáneos a la
 *     misma conversación se ordenan.
 *  2. Si ese autor ya mandó ese `clientMessageId`, devuelve el mismo mensaje
 *     sin gastar un número (también si la conversación ya se cerró).
 *  3. Conversación cerrada → 409.
 *  4. Si responde a otro mensaje, que sea de esta conversación (D-C25) y,
 *     si lo ve la otra punta, que no sea una nota interna.
 *  5. Suma uno al contador y escribe el mensaje con ese número. Si la
 *     transacción se revierte, el contador vuelve atrás con ella: no quedan
 *     huecos.
 *
 * La emisión por el socket la hace quien llama, después del commit.
 */
@Injectable()
export class MessageWriter {
  constructor(private readonly repo: MensajesRepositorio) {}

  async escribir(
    manager: EntityManager,
    nuevo: NuevoMensaje,
  ): Promise<MensajeEscrito> {
    const conversation = await this.repo.bloquearConversacion(
      manager,
      nuevo.conversationId,
      nuevo.distributorId,
    );
    if (!conversation) throw new ConversacionNoEncontradaError();

    if (nuevo.clientMessageId && nuevo.senderUserId) {
      const existente = await this.repo.buscarPorClientId(
        manager,
        conversation.conversationId,
        nuevo.senderUserId,
        nuevo.clientMessageId,
      );
      if (existente) {
        return { message: existente, created: false, conversation };
      }
    }

    if (conversation.status !== ConversationStatus.OPEN) {
      throw new ConversacionCerradaError();
    }
    assertMensajeAdmitido(conversation.channel, {
      party: nuevo.senderParty,
      kind: nuevo.kind,
      visibility: nuevo.visibility,
    });
    // Los números no tienen huecos: hasta el último, todos existen.
    if (
      nuevo.replyToSeq != null &&
      (!esCanalDeLaBandeja(conversation.channel) ||
        nuevo.replyToSeq > conversation.lastMessageSeq)
    ) {
      throw new RespuestaInvalidaError();
    }
    // La cita congela la vista previa del citado (no cambia si se redacta).
    let replyToPreview: string | null = null;
    if (nuevo.replyToSeq != null) {
      const citado = await this.repo.mensajePorSeq(
        manager,
        conversation.conversationId,
        nuevo.replyToSeq,
      );
      // Un mensaje que ve la otra punta no responde a una nota interna: la
      // delataría (su número y que la escribió la empresa).
      if (
        citado?.visibility === MessageVisibility.INTERNAL &&
        nuevo.visibility === MessageVisibility.ALL
      ) {
        throw new RespuestaInvalidaError();
      }
      replyToPreview =
        citado && !citado.withdrawnAt && !citado.redactedAt
          ? vistaPreviaDelMensaje(citado)
          : null;
    }

    const visible = nuevo.visibility === MessageVisibility.ALL;
    const seq = await this.repo.siguienteSeq(
      manager,
      conversation,
      vistaPreviaDelMensaje(nuevo),
      visible,
    );
    const message = await this.repo.insertar(manager, {
      ...nuevo,
      replyToPreview,
      seq,
    });
    conversation.lastMessageSeq = seq;
    if (visible) conversation.lastMessageAt = message.createdAt;
    return { message, created: true, conversation };
  }
}
