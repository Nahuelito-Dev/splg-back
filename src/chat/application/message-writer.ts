import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ConversationStatus } from '../domain/chat.enums';
import {
  ConversacionCerradaError,
  ConversacionNoEncontradaError,
} from '../domain/chat.errors';
import {
  assertMensajeAdmitido,
  vistaPrevia,
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
 *  4. Suma uno al contador y escribe el mensaje con ese número. Si la
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

    const seq = await this.repo.siguienteSeq(
      manager,
      conversation,
      vistaPrevia(nuevo.body, nuevo.visibility),
    );
    const message = await this.repo.insertar(manager, { ...nuevo, seq });
    conversation.lastMessageSeq = seq;
    conversation.lastMessageAt = message.createdAt;
    return { message, created: true, conversation };
  }
}
