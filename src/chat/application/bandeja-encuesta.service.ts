import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { completarPlantilla } from '../domain/bandeja';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  PLANTILLA_DEL_ASISTENTE_IA,
  SystemCode,
} from '../domain/chat.enums';
import {
  ESCALA_DE_LA_ENCUESTA,
  respuestaALaEncuesta,
  quienAtendio,
  venceLaEncuesta,
} from '../domain/encuesta';
import type { Conversation } from '../entities/conversation.entity';
import { ConversationRating } from '../entities/conversation-rating.entity';
import type {
  QueryCsatDto,
  RateConversationDto,
} from '../presentation/dto/bandeja-input.dto';
import { type ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import { soloDelCliente } from './bandeja.errors';
import { ChatEvents, Efectos } from './chat.events';
import {
  CompanyChatSettingsService,
  textoDeLaEncuesta,
} from './company-chat-settings.service';
import { MessageWriter } from './message-writer';
import { valoresDePlantilla } from './valores-de-plantilla';

/** Clave de la plantilla del pedido de calificación en el mensaje. */
export const PLANTILLA_DE_LA_ENCUESTA = 'encuesta';

/** Días que mira el resumen si no se pide un período. */
const DIAS_DEL_RESUMEN = 30;

export interface GrupoDeLaEncuesta {
  answered: number;
  average: number | null;
  csat: number | null;
}

export interface ResumenDeLaEncuesta extends GrupoDeLaEncuesta {
  from: Date;
  to: Date;
  requested: number;
  expired: number;
  cancelled: number;
  byScore: Record<string, number>;
  assistant: GrupoDeLaEncuesta;
  team: GrupoDeLaEncuesta;
}

/**
 * Encuesta de satisfacción al cerrar una conversación con un cliente (4b).
 * Al cerrarla, si la empresa la tiene prendida, sale un mensaje de sistema
 * `csat_request` (con el texto de la empresa y `{ ratingId, expiresAt, scale }`)
 * y queda la encuesta de ese cierre. El cliente la responde con un toque (1 a
 * 5, comentario opcional), una vez y dentro de las 48 h, por su `ratingId`.
 * Si en vez de calificar escribe, abre otra conversación como siempre (la
 * encuesta queda pendiente hasta vencer); si la empresa la reabre, la de ese
 * cierre se anula. La auditoría la escribe el trigger de la tabla.
 */
@Injectable()
export class BandejaEncuestaService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly acceso: BandejaAcceso,
    private readonly ajustes: CompanyChatSettingsService,
    private readonly writer: MessageWriter,
    private readonly eventos: ChatEvents,
  ) {}

  /**
   * Dentro del cierre (la conversación todavía abierta y bloqueada): pide la
   * calificación si es con un cliente y la empresa la tiene prendida.
   * Devuelve si la pidió.
   */
  async pedirAlCerrar(
    manager: EntityManager,
    c: Conversation,
    efectos: Efectos,
    ahora: Date,
  ): Promise<boolean> {
    if (c.channel !== Channel.STAFF_CUSTOMER || !c.customerUserId) {
      return false;
    }
    const ajustes = await this.ajustes.leer(c.distributorId, manager);
    if (!ajustes.csatEnabled) return false;
    const [quien]: Array<{ equipo: boolean; asistente: boolean }> =
      await manager.query(sqlDeQuienAtendio(), [c.conversationId]);
    const ratingId = randomUUID();
    const expiresAt = venceLaEncuesta(ahora);
    const texto = completarPlantilla(
      textoDeLaEncuesta(ajustes),
      await valoresDePlantilla(manager, c, ajustes, ahora),
    );
    const r = await this.writer.escribir(manager, {
      conversationId: c.conversationId,
      distributorId: c.distributorId,
      senderParty: Party.SYSTEM,
      senderUserId: null,
      clientMessageId: null,
      kind: MessageKind.SYSTEM,
      visibility: MessageVisibility.ALL,
      body: texto.length > 0 ? texto.slice(0, 2000) : null,
      payload: {
        ratingId,
        expiresAt: expiresAt.toISOString(),
        scale: ESCALA_DE_LA_ENCUESTA,
      },
      systemCode: SystemCode.CSAT_REQUEST,
      templateKey: PLANTILLA_DE_LA_ENCUESTA,
    });
    await manager.getRepository(ConversationRating).insert({
      ratingId,
      conversationId: c.conversationId,
      distributorId: c.distributorId,
      requestMessageId: r.message.messageId,
      customerUserId: c.customerUserId,
      servedBy: quienAtendio(quien?.equipo ?? false, quien?.asistente ?? false),
      score: null,
      comment: null,
      requestedAt: ahora,
      expiresAt,
      answeredAt: null,
    });
    efectos.mensaje(r.conversation, r.message);
    return true;
  }

  /**
   * El cliente responde ESA encuesta (`ratingId`) de SU conversación con la
   * empresa del `X-Distributor`. Chofer → 403; la conversación o la encuesta
   * de otra persona, de otra conversación o de otra empresa → 404; anulada (se
   * reabrió), con la conversación abierta o vencida → 409. Ya respondida: la
   * misma respuesta es un reintento (`created: false`, 200); otra → 409.
   */
  async responder(
    actor: ActorDeLaBandeja,
    conversationId: string,
    dto: RateConversationDto,
    ahora: Date = new Date(),
  ): Promise<{
    rating: ConversationRating;
    conversation: Conversation;
    created: boolean;
  }> {
    if (actor.party !== Party.CUSTOMER) throw soloDelCliente();
    const respuesta = { score: dto.score, comment: dto.comment ?? null };
    const efectos = new Efectos();
    const r = await this.dataSource.transaction(async (manager) => {
      const c = await this.acceso.buscar(actor, conversationId, manager, {
        bloquear: true,
      });
      const encuesta = await buscarEncuestaParaResponder(manager, {
        ratingId: dto.ratingId,
        conversationId: c.conversationId,
        distributorId: actor.distributorId,
        customerUserId: actor.userId,
      });
      const cual = respuestaALaEncuesta(
        encuesta,
        respuesta,
        c.status === ConversationStatus.OPEN,
        ahora,
      );
      const e = encuesta as ConversationRating;
      if (cual === 'repetida') {
        return { rating: e, conversation: c, created: false };
      }
      await manager.getRepository(ConversationRating).update(
        { ratingId: e.ratingId },
        {
          score: respuesta.score,
          comment: respuesta.comment,
          answeredAt: ahora,
        },
      );
      Object.assign(e, {
        score: respuesta.score,
        comment: respuesta.comment,
        answeredAt: ahora,
      });
      efectos.conversacion(c, 'status');
      return { rating: e, conversation: c, created: true };
    });
    this.eventos.publicar(efectos);
    return r;
  }

  /**
   * El resumen de la encuesta de la empresa en un período (por cuándo se
   * pidió): pedidas, respondidas, vencidas, promedio, CSAT (4 y 5) y lo mismo
   * del asistente y del equipo. Lo que lee el tablero (B4). Sólo de su empresa.
   */
  async resumen(
    actor: ActorDeLaBandeja,
    query: QueryCsatDto,
    ahora: Date = new Date(),
  ): Promise<ResumenDeLaEncuesta> {
    const to = query.to ?? ahora;
    const from =
      query.from ?? new Date(to.getTime() - DIAS_DEL_RESUMEN * 86_400_000);
    const filas: FilaDelResumen[] = await this.dataSource.query(
      SQL_DEL_RESUMEN,
      [actor.distributorId, from, to, ahora],
    );
    return resumirEncuestas(filas, from, to);
  }
}

/**
 * Quién atendió la conversación que se cierra (4b): si alguien del equipo
 * escribió algo visible (las notas no cuentan) o si respondió el asistente con
 * IA, sólo DESDE la reapertura o la encuesta anterior (lo del cierre anterior
 * ya se calificó con aquella).
 */
export function sqlDeQuienAtendio(): string {
  const desde = `COALESCE((SELECT max("seq") FROM "message"
                            WHERE "conversation_id" = $1
                              AND "system_code" IN ('${SystemCode.REOPENED}', '${SystemCode.CSAT_REQUEST}')), 0)`;
  return `SELECT EXISTS (SELECT 1 FROM "message" WHERE "conversation_id" = $1
                           AND "seq" > ${desde}
                           AND "sender_party" = 'company' AND "kind" = 'text'
                           AND "visibility" = 'all') AS equipo,
                 EXISTS (SELECT 1 FROM "message" WHERE "conversation_id" = $1
                           AND "seq" > ${desde}
                           AND "kind" = 'auto_reply'
                           AND "template_key" = '${PLANTILLA_DEL_ASISTENTE_IA}') AS asistente`;
}

/**
 * La encuesta que se responde: ESA (`ratingId`), de ESA conversación, de esa
 * empresa y de ese cliente; bloqueada para responderla una sola vez. Nula si
 * no coincide algo (→ 404).
 */
export async function buscarEncuestaParaResponder(
  manager: Pick<EntityManager, 'query'>,
  donde: {
    ratingId: string;
    conversationId: string;
    distributorId: string;
    customerUserId: string;
  },
): Promise<ConversationRating | null> {
  const [f]: Array<{
    rating_id: string;
    conversation_id: string;
    distributor_id: string;
    request_message_id: string;
    customer_user_id: string;
    served_by: 'assistant' | 'team' | 'none';
    score: number | null;
    comment: string | null;
    requested_at: Date;
    expires_at: Date;
    answered_at: Date | null;
    cancelled_at: Date | null;
  }> = await manager.query(SQL_DE_LA_ENCUESTA_A_RESPONDER, [
    donde.ratingId,
    donde.conversationId,
    donde.distributorId,
    donde.customerUserId,
  ]);
  if (!f) return null;
  return Object.assign(new ConversationRating(), {
    ratingId: f.rating_id,
    conversationId: f.conversation_id,
    distributorId: f.distributor_id,
    requestMessageId: f.request_message_id,
    customerUserId: f.customer_user_id,
    servedBy: f.served_by,
    score: f.score === null ? null : Number(f.score),
    comment: f.comment,
    requestedAt: new Date(f.requested_at),
    expiresAt: new Date(f.expires_at),
    answeredAt: f.answered_at ? new Date(f.answered_at) : null,
    cancelledAt: f.cancelled_at ? new Date(f.cancelled_at) : null,
  });
}

export const SQL_DE_LA_ENCUESTA_A_RESPONDER = `SELECT * FROM "conversation_rating"
  WHERE "rating_id" = $1 AND "conversation_id" = $2
    AND "distributor_id" = $3 AND "customer_user_id" = $4
  FOR UPDATE`;

/**
 * Al reabrir (4b): la encuesta pendiente de ese cierre queda anulada (ya no
 * se responde ni cuenta como vencida). Devuelve cuántas anuló.
 */
export async function anularEncuestasPendientes(
  manager: Pick<EntityManager, 'query'>,
  conversationId: string,
  distributorId: string,
  ahora: Date,
): Promise<number> {
  const r: unknown = await manager.query(SQL_PARA_ANULAR, [
    conversationId,
    distributorId,
    ahora,
  ]);
  if (!Array.isArray(r)) return 0;
  const filas: unknown = Array.isArray(r[0]) ? r[0] : r;
  return Array.isArray(filas) ? filas.length : 0;
}

export const SQL_PARA_ANULAR = `UPDATE "conversation_rating" SET "cancelled_at" = $3
  WHERE "conversation_id" = $1 AND "distributor_id" = $2
    AND "answered_at" IS NULL AND "cancelled_at" IS NULL
    AND "expires_at" > $3
  RETURNING "rating_id"`;

/**
 * Las cuentas del resumen por (quién atendió, puntaje): las anuladas no son
 * pedidas ni vencidas; se cuentan aparte.
 */
export const SQL_DEL_RESUMEN = `SELECT "served_by", "score",
         count(*) FILTER (WHERE "cancelled_at" IS NULL) AS n,
         count(*) FILTER (WHERE "answered_at" IS NULL AND "cancelled_at" IS NULL
                            AND "expires_at" < $4) AS vencidas,
         count(*) FILTER (WHERE "cancelled_at" IS NOT NULL) AS anuladas
    FROM "conversation_rating"
   WHERE "distributor_id" = $1 AND "requested_at" >= $2 AND "requested_at" <= $3
   GROUP BY "served_by", "score"`;

export interface FilaDelResumen {
  served_by: string;
  score: number | null;
  n: string;
  vencidas: string;
  anuladas?: string;
}

/** Arma el resumen a partir de las cuentas por (quién atendió, puntaje). */
export function resumirEncuestas(
  filas: readonly FilaDelResumen[],
  from: Date,
  to: Date,
): ResumenDeLaEncuesta {
  const byScore: Record<string, number> = {};
  for (let s = 1; s <= ESCALA_DE_LA_ENCUESTA; s++) byScore[String(s)] = 0;
  const grupo = (cual?: string) => {
    let respondidas = 0;
    let suma = 0;
    let satisfechas = 0;
    for (const f of filas) {
      if (f.score === null || (cual && f.served_by !== cual)) continue;
      const n = Number(f.n);
      respondidas += n;
      suma += Number(f.score) * n;
      if (Number(f.score) >= 4) satisfechas += n;
    }
    return {
      answered: respondidas,
      average:
        respondidas === 0 ? null : Math.round((suma / respondidas) * 100) / 100,
      csat:
        respondidas === 0
          ? null
          : Math.round((satisfechas / respondidas) * 1000) / 1000,
    };
  };
  let requested = 0;
  let expired = 0;
  let cancelled = 0;
  for (const f of filas) {
    requested += Number(f.n);
    expired += Number(f.vencidas);
    cancelled += Number(f.anuladas ?? 0);
    if (f.score !== null) {
      byScore[String(f.score)] = (byScore[String(f.score)] ?? 0) + Number(f.n);
    }
  }
  return {
    from,
    to,
    requested,
    expired,
    cancelled,
    byScore,
    ...grupo(),
    assistant: grupo('assistant'),
    team: grupo('team'),
  };
}
