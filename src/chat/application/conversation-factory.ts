import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  Channel,
  ConversationStatus,
  esCanalDeLaBandeja,
  Party,
  type PartyQueHabla,
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
  /** Quién la atiende (el chat con la plataforma y la bandeja). */
  assignedToUserId?: string | null;
  /** Bandeja: general o por pedido (con `orderId`). Por omisión, general. */
  subjectType?: SubjectType.GENERAL | SubjectType.ORDER;
  orderId?: string | null;
  /** La persona de la bandeja: el cliente (C3) o el chofer (C2). */
  customerUserId?: string | null;
  driverUserId?: string | null;
}

/** Las partes de cada canal: los dos equipos en C1; la empresa y la persona en la bandeja. */
function partesDe(
  nueva: NuevaConversacion,
): Array<{ party: PartyQueHabla; userId: string | null }> {
  switch (nueva.channel) {
    case Channel.STAFF_CUSTOMER:
      return [
        { party: Party.COMPANY, userId: null },
        { party: Party.CUSTOMER, userId: nueva.customerUserId ?? null },
      ];
    case Channel.STAFF_DRIVER:
      return [
        { party: Party.COMPANY, userId: null },
        { party: Party.DRIVER, userId: nueva.driverUserId ?? null },
      ];
    default:
      return [
        { party: Party.PLATFORM, userId: null },
        { party: Party.COMPANY, userId: null },
      ];
  }
}

/**
 * Crea una conversación con sus partes, dentro de la transacción de quien
 * llama. En C1 las partes son los dos equipos; en la bandeja, la empresa y la
 * persona (la base lo controla al confirmar con `TRG_conversation_partes`).
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
            : (nueva.subjectType ?? SubjectType.GENERAL),
        status: ConversationStatus.OPEN,
        subject: nueva.subject,
        orderId: nueva.orderId ?? null,
        customerUserId: nueva.customerUserId ?? null,
        driverUserId: nueva.driverUserId ?? null,
        linkedClaimId: null,
        assignedToUserId:
          nueva.channel === Channel.PLATFORM_CHAT ||
          esCanalDeLaBandeja(nueva.channel)
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
      partesDe(nueva).map(({ party, userId }) =>
        partes.create({
          conversationId: conversacion.conversationId,
          party,
          distributorId: nueva.distributorId,
          userId,
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
