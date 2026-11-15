import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  Channel,
  ConversationStatus,
  Party,
  SubjectType,
} from '../domain/chat.enums';
import { ConversationParty } from '../entities/conversation-party.entity';
import { Conversation } from '../entities/conversation.entity';

export interface NuevaConversacion {
  distributorId: string;
  channel: Channel;
  /** Asunto del ticket (sólo en su hilo). */
  subject: string | null;
  createdByUserId: string | null;
  /** Quién de la plataforma la atiende (sólo el chat). */
  assignedToUserId?: string | null;
}

/**
 * Crea una conversación con sus partes, dentro de la transacción de quien
 * llama. En C1 las partes son siempre los dos equipos (la base lo controla al
 * confirmar con `TRG_conversation_partes`).
 */
@Injectable()
export class ConversationFactory {
  async crear(
    manager: EntityManager,
    nueva: NuevaConversacion,
  ): Promise<Conversation> {
    const repo = manager.getRepository(Conversation);
    const conversacion = await repo.save(
      repo.create({
        distributorId: nueva.distributorId,
        channel: nueva.channel,
        subjectType:
          nueva.channel === Channel.PLATFORM_TICKET
            ? SubjectType.TICKET
            : SubjectType.GENERAL,
        status: ConversationStatus.OPEN,
        subject: nueva.subject,
        assignedToUserId:
          nueva.channel === Channel.PLATFORM_CHAT
            ? (nueva.assignedToUserId ?? null)
            : null,
        lastMessageSeq: 0,
        lastMessageAt: null,
        lastMessagePreview: null,
        firstResponseAt: null,
        closedAt: null,
        closedByUserId: null,
        closedReason: null,
        createdByUserId: nueva.createdByUserId,
      }),
    );
    const partes = manager.getRepository(ConversationParty);
    await partes.save(
      [Party.PLATFORM, Party.COMPANY].map((party) =>
        partes.create({
          conversationId: conversacion.conversationId,
          party: party as Party.PLATFORM | Party.COMPANY,
          distributorId: nueva.distributorId,
          userId: null,
          lastReadSeq: 0,
          lastDeliveredSeq: 0,
          mutedUntil: null,
          restrictedAt: null,
        }),
      ),
    );
    return conversacion;
  }
}
