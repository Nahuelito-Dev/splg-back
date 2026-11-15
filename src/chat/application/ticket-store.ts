import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SECUENCIA_DE_TICKETS } from '../../migrations/sql/mensajeria';
import {
  Channel,
  MessageVisibility,
  Party,
  type PartyDeC1,
} from '../domain/chat.enums';
import { TicketNoEncontradoError } from '../domain/chat.errors';
import type { MensajeACitar } from '../domain/cita';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { SupportTicketMessageLink } from '../entities/support-ticket-message-link.entity';
import { SupportTicket } from '../entities/support-ticket.entity';

/** Quién opera sobre un ticket: su punta, su usuario y, si es la empresa, cuál. */
export interface ActorDeTicket {
  party: PartyDeC1;
  userId: string;
  /** La empresa de quien pide; nula para la plataforma (ve todas). */
  distributorId: string | null;
}

/**
 * El ticket con la fila bloqueada, dentro de la transacción de quien lo va a
 * cambiar. De otra empresa (o inexistente) es 404. Se bloquea siempre el
 * ticket antes que su hilo, así dos operaciones no se cruzan.
 */
export async function bloquearTicket(
  manager: EntityManager,
  ticketId: string,
  distributorId: string | null,
): Promise<SupportTicket> {
  const t = await manager.getRepository(SupportTicket).findOne({
    where: distributorId ? { ticketId, distributorId } : { ticketId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!t) throw new TicketNoEncontradoError();
  return t;
}

/** El próximo número de ticket (secuencia global de la plataforma). */
export async function siguienteNumero(manager: EntityManager): Promise<number> {
  const [fila]: Array<{ n: string }> = await manager.query(
    `SELECT nextval('"${SECUENCIA_DE_TICKETS}"') AS n`,
  );
  return Number(fila.n);
}

/** El chat de una empresa con la fila bloqueada; 404 si es de otra o no es un chat. */
export async function bloquearChatDeLaEmpresa(
  manager: EntityManager,
  chatId: string,
  distributorId: string | null,
): Promise<Conversation> {
  const c = await manager.getRepository(Conversation).findOne({
    where: {
      conversationId: chatId,
      channel: Channel.PLATFORM_CHAT,
      ...(distributorId ? { distributorId } : {}),
    },
    lock: { mode: 'pessimistic_write' },
  });
  if (!c) throw new NotFoundException('No existe ese chat');
  return c;
}

/** Los mensajes del rango, listos para citar. */
export async function mensajesACitar(
  manager: EntityManager,
  chat: Conversation,
  desde: number,
  hasta: number,
): Promise<{ aCitar: MensajeACitar[]; porId: Map<string, Message> }> {
  const filas = await manager
    .getRepository(Message)
    .createQueryBuilder('m')
    .where('m.conversationId = :id', { id: chat.conversationId })
    .andWhere('m.distributorId = :dist', { dist: chat.distributorId })
    .andWhere('m.seq BETWEEN :desde AND :hasta', { desde, hasta })
    .orderBy('m.seq', 'ASC')
    .getMany();
  return {
    aCitar: filas.map((m) => ({
      messageId: m.messageId,
      seq: m.seq,
      party: m.senderParty,
      kind: m.kind,
      visibility: m.visibility ?? MessageVisibility.ALL,
      body: m.body,
      createdAt: m.createdAt,
      redacted: m.redactedAt !== null,
    })),
    porId: new Map(filas.map((m) => [m.messageId, m])),
  };
}

/** Deja asentado qué mensajes del chat citó esa cita del ticket (un mensaje se enlaza una vez por ticket). */
export async function enlazarCitados(
  manager: EntityManager,
  ticket: SupportTicket,
  citados: readonly string[],
  quotedInMessageId: string,
  userId: string,
): Promise<void> {
  if (citados.length === 0) return;
  await manager
    .createQueryBuilder()
    .insert()
    .into(SupportTicketMessageLink)
    .values(
      citados.map((messageId) => ({
        ticketId: ticket.ticketId,
        messageId,
        distributorId: ticket.distributorId,
        quotedInMessageId,
        createdByUserId: userId,
      })),
    )
    .orIgnore()
    .execute();
}

export async function nombreDeLaEmpresa(
  manager: EntityManager,
  distributorId: string,
): Promise<string> {
  const [fila]: Array<{ name: string }> = await manager.query(
    `SELECT "name" FROM "distributor" WHERE "distributor_id" = $1`,
    [distributorId],
  );
  return fila?.name ?? '';
}

/** Una empresa que existe y no se dio de baja (suspendida sí: C1 es núcleo). */
export async function assertEmpresaVigente(
  manager: EntityManager,
  distributorId: string,
): Promise<void> {
  const filas: unknown[] = await manager.query(
    `SELECT 1 FROM "distributor" WHERE "distributor_id" = $1 AND "deletedAt" IS NULL`,
    [distributorId],
  );
  if (filas.length === 0) throw new NotFoundException('No existe esa empresa');
}

export const esPlataforma = (actor: ActorDeTicket): boolean =>
  actor.party === Party.PLATFORM;
