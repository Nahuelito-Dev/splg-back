import { lecturaVisibleDeLaPunta } from './bandeja-read-model';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import {
  MessageVisibility,
  Party,
  type PartyQueHabla,
} from '../domain/chat.enums';
import { numeroDeTicket } from '../domain/support-ticket.machine';
import type { Attachment } from '../../attachment/entities/attachment.entity';
import { Message } from '../entities/message.entity';
import { adjuntosDeLosMensajes } from './adjuntos-de-los-mensajes';
import { SupportTicket } from '../entities/support-ticket.entity';

/**
 * Qué cuenta como «sin leer» para una punta (`m`: el mensaje, `r`: la lectura
 * de la persona): posterior a lo que leyó, de la otra punta, sin notas
 * internas si es la empresa, y nunca un mensaje de sistema (el `ticket_opened`
 * que la misma empresa disparó, los cambios de estado): siguen en el hilo pero
 * no prenden la insignia.
 */
export function condicionDeNoLeido(parametroDeLaPunta: string): string {
  const p = parametroDeLaPunta;
  return `m."deleted_at" IS NULL
            AND m."seq" > COALESCE(r."last_read_seq", 0)
            AND m."sender_party" <> ${p}
            AND m."kind" <> 'system'
            AND (m."visibility" = 'all' OR ${p} = 'platform')`;
}

/** Quién mira: su punta y su usuario (la lectura es por persona). */
export interface Observador {
  party: Party.COMPANY | Party.PLATFORM;
  userId: string;
}

/** Quién lee un hilo: cualquier punta que habla (también el cliente y el chofer de la bandeja). */
export interface Lector {
  party: PartyQueHabla;
  userId: string;
}

/**
 * Consultas de sólo lectura para armar las respuestas (nombres, sin leer,
 * «leído» de la otra punta, últimos mensajes visibles, citas). Lee nombres de
 * `user` y `distributor` y las sesiones de soporte por número de ticket: es
 * el lado de lectura (CONVENCIONES §4), nunca escribe.
 */
@Injectable()
export class ChatReadModel {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Los adjuntos de los mensajes de adjunto (CH7), por `messageId`. */
  adjuntos(mensajes: readonly Message[]): Promise<Map<string, Attachment>> {
    return adjuntosDeLosMensajes(this.dataSource.manager, mensajes);
  }

  async nombres(userIds: Iterable<string>): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const filas: Array<{ user_id: string; full_name: string | null }> =
      await this.dataSource.query(
        `SELECT "user_id", "full_name" FROM "user" WHERE "user_id" = ANY($1::uuid[])`,
        [ids],
      );
    return new Map(filas.map((f) => [f.user_id, f.full_name ?? 'Sin nombre']));
  }

  async empresas(ids: Iterable<string>): Promise<Map<string, string>> {
    const lista = [...new Set(ids)];
    if (lista.length === 0) return new Map();
    const filas: Array<{ distributor_id: string; name: string }> =
      await this.dataSource.query(
        `SELECT "distributor_id", "name" FROM "distributor" WHERE "distributor_id" = ANY($1::uuid[])`,
        [lista],
      );
    return new Map(filas.map((f) => [f.distributor_id, f.name]));
  }

  /** Sin leer por conversación para esa persona: lo de la otra punta, sin notas internas si es la empresa. */
  async noLeidos(
    conversationIds: string[],
    quien: Observador,
  ): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const filas: Array<{ conversation_id: string; n: string }> =
      await this.dataSource.query(
        `SELECT m."conversation_id", count(*) AS n
           FROM "message" m
           LEFT JOIN "conversation_read_state" r
             ON r."conversation_id" = m."conversation_id" AND r."user_id" = $2
          WHERE m."conversation_id" = ANY($1::uuid[])
            AND ${condicionDeNoLeido('$3')}
          GROUP BY m."conversation_id"`,
        [conversationIds, quien.userId, quien.party],
      );
    return new Map(filas.map((f) => [f.conversation_id, Number(f.n)]));
  }

  /** Hasta dónde leyó la otra punta en cada conversación. */
  async lecturaDeLaOtraParte(
    conversationIds: string[],
    otra: Party.COMPANY | Party.PLATFORM,
  ): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const filas: Array<{ conversation_id: string; last_read_seq: string }> =
      await this.dataSource.query(
        `SELECT p."conversation_id", ${lecturaVisibleDeLaPunta('p')} AS "last_read_seq"
           FROM "conversation_party" p
          WHERE p."conversation_id" = ANY($1::uuid[]) AND p."party" = $2`,
        [conversationIds, otra],
      );
    return new Map(
      filas.map((f) => [f.conversation_id, Number(f.last_read_seq)]),
    );
  }

  /** Hasta dónde leyó esa persona en cada conversación (0 si nunca abrió el hilo). */
  async lecturaPropia(
    conversationIds: string[],
    userId: string,
  ): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const filas: Array<{ conversation_id: string; last_read_seq: string }> =
      await this.dataSource.query(
        `SELECT "conversation_id", "last_read_seq" FROM "conversation_read_state"
          WHERE "conversation_id" = ANY($1::uuid[]) AND "user_id" = $2`,
        [conversationIds, userId],
      );
    return new Map(
      filas.map((f) => [f.conversation_id, Number(f.last_read_seq)]),
    );
  }

  /** El último mensaje que esa punta puede ver de cada conversación. */
  async ultimosVisibles(
    conversationIds: string[],
    party: Party.COMPANY | Party.PLATFORM,
  ): Promise<Map<string, Message>> {
    if (conversationIds.length === 0) return new Map();
    const filas = await this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .distinctOn(['m.conversationId'])
      .where('m.conversationId IN (:...ids)', { ids: conversationIds })
      .andWhere(party === Party.PLATFORM ? '1 = 1' : 'm.visibility = :todos', {
        todos: MessageVisibility.ALL,
      })
      .orderBy('m.conversationId')
      .addOrderBy('m.seq', 'DESC')
      .getMany();
    return new Map(filas.map((m) => [m.conversationId, m]));
  }

  /** Los tickets que citan cada mensaje (la etiqueta «→ T-000123» del chat). */
  async citadosEn(
    messageIds: string[],
  ): Promise<Map<string, Array<{ ticketId: string; number: string }>>> {
    const mapa = new Map<string, Array<{ ticketId: string; number: string }>>();
    if (messageIds.length === 0) return mapa;
    const filas: Array<{
      message_id: string;
      ticket_id: string;
      number: number;
    }> = await this.dataSource.query(
      `SELECT l."message_id", t."ticket_id", t."number"
           FROM "support_ticket_message_link" l
           JOIN "support_ticket" t ON t."ticket_id" = l."ticket_id"
          WHERE l."message_id" = ANY($1::uuid[]) AND t."deleted_at" IS NULL
          ORDER BY t."number"`,
      [messageIds],
    );
    for (const f of filas) {
      const lista = mapa.get(f.message_id) ?? [];
      lista.push({ ticketId: f.ticket_id, number: numeroDeTicket(f.number) });
      mapa.set(f.message_id, lista);
    }
    return mapa;
  }

  /** Los tickets que salieron de cada chat (las tarjetas del chat). */
  async ticketsDesde(chatIds: string[]): Promise<Map<string, SupportTicket[]>> {
    const mapa = new Map<string, SupportTicket[]>();
    if (chatIds.length === 0) return mapa;
    const filas = await this.dataSource.getRepository(SupportTicket).find({
      where: { originConversationId: In(chatIds) },
      order: { number: 'ASC' },
    });
    for (const t of filas) {
      const clave = t.originConversationId as string;
      mapa.set(clave, [...(mapa.get(clave) ?? []), t]);
    }
    return mapa;
  }

  /** El ticket dueño de cada hilo. */
  async ticketsDeLosHilos(
    conversationIds: string[],
  ): Promise<Map<string, SupportTicket>> {
    if (conversationIds.length === 0) return new Map();
    const filas = await this.dataSource.getRepository(SupportTicket).find({
      where: { conversationId: In(conversationIds) },
    });
    return new Map(filas.map((t) => [t.conversationId, t]));
  }

  /** Sesiones de soporte pedidas con el número de cada ticket (`ticketRef`), de su misma empresa. */
  async sesionesDeSoporte(
    tickets: readonly SupportTicket[],
  ): Promise<Map<string, Array<{ id: string; status: string }>>> {
    const mapa = new Map<string, Array<{ id: string; status: string }>>();
    if (tickets.length === 0) return mapa;
    const refs = tickets.map((t) => numeroDeTicket(t.number));
    const filas: Array<{
      support_session_id: string;
      status: string;
      ticket_ref: string;
      distributor_id: string;
    }> = await this.dataSource.query(
      `SELECT "support_session_id", "status", "ticket_ref", "distributor_id"
         FROM "support_session"
        WHERE "ticket_ref" = ANY($1::text[])
        ORDER BY "created_at"`,
      [refs],
    );
    for (const t of tickets) {
      const ref = numeroDeTicket(t.number);
      mapa.set(
        t.ticketId,
        filas
          .filter(
            (f) => f.ticket_ref === ref && f.distributor_id === t.distributorId,
          )
          .map((f) => ({ id: f.support_session_id, status: f.status })),
      );
    }
    return mapa;
  }

  /**
   * Para la insignia de la empresa: mensajes sin leer de esa persona en el
   * chat abierto y cuántos tickets tienen algo sin leer.
   */
  async resumenDeLaEmpresa(
    distributorId: string,
    userId: string,
  ): Promise<{ chatUnread: number; ticketsUnread: number }> {
    const [fila]: Array<{ chat: string; tickets: string }> =
      await this.dataSource.query(
        `WITH conv AS (
           SELECT c."conversation_id", c."channel" FROM "conversation" c
             LEFT JOIN "support_ticket" t ON t."conversation_id" = c."conversation_id"
            WHERE c."distributor_id" = $1 AND c."deleted_at" IS NULL
              AND ((c."channel" = 'platform_chat' AND c."status" = 'open')
                   OR (c."channel" = 'platform_ticket' AND t."status" <> 'closed'))
         ), sin_leer AS (
           SELECT conv."conversation_id", conv."channel", count(*) AS n
             FROM conv
             JOIN "message" m ON m."conversation_id" = conv."conversation_id"
             LEFT JOIN "conversation_read_state" r
               ON r."conversation_id" = conv."conversation_id" AND r."user_id" = $2
            WHERE ${condicionDeNoLeido('$3')}
            GROUP BY conv."conversation_id", conv."channel"
         )
         SELECT COALESCE(sum("n") FILTER (WHERE "channel" = 'platform_chat'), 0) AS chat,
                count(*) FILTER (WHERE "channel" = 'platform_ticket') AS tickets
           FROM sin_leer`,
        [distributorId, userId, Party.COMPANY],
      );
    return {
      chatUnread: Number(fila?.chat ?? 0),
      ticketsUnread: Number(fila?.tickets ?? 0),
    };
  }

  /**
   * Para la insignia de la plataforma: chats abiertos y tickets no cerrados
   * con algo sin leer para esa persona, y los que nadie atiende.
   */
  async resumenDeLaPlataforma(userId: string): Promise<{
    chatsUnread: number;
    chatsUnassigned: number;
    ticketsUnread: number;
    ticketsUnassigned: number;
  }> {
    const [fila]: Array<Record<string, string>> = await this.dataSource.query(
      `WITH conv AS (
         SELECT c."conversation_id", c."channel" FROM "conversation" c
          LEFT JOIN "support_ticket" t ON t."conversation_id" = c."conversation_id"
          WHERE c."deleted_at" IS NULL
            AND ((c."channel" = 'platform_chat' AND c."status" = 'open')
                 OR (c."channel" = 'platform_ticket' AND t."status" <> 'closed'))
       ), sin_leer AS (
         SELECT DISTINCT conv."conversation_id", conv."channel"
           FROM conv
           JOIN "message" m ON m."conversation_id" = conv."conversation_id"
           LEFT JOIN "conversation_read_state" r
             ON r."conversation_id" = conv."conversation_id" AND r."user_id" = $1
          WHERE ${condicionDeNoLeido('$2')}
       )
       SELECT (SELECT count(*) FROM sin_leer WHERE "channel" = 'platform_chat') AS chats_unread,
              (SELECT count(*) FROM sin_leer WHERE "channel" = 'platform_ticket') AS tickets_unread,
              (SELECT count(*) FROM "conversation" WHERE "channel" = 'platform_chat' AND "status" = 'open'
                  AND "deleted_at" IS NULL AND "assigned_to_user_id" IS NULL) AS chats_unassigned,
              (SELECT count(*) FROM "support_ticket" WHERE "status" <> 'closed'
                  AND "deleted_at" IS NULL AND "assigned_member_user_id" IS NULL) AS tickets_unassigned`,
      [userId, Party.PLATFORM],
    );
    return {
      chatsUnread: Number(fila?.chats_unread ?? 0),
      chatsUnassigned: Number(fila?.chats_unassigned ?? 0),
      ticketsUnread: Number(fila?.tickets_unread ?? 0),
      ticketsUnassigned: Number(fila?.tickets_unassigned ?? 0),
    };
  }

  /** Si el usuario es un administrador general activo (para asignar). */
  async esMiembroDeLaPlataforma(userId: string): Promise<boolean> {
    const filas: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "user" u JOIN "role" r ON r."role_id" = u."role_id"
        WHERE u."user_id" = $1 AND r."type" = 'super_admin'
          AND u."blocked" = false AND u."deletedAt" IS NULL`,
      [userId],
    );
    return filas.length > 0;
  }
}
