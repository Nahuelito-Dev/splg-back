import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  type FilaDelResumen,
  SQL_DEL_RESUMEN,
} from '../application/bandeja-encuesta.service';
import {
  Channel,
  ConversationStatus,
  Party,
  TicketStatus,
} from '../domain/chat.enums';
import type { ClaveContada, TrazaContada } from '../domain/metricas';
import { nombreVisibleDeLaEmpresa } from './nombre-visible-de-la-empresa';

/** Instantes `[desde, hasta)` del período. */
export interface Rango {
  desde: Date;
  hasta: Date;
}

/** Una conversación de la bandeja creada en el período. */
export interface ConversacionDelPeriodo {
  channel: Channel;
  status: ConversationStatus;
  createdAt: Date;
  /** El primer mensaje del cliente o del chofer. */
  firstIncomingAt: Date | null;
  firstResponseAt: Date | null;
  closedAt: Date | null;
  closedReason: string | null;
}

export interface EnVivoPorCanal {
  channel: Channel;
  open: number;
  unassigned: number;
  unanswered: number;
  awaitingHuman: number;
}

export interface UsoDePlantilla extends ClaveContada {
  /** `quick`: respuesta rápida del personal; `auto`: respuesta automática. */
  kind: 'quick' | 'auto';
}

export interface TrazaDeEmpresa extends TrazaContada {
  distributorId: string;
}

export interface ResueltasDeEmpresa {
  distributorId: string;
  closedWithAssistant: number;
  resolvedWithoutHuman: number;
}

/** Un chat con la plataforma creado en el período. */
export interface ChatDelPeriodo {
  status: ConversationStatus;
  createdAt: Date;
  /** El primer mensaje de la empresa. */
  firstCompanyAt: Date | null;
  /** La primera respuesta de la plataforma después de ése. */
  firstReplyAt: Date | null;
  hasTicket: boolean;
}

export interface TicketDelPeriodo {
  openedByParty: Party;
  status: TicketStatus;
  createdAt: Date;
  firstResponseAt: Date | null;
  firstResponseDueAt: Date | null;
  resolvedAt: Date | null;
  satisfaction: number | null;
}

export interface UsoDeLaEmpresa {
  distributorId: string;
  name: string;
  conversations: number;
  messages: number;
}

const BANDEJA = `('staff_customer', 'staff_driver')`;

/** `$n` opcional: todas las empresas si es nulo. */
const deLaEmpresa = (columna: string, n: number) =>
  `($${n}::uuid IS NULL OR ${columna} = $${n}::uuid)`;

const fecha = (v: Date | string | null): Date | null =>
  v === null ? null : new Date(v);

/**
 * Las consultas de las métricas del chat (B4): sólo lectura y sólo conteos y
 * tiempos, nunca el texto de un mensaje. Sin tabla de hechos: sobre
 * `conversation`, `message`, `support_ticket`, `conversation_rating` y
 * `assistant_trace`, con sus índices. Lo de una empresa siempre filtra por
 * `distributor_id` (el primer parámetro); lo de la plataforma, por la empresa
 * pedida o por todas.
 */
@Injectable()
export class MetricasReadModel {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async conversacionesDelPeriodo(
    distributorId: string,
    canales: readonly string[],
    r: Rango,
  ): Promise<ConversacionDelPeriodo[]> {
    const filas: Array<{
      channel: Channel;
      status: ConversationStatus;
      created_at: Date;
      first_incoming_at: Date | null;
      first_response_at: Date | null;
      closed_at: Date | null;
      closed_reason: string | null;
    }> = await this.dataSource.query(SQL_CONVERSACIONES, [
      distributorId,
      r.desde,
      r.hasta,
      [...canales],
    ]);
    return filas.map((f) => ({
      channel: f.channel,
      status: f.status,
      createdAt: new Date(f.created_at),
      firstIncomingAt: fecha(f.first_incoming_at),
      firstResponseAt: fecha(f.first_response_at),
      closedAt: fecha(f.closed_at),
      closedReason: f.closed_reason,
    }));
  }

  async enVivo(
    distributorId: string,
    canales: readonly string[],
  ): Promise<EnVivoPorCanal[]> {
    const filas: Array<
      Record<Exclude<keyof EnVivoPorCanal, 'channel'>, string> & {
        channel: Channel;
      }
    > = await this.dataSource.query(SQL_EN_VIVO, [distributorId, [...canales]]);
    return filas.map((f) => ({
      channel: f.channel,
      open: Number(f.open),
      unassigned: Number(f.unassigned),
      unanswered: Number(f.unanswered),
      awaitingHuman: Number(f.awaitingHuman),
    }));
  }

  async usoDePlantillas(
    distributorId: string,
    canales: readonly string[],
    r: Rango,
  ): Promise<UsoDePlantilla[]> {
    const filas: Array<{ kind: 'quick' | 'auto'; key: string; n: string }> =
      await this.dataSource.query(SQL_PLANTILLAS, [
        distributorId,
        r.desde,
        r.hasta,
        [...canales],
      ]);
    return filas.map((f) => ({ kind: f.kind, key: f.key, count: Number(f.n) }));
  }

  /** Las trazas publicadas del asistente en un canal, por empresa, resultado y motivo. */
  async trazasDelAsistente(
    canal: Channel.STAFF_CUSTOMER | Channel.PLATFORM_CHAT,
    r: Rango,
    distributorId: string | null,
  ): Promise<{ trazas: TrazaDeEmpresa[]; atendidas: Map<string, number> }> {
    const params = [distributorId, r.desde, r.hasta, canal];
    // En serie: el servicio ya acota cuántas consultas van a la vez.
    const filas: Array<{
      distributor_id: string;
      outcome: string;
      reason: string | null;
      n: string;
      conversaciones: string;
    }> = await this.dataSource.query(SQL_TRAZAS, params);
    const atendidas: Array<{ distributor_id: string; n: string }> =
      await this.dataSource.query(SQL_ATENDIDAS, params);
    return {
      trazas: filas.map((f) => ({
        distributorId: f.distributor_id,
        outcome: f.outcome,
        reason: f.reason,
        count: Number(f.n),
        conversations: Number(f.conversaciones),
      })),
      atendidas: new Map(atendidas.map((f) => [f.distributor_id, Number(f.n)])),
    };
  }

  /**
   * Cerradas (creadas en el período) en las que el asistente respondió, y de
   * ésas las que nadie de `partyHumana` atendió (sin texto ni adjunto visible)
   * y en las que no derivó. Por empresa.
   */
  async resueltasSinPersona(
    canal: Channel.STAFF_CUSTOMER | Channel.PLATFORM_CHAT,
    partyHumana: Party.COMPANY | Party.PLATFORM,
    r: Rango,
    distributorId: string | null,
  ): Promise<ResueltasDeEmpresa[]> {
    const atendida =
      partyHumana === Party.PLATFORM ? Party.COMPANY : Party.CUSTOMER;
    const filas: Array<{
      distributor_id: string;
      cerradas: string;
      resueltas: string;
    }> = await this.dataSource.query(SQL_RESUELTAS_SIN_PERSONA, [
      distributorId,
      r.desde,
      r.hasta,
      canal,
      partyHumana,
      atendida,
    ]);
    return filas.map((f) => ({
      distributorId: f.distributor_id,
      closedWithAssistant: Number(f.cerradas),
      resolvedWithoutHuman: Number(f.resueltas),
    }));
  }

  /** Las cuentas de la encuesta (las mismas que `GET /conversations/csat`). */
  encuestas(
    distributorId: string,
    r: Rango,
    ahora: Date,
  ): Promise<FilaDelResumen[]> {
    return this.dataSource.query(SQL_DEL_RESUMEN, [
      distributorId,
      r.desde,
      new Date(r.hasta.getTime() - 1),
      ahora,
    ]);
  }

  async chatsDeSoporte(
    r: Rango,
    distributorId: string | null,
  ): Promise<ChatDelPeriodo[]> {
    const filas: Array<{
      status: ConversationStatus;
      created_at: Date;
      first_company_at: Date | null;
      first_reply_at: Date | null;
      has_ticket: boolean;
    }> = await this.dataSource.query(SQL_CHATS, [
      distributorId,
      r.desde,
      r.hasta,
    ]);
    return filas.map((f) => ({
      status: f.status,
      createdAt: new Date(f.created_at),
      firstCompanyAt: fecha(f.first_company_at),
      firstReplyAt: fecha(f.first_reply_at),
      hasTicket: f.has_ticket === true,
    }));
  }

  /** Los chats abiertos con un mensaje de la empresa sin respuesta de la plataforma: desde cuándo esperan. */
  async chatsEsperando(distributorId: string | null): Promise<Date[]> {
    const filas: Array<{ since: Date }> = await this.dataSource.query(
      SQL_ESPERANDO,
      [distributorId],
    );
    return filas.map((f) => new Date(f.since));
  }

  async ticketsEnVivo(
    ahora: Date,
    distributorId: string | null,
  ): Promise<{ open: number; overdue: number }> {
    const [f]: Array<{ open: string; overdue: string }> =
      await this.dataSource.query(SQL_TICKETS_EN_VIVO, [distributorId, ahora]);
    return { open: Number(f?.open ?? 0), overdue: Number(f?.overdue ?? 0) };
  }

  async ticketsDelPeriodo(
    r: Rango,
    distributorId: string | null,
  ): Promise<TicketDelPeriodo[]> {
    const filas: Array<{
      opened_by_party: Party;
      status: TicketStatus;
      created_at: Date;
      first_response_at: Date | null;
      first_response_due_at: Date | null;
      resolved_at: Date | null;
      satisfaction: number | string | null;
    }> = await this.dataSource.query(SQL_TICKETS, [
      distributorId,
      r.desde,
      r.hasta,
    ]);
    return filas.map((f) => ({
      openedByParty: f.opened_by_party,
      status: f.status,
      createdAt: new Date(f.created_at),
      firstResponseAt: fecha(f.first_response_at),
      firstResponseDueAt: fecha(f.first_response_due_at),
      resolvedAt: fecha(f.resolved_at),
      satisfaction: f.satisfaction === null ? null : Number(f.satisfaction),
    }));
  }

  /** Conversaciones y mensajes de la bandeja por empresa (sólo las que tuvieron algo). */
  async usoPorEmpresa(
    r: Rango,
    distributorId: string | null,
  ): Promise<UsoDeLaEmpresa[]> {
    const filas: Array<{
      distributor_id: string;
      name: string;
      conversaciones: string;
      mensajes: string;
    }> = await this.dataSource.query(SQL_USO_POR_EMPRESA, [
      distributorId,
      r.desde,
      r.hasta,
    ]);
    return filas.map((f) => ({
      distributorId: f.distributor_id,
      name: f.name,
      conversations: Number(f.conversaciones),
      messages: Number(f.mensajes),
    }));
  }

  async existeLaEmpresa(distributorId: string): Promise<boolean> {
    const filas: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "distributor" WHERE "distributor_id" = $1 AND "deletedAt" IS NULL`,
      [distributorId],
    );
    return filas.length > 0;
  }
}

/** Mensajes visibles de una persona (no notas ni sistema). */
const DE_PERSONA = `m."visibility" = 'all' AND m."kind" IN ('text', 'attachment')`;

export const SQL_CONVERSACIONES = `SELECT c."channel", c."status", c."created_at", c."first_response_at",
       c."closed_at", c."closed_reason",
       (SELECT min(m."created_at") FROM "message" m
         WHERE m."conversation_id" = c."conversation_id"
           AND m."distributor_id" = c."distributor_id"
           AND m."sender_party" IN ('customer', 'driver')
           AND m."deleted_at" IS NULL) AS first_incoming_at
  FROM "conversation" c
 WHERE c."distributor_id" = $1 AND c."channel" = ANY($4::varchar[])
   AND c."created_at" >= $2 AND c."created_at" < $3
   AND c."deleted_at" IS NULL`;

export const SQL_EN_VIVO = `SELECT c."channel",
       count(*) AS "open",
       count(*) FILTER (WHERE c."assigned_to_user_id" IS NULL) AS "unassigned",
       count(*) FILTER (WHERE c."first_response_at" IS NULL AND EXISTS (
         SELECT 1 FROM "message" m
          WHERE m."conversation_id" = c."conversation_id"
            AND m."sender_party" IN ('customer', 'driver')
            AND m."deleted_at" IS NULL)) AS "unanswered",
       count(*) FILTER (WHERE c."awaiting_human_since" IS NOT NULL) AS "awaitingHuman"
  FROM "conversation" c
 WHERE c."distributor_id" = $1 AND c."channel" = ANY($2::varchar[])
   AND c."status" = 'open' AND c."deleted_at" IS NULL
 GROUP BY c."channel"`;

export const SQL_PLANTILLAS = `SELECT CASE WHEN m."sender_party" = 'company' THEN 'quick' ELSE 'auto' END AS "kind",
       COALESCE(m."template_key", m."system_code") AS "key", count(*) AS n
  FROM "message" m
  JOIN "conversation" c ON c."conversation_id" = m."conversation_id"
                       AND c."distributor_id" = m."distributor_id"
 WHERE m."distributor_id" = $1 AND m."created_at" >= $2 AND m."created_at" < $3
   AND c."channel" = ANY($4::varchar[]) AND m."deleted_at" IS NULL
   AND ((m."sender_party" = 'company' AND m."kind" = 'text' AND m."template_key" IS NOT NULL)
     OR (m."sender_party" = 'system' AND (m."kind" = 'auto_reply' OR m."system_code" = 'received_ack')))
 GROUP BY 1, 2`;

export const SQL_TRAZAS = `SELECT t."distributor_id", t."outcome", t."reason", count(*) AS n,
       count(DISTINCT t."conversation_id") AS conversaciones
  FROM "assistant_trace" t
 WHERE ${deLaEmpresa('t."distributor_id"', 1)}
   AND t."channel" = $4 AND t."created_at" >= $2 AND t."created_at" < $3
   AND t."outcome" <> 'discarded'
 GROUP BY t."distributor_id", t."outcome", t."reason"`;

export const SQL_ATENDIDAS = `SELECT t."distributor_id", count(DISTINCT t."conversation_id") AS n
  FROM "assistant_trace" t
 WHERE ${deLaEmpresa('t."distributor_id"', 1)}
   AND t."channel" = $4 AND t."created_at" >= $2 AND t."created_at" < $3
   AND t."outcome" <> 'discarded'
 GROUP BY t."distributor_id"`;

/**
 * Resueltas sin persona: cerradas, el asistente respondió al menos una vez y
 * no derivó, nadie del equipo (`$5`) escribió algo visible, no terminaron en
 * un ticket (C1) ni en un reclamo (C3) y, si se cerraron por inactividad, la
 * persona atendida (`$6`: el cliente en C3, la empresa en C1) no volvió a
 * escribir después de la última respuesta del asistente (quedó una pregunta
 * sin contestar: no se resolvió).
 */
export const SQL_RESUELTAS_SIN_PERSONA = `SELECT c."distributor_id",
       count(*) AS cerradas,
       count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM "assistant_trace" h
            WHERE h."conversation_id" = c."conversation_id" AND h."outcome" = 'handed_off')
         AND NOT EXISTS (
           SELECT 1 FROM "message" m
            WHERE m."conversation_id" = c."conversation_id" AND m."sender_party" = $5
              AND ${DE_PERSONA} AND m."deleted_at" IS NULL)
         AND NOT EXISTS (
           SELECT 1 FROM "support_ticket" t
            WHERE t."origin_conversation_id" = c."conversation_id" AND t."deleted_at" IS NULL)
         AND c."linked_claim_id" IS NULL
         AND (c."closed_reason" <> 'inactivity' OR NOT EXISTS (
           SELECT 1 FROM "message" p
            WHERE p."conversation_id" = c."conversation_id" AND p."sender_party" = $6
              AND p."deleted_at" IS NULL
              AND p."seq" > (SELECT max(r."seq") FROM "assistant_trace" a2
                               JOIN "message" r ON r."message_id" = a2."reply_message_id"
                              WHERE a2."conversation_id" = c."conversation_id"
                                AND a2."outcome" = 'answered')))) AS resueltas
  FROM "conversation" c
 WHERE ${deLaEmpresa('c."distributor_id"', 1)}
   AND c."channel" = $4 AND c."created_at" >= $2 AND c."created_at" < $3
   AND c."status" = 'closed' AND c."deleted_at" IS NULL
   AND EXISTS (SELECT 1 FROM "assistant_trace" a
                WHERE a."conversation_id" = c."conversation_id" AND a."outcome" = 'answered')
 GROUP BY c."distributor_id"`;

export const SQL_CHATS = `SELECT c."status", c."created_at", e."first_company_at", rp."first_reply_at",
       EXISTS (SELECT 1 FROM "support_ticket" t
                WHERE t."origin_conversation_id" = c."conversation_id"
                  AND t."deleted_at" IS NULL) AS has_ticket
  FROM "conversation" c
  LEFT JOIN LATERAL (
    SELECT min(m."created_at") AS first_company_at FROM "message" m
     WHERE m."conversation_id" = c."conversation_id" AND m."sender_party" = 'company'
       AND ${DE_PERSONA} AND m."deleted_at" IS NULL) e ON TRUE
  LEFT JOIN LATERAL (
    SELECT min(m."created_at") AS first_reply_at FROM "message" m
     WHERE m."conversation_id" = c."conversation_id" AND m."sender_party" = 'platform'
       AND ${DE_PERSONA} AND m."deleted_at" IS NULL
       AND m."created_at" >= e."first_company_at") rp ON TRUE
 WHERE ${deLaEmpresa('c."distributor_id"', 1)}
   AND c."channel" = 'platform_chat' AND c."created_at" >= $2 AND c."created_at" < $3
   AND c."deleted_at" IS NULL`;

export const SQL_ESPERANDO = `SELECT w."since"
  FROM "conversation" c
  CROSS JOIN LATERAL (
    SELECT min(m."created_at") AS "since" FROM "message" m
     WHERE m."conversation_id" = c."conversation_id" AND m."sender_party" = 'company'
       AND ${DE_PERSONA} AND m."deleted_at" IS NULL
       AND m."seq" > COALESCE((SELECT max(p."seq") FROM "message" p
                                WHERE p."conversation_id" = c."conversation_id"
                                  AND p."sender_party" = 'platform'
                                  AND p."visibility" = 'all' AND p."deleted_at" IS NULL), 0)) w
 WHERE ${deLaEmpresa('c."distributor_id"', 1)}
   AND c."channel" = 'platform_chat' AND c."status" = 'open'
   AND c."deleted_at" IS NULL AND w."since" IS NOT NULL`;

export const SQL_TICKETS_EN_VIVO = `SELECT count(*) FILTER (WHERE "status" NOT IN ('resolved', 'closed')) AS "open",
       count(*) FILTER (WHERE "status" <> 'closed' AND "first_response_at" IS NULL
                          AND "first_response_due_at" < $2) AS "overdue"
  FROM "support_ticket"
 WHERE ${deLaEmpresa('"distributor_id"', 1)} AND "deleted_at" IS NULL`;

export const SQL_TICKETS = `SELECT "opened_by_party", "status", "created_at", "first_response_at",
       "first_response_due_at", "resolved_at", "satisfaction"
  FROM "support_ticket"
 WHERE ${deLaEmpresa('"distributor_id"', 1)}
   AND "created_at" >= $2 AND "created_at" < $3 AND "deleted_at" IS NULL`;

export const SQL_USO_POR_EMPRESA = `WITH conv AS (
    SELECT c."distributor_id", count(*) AS n FROM "conversation" c
     WHERE ${deLaEmpresa('c."distributor_id"', 1)}
       AND c."channel" IN ${BANDEJA} AND c."created_at" >= $2 AND c."created_at" < $3
       AND c."deleted_at" IS NULL
     GROUP BY 1),
  msg AS (
    SELECT m."distributor_id", count(*) AS n FROM "message" m
      JOIN "conversation" c ON c."conversation_id" = m."conversation_id"
                           AND c."distributor_id" = m."distributor_id"
     WHERE ${deLaEmpresa('m."distributor_id"', 1)}
       AND c."channel" IN ${BANDEJA} AND m."created_at" >= $2 AND m."created_at" < $3
       AND m."sender_party" <> 'system' AND m."visibility" = 'all' AND m."deleted_at" IS NULL
     GROUP BY 1)
SELECT d."distributor_id", ${nombreVisibleDeLaEmpresa('d')} AS "name",
       COALESCE(conv.n, 0) AS conversaciones, COALESCE(msg.n, 0) AS mensajes
  FROM "distributor" d
  LEFT JOIN conv ON conv."distributor_id" = d."distributor_id"
  LEFT JOIN msg ON msg."distributor_id" = d."distributor_id"
 WHERE conv.n IS NOT NULL OR msg.n IS NOT NULL
 ORDER BY mensajes DESC, conversaciones DESC, "name"`;
