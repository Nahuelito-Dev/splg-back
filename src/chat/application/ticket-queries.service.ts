import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, SelectQueryBuilder } from 'typeorm';
import { TicketStatus } from '../domain/chat.enums';
import { TicketNoEncontradoError } from '../domain/chat.errors';
import { SupportTicket } from '../entities/support-ticket.entity';
import {
  ASIGNADO_A_MI,
  SIN_ASIGNAR,
  type OrdenDeTickets,
  type QueryCompanyTicketsDto,
  type QueryPlatformChatsDto,
  type QueryPlatformTicketsDto,
} from '../presentation/dto/chat-input.dto';
import { Conversation } from '../entities/conversation.entity';
import { filtrarPorEspera, primeroLasQueEsperan } from './cola-de-espera';
import { Channel, ConversationStatus, Party } from '../domain/chat.enums';

/** Conteos de la cola de tickets de la plataforma. */
export interface ConteosDeTickets {
  new: number;
  open: number;
  waitingCompany: number;
  mine: number;
  overdue: number;
}

/** Listados y fichas de tickets y chats (sólo lectura). */
@Injectable()
export class TicketQueriesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async ficha(
    ticketId: string,
    distributorId: string | null,
  ): Promise<SupportTicket> {
    const t = await this.dataSource.getRepository(SupportTicket).findOne({
      where: distributorId ? { ticketId, distributorId } : { ticketId },
    });
    if (!t) throw new TicketNoEncontradoError();
    return t;
  }

  /** Los tickets de una empresa, con filtros, búsqueda y orden. */
  async deLaEmpresa(
    distributorId: string,
    query: QueryCompanyTicketsDto,
  ): Promise<{ items: SupportTicket[]; total: number }> {
    const qb = this.dataSource
      .getRepository(SupportTicket)
      .createQueryBuilder('t')
      .where('t.distributorId = :dist', { dist: distributorId });
    filtrarEstadoYTexto(qb, query);
    const [items, total] = await ordenar(qb, query, Party.COMPANY)
      .limit(query.limit)
      .offset(query.offset)
      .getManyAndCount();
    return { items, total };
  }

  /** La cola de la plataforma, con filtros y conteos. */
  async deLaPlataforma(
    userId: string,
    query: QueryPlatformTicketsDto,
    ahora: Date = new Date(),
  ): Promise<{
    items: SupportTicket[];
    total: number;
    counts: ConteosDeTickets;
  }> {
    const qb = this.dataSource
      .getRepository(SupportTicket)
      .createQueryBuilder('t');
    filtrarEstadoYTexto(qb, query);
    if (query.priority) {
      qb.andWhere('t.priority = :priority', { priority: query.priority });
    }
    if (query.distributorId) {
      qb.andWhere('t.distributorId = :dist', { dist: query.distributorId });
    }
    filtrarAsignado(qb, 't.assignedMemberUserId', query.assigned, userId);
    if (query.overdue) {
      qb.andWhere(
        't.firstResponseAt IS NULL AND t.firstResponseDueAt < :ahora AND t.status <> :cerrado',
        { ahora, cerrado: TicketStatus.CLOSED },
      );
    }
    if (query.fromChat !== undefined) {
      qb.andWhere(
        query.fromChat
          ? 't.originConversationId IS NOT NULL'
          : 't.originConversationId IS NULL',
      );
    }
    const [items, total] = await ordenar(qb, query, Party.PLATFORM)
      .limit(query.limit)
      .offset(query.offset)
      .getManyAndCount();
    return { items, total, counts: await this.conteos(userId, ahora) };
  }

  /** Los chats con las empresas (cola de la plataforma). */
  async chats(
    userId: string,
    query: QueryPlatformChatsDto,
  ): Promise<{
    items: Conversation[];
    total: number;
    counts: { waiting: number; mine: number };
  }> {
    const qb = this.dataSource
      .getRepository(Conversation)
      .createQueryBuilder('c')
      .where('c.channel = :canal', { canal: Channel.PLATFORM_CHAT })
      .andWhere('c.status = :status', { status: query.status });
    if (query.distributorId) {
      qb.andWhere('c.distributorId = :dist', { dist: query.distributorId });
    }
    filtrarAsignado(qb, 'c.assignedToUserId', query.assigned, userId);
    filtrarPorEspera(qb, query.awaiting);
    primeroLasQueEsperan(qb, query.assigned === SIN_ASIGNAR);
    const [items, total] = await qb
      .addOrderBy('c.lastMessageAt', 'DESC', 'NULLS LAST')
      .addOrderBy('c.conversationId')
      .take(query.limit)
      .skip(query.offset)
      .getManyAndCount();
    const [fila]: Array<{ waiting: string; mine: string }> =
      await this.dataSource.query(
        `SELECT count(*) FILTER (WHERE "assigned_to_user_id" IS NULL) AS waiting,
                count(*) FILTER (WHERE "assigned_to_user_id" = $1) AS mine
           FROM "conversation"
          WHERE "channel" = $2 AND "status" = $3 AND "deleted_at" IS NULL`,
        [userId, Channel.PLATFORM_CHAT, ConversationStatus.OPEN],
      );
    return {
      items,
      total,
      counts: { waiting: Number(fila.waiting), mine: Number(fila.mine) },
    };
  }

  private async conteos(
    userId: string,
    ahora: Date,
  ): Promise<ConteosDeTickets> {
    const [fila]: Array<Record<keyof ConteosDeTickets, string>> =
      await this.dataSource.query(
        `SELECT count(*) FILTER (WHERE "status" = 'new') AS "new",
                count(*) FILTER (WHERE "status" = 'open') AS "open",
                count(*) FILTER (WHERE "status" = 'waiting_company') AS "waitingCompany",
                count(*) FILTER (WHERE "status" <> 'closed' AND "assigned_member_user_id" = $1) AS "mine",
                count(*) FILTER (WHERE "status" <> 'closed' AND "first_response_at" IS NULL
                                  AND "first_response_due_at" < $2) AS "overdue"
           FROM "support_ticket" WHERE "deleted_at" IS NULL`,
        [userId, ahora],
      );
    return {
      new: Number(fila.new),
      open: Number(fila.open),
      waitingCompany: Number(fila.waitingCompany),
      mine: Number(fila.mine),
      overdue: Number(fila.overdue),
    };
  }
}

/** Estados (uno o varios) y búsqueda por número (`T-000123`, `123`) o parte del asunto. */
export function filtrarEstadoYTexto(
  qb: SelectQueryBuilder<SupportTicket>,
  query: QueryCompanyTicketsDto,
): void {
  if (query.status?.length) {
    qb.andWhere('t.status IN (:...estados)', { estados: query.status });
  }
  if (!query.q) return;
  const texto = query.q;
  const numero = /^(?:t-)?0*(\d{1,9})$/i.exec(texto);
  qb.andWhere(
    new Brackets((w) => {
      w.where('t.subject ILIKE :texto', {
        texto: `%${texto.replace(/[%_\\]/g, '\\$&')}%`,
      });
      if (numero) {
        w.orWhere('t.number = :numero', { numero: Number(numero[1]) });
      }
    }),
  );
}

/** Columna (o expresión) de cada orden. */
const COLUMNA_DEL_ORDEN: Readonly<Record<OrdenDeTickets, string>> = {
  createdAt: 't.createdAt',
  updatedAt: 't.updatedAt',
  lastMessageAt: 'ultimo_mensaje',
};

/**
 * Ordena por el campo pedido y desempata por número en el mismo sentido.
 * `lastMessageAt` es el último mensaje del hilo que esa punta puede ver: la
 * empresa no cuenta las notas internas (no se le filtra cuándo hubo una).
 */
export function ordenar(
  qb: SelectQueryBuilder<SupportTicket>,
  query: Pick<QueryCompanyTicketsDto, 'sort' | 'order'>,
  punta: Party.COMPANY | Party.PLATFORM,
): SelectQueryBuilder<SupportTicket> {
  const sentido = query.order === 'asc' ? 'ASC' : 'DESC';
  if (query.sort === 'lastMessageAt') {
    qb.addSelect(
      `(SELECT max(m."created_at") FROM "message" m
         WHERE m."conversation_id" = t."conversation_id" AND m."deleted_at" IS NULL
           ${punta === Party.COMPANY ? `AND m."visibility" = 'all'` : ''})`,
      'ultimo_mensaje',
    );
  }
  return qb
    .orderBy(COLUMNA_DEL_ORDEN[query.sort], sentido, 'NULLS LAST')
    .addOrderBy('t.number', sentido);
}

function filtrarAsignado<T extends object>(
  qb: SelectQueryBuilder<T>,
  columna: string,
  asignado: string | undefined,
  userId: string,
): void {
  if (asignado === undefined) return;
  if (asignado === SIN_ASIGNAR) {
    qb.andWhere(`${columna} IS NULL`);
    return;
  }
  qb.andWhere(`${columna} = :asignado`, {
    asignado: asignado === ASIGNADO_A_MI ? userId : asignado,
  });
}
