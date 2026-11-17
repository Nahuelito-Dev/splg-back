import type { Attachment } from '../../attachment/entities/attachment.entity';
import { adjuntosDeLosMensajes } from './adjuntos-de-los-mensajes';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In } from 'typeorm';
import { idCortoDePedido } from '../../common/events/aviso-al-admin';
import { ConversationRating } from '../entities/conversation-rating.entity';
import { Message } from '../entities/message.entity';
import type { Lector } from './chat-read-model';
import { nombreVisibleDeLaEmpresa } from './nombre-visible-de-la-empresa';

/** El pedido de una conversación, como lo muestra la bandeja. */
export interface PedidoDeLaConversacion {
  id: string;
  number: string;
  status: string;
}

/** Las insignias de la bandeja (de las abiertas de los canales que atiende quien pide). */
export interface ResumenDeLaBandeja {
  unassigned: number;
  mine: number;
  awaitingHuman: number;
  unread: number;
  attention: number;
  mentions: number;
}

/** Una etiqueta puesta en una conversación, como la ve el personal. */
export interface EtiquetaDeLaConversacion {
  id: string;
  name: string;
  color: string;
}

export const SQL_ETIQUETAS_DE_LAS_CONVERSACIONES = `SELECT k."conversation_id", l."label_id", l."name", l."color"
  FROM "conversation_label_link" k
  JOIN "conversation_label" l ON l."label_id" = k."label_id"
                             AND l."distributor_id" = k."distributor_id"
 WHERE k."conversation_id" = ANY($1::uuid[]) AND k."deleted_at" IS NULL
   AND l."deleted_at" IS NULL
 ORDER BY k."conversation_id", lower(l."name"), l."label_id"`;

/** Una mención en una nota, con quién la escribió. */
export interface MencionDeLaNota {
  userId: string;
  fullName: string;
}

/** Alguien del personal vigente de la empresa, con lo que dice su rol. */
export interface PersonaDelPersonal {
  userId: string;
  fullName: string;
  photoKey: string | null;
  /** Rol de sistema: tiene todos los permisos. */
  todos: boolean;
  /** Los permisos guardados en el rol (sin los implicados). */
  permisos: string[];
}

/**
 * Hasta dónde leyó una punta (alias `p` de `conversation_party`), contado
 * sólo en mensajes visibles: el último `seq` visible que no pasa de lo que
 * leyó. Si leyó hasta una nota interna, la otra punta ve el visible anterior,
 * así el «leído» no delata que hubo notas (4a). La comparten la bandeja y el
 * chat con la plataforma.
 */
export function lecturaVisibleDeLaPunta(alias = 'p'): string {
  return `COALESCE((SELECT max(v."seq") FROM "message" v
                     WHERE v."conversation_id" = ${alias}."conversation_id"
                       AND v."visibility" = 'all'
                       AND v."seq" <= ${alias}."last_read_seq"), 0)`;
}

/**
 * El último `seq` visible que no pasa de `seq` (0 si no hay): lo que se le
 * avisa a la otra punta por el socket cuando quien atiende lee (el mismo
 * criterio que `lecturaVisibleDeLaPunta`).
 */
export async function seqVisibleHasta(
  dataSource: Pick<DataSource, 'query'>,
  conversationId: string,
  seq: number,
): Promise<number> {
  const [fila]: Array<{ seq: string | number | null }> = await dataSource.query(
    `SELECT max("seq") AS "seq" FROM "message"
      WHERE "conversation_id" = $1 AND "visibility" = 'all' AND "seq" <= $2`,
    [conversationId, seq],
  );
  return Number(fila?.seq ?? 0);
}

/**
 * Sin leer en la bandeja, para quien está en la punta `$p` (alias `m` del
 * mensaje y `r` de su lectura): lo de la otra punta posterior a su lectura,
 * sin los avisos del sistema, los borrados ni las notas internas (la otra
 * punta no las ve; las del equipo son de su misma punta); para la empresa
 * tampoco las respuestas automáticas (las mandó el sistema en su nombre). La
 * comparten el contador de cada conversación y el resumen de la bandeja.
 */
export function condicionDeNoLeidoEnLaBandeja(
  parametroDeLaPunta: string,
): string {
  const p = parametroDeLaPunta;
  return `m."deleted_at" IS NULL
            AND m."withdrawn_at" IS NULL
            AND m."visibility" = 'all'
            AND m."seq" > COALESCE(r."last_read_seq", 0)
            AND m."sender_party" <> ${p}
            AND m."kind" <> 'system'
            AND NOT (${p} = 'company' AND m."kind" = 'auto_reply')`;
}

/**
 * Consultas de sólo lectura para armar las respuestas de la bandeja (nombres,
 * pedidos, sin leer, «leído» de la otra punta, últimos mensajes, mensajes
 * respondidos, primer mensaje entrante). Lee `user`, `distributor` y `order`:
 * es el lado de lectura (CONVENCIONES §4), nunca escribe.
 */
@Injectable()
export class BandejaReadModel {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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

  /** El nombre de marca de cada empresa (o el legal si no tiene), para firmar al asistente. */
  async marcas(ids: Iterable<string>): Promise<Map<string, string>> {
    const lista = [...new Set(ids)];
    if (lista.length === 0) return new Map();
    const filas: Array<{ distributor_id: string; nombre: string }> =
      await this.dataSource.query(
        `SELECT d."distributor_id", ${nombreVisibleDeLaEmpresa('d')} AS "nombre"
           FROM "distributor" d WHERE d."distributor_id" = ANY($1::uuid[])`,
        [lista],
      );
    return new Map(filas.map((f) => [f.distributor_id, f.nombre]));
  }

  async pedidos(
    ids: Iterable<string>,
  ): Promise<Map<string, PedidoDeLaConversacion>> {
    const lista = [...new Set(ids)];
    if (lista.length === 0) return new Map();
    const filas: Array<{ order_id: string; status: string }> =
      await this.dataSource.query(
        `SELECT "order_id", "status"::text AS status FROM "order" WHERE "order_id" = ANY($1::uuid[])`,
        [lista],
      );
    return new Map(
      filas.map((f) => [
        f.order_id,
        {
          id: f.order_id,
          number: idCortoDePedido(f.order_id),
          status: f.status,
        },
      ]),
    );
  }

  /**
   * Sin leer por conversación para esa persona: lo de la otra punta posterior
   * a su lectura, sin los mensajes de sistema ni los borrados. Para la empresa tampoco cuentan
   * las respuestas automáticas: las mandó el sistema en su nombre.
   */
  async noLeidos(
    conversationIds: string[],
    quien: Lector,
  ): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const filas: Array<{ conversation_id: string; n: string }> =
      await this.dataSource.query(
        `SELECT m."conversation_id", count(*) AS n
           FROM "message" m
           LEFT JOIN "conversation_read_state" r
             ON r."conversation_id" = m."conversation_id" AND r."user_id" = $2
          WHERE m."conversation_id" = ANY($1::uuid[])
            AND ${condicionDeNoLeidoEnLaBandeja('$3')}
          GROUP BY m."conversation_id"`,
        [conversationIds, quien.userId, quien.party],
      );
    return new Map(filas.map((f) => [f.conversation_id, Number(f.n)]));
  }

  /**
   * Hasta dónde leyó la otra punta (la que no es la de quien mira) en cada
   * conversación, en mensajes visibles (`lecturaVisibleDeLaPunta`).
   */
  async lecturaDeLaOtraParte(
    conversationIds: string[],
    party: string,
  ): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const filas: Array<{ conversation_id: string; last_read_seq: string }> =
      await this.dataSource.query(
        `SELECT p."conversation_id", ${lecturaVisibleDeLaPunta('p')} AS "last_read_seq"
           FROM "conversation_party" p
          WHERE p."conversation_id" = ANY($1::uuid[]) AND p."party" <> $2`,
        [conversationIds, party],
      );
    return new Map(
      filas.map((f) => [f.conversation_id, Number(f.last_read_seq)]),
    );
  }

  /** Hasta dónde leyó esa persona en cada conversación. */
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

  /**
   * El último mensaje visible de cada conversación: las notas internas nunca
   * (ni para el personal: la vista previa de la lista es la de la charla con
   * la persona, y el cliente o el chofer no pueden enterarse de que hubo una).
   */
  /** Los adjuntos de los mensajes de adjunto (CH7), por `messageId`. */
  adjuntos(mensajes: readonly Message[]): Promise<Map<string, Attachment>> {
    return adjuntosDeLosMensajes(this.dataSource.manager, mensajes);
  }

  async ultimos(conversationIds: string[]): Promise<Map<string, Message>> {
    if (conversationIds.length === 0) return new Map();
    const filas = await this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .distinctOn(['m.conversationId'])
      .where('m.conversationId IN (:...ids)', { ids: conversationIds })
      .andWhere("m.visibility = 'all'")
      .orderBy('m.conversationId')
      .addOrderBy('m.seq', 'DESC')
      .getMany();
    return new Map(filas.map((m) => [m.conversationId, m]));
  }

  /** A quiénes menciona cada nota interna, por `messageId` (sólo para el personal). */
  async menciones(
    messageIds: readonly string[],
  ): Promise<Map<string, MencionDeLaNota[]>> {
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) return new Map();
    const filas: Array<{
      message_id: string;
      user_id: string;
      full_name: string | null;
    }> = await this.dataSource.query(
      `SELECT mm."message_id", mm."mentioned_user_id" AS user_id, u."full_name"
         FROM "message_mention" mm
         JOIN "user" u ON u."user_id" = mm."mentioned_user_id"
        WHERE mm."message_id" = ANY($1::uuid[])
        ORDER BY u."full_name" ASC NULLS LAST, mm."mentioned_user_id" ASC`,
      [ids],
    );
    const porNota = new Map<string, MencionDeLaNota[]>();
    for (const f of filas) {
      const lista = porNota.get(f.message_id) ?? [];
      lista.push({ userId: f.user_id, fullName: f.full_name ?? 'Sin nombre' });
      porNota.set(f.message_id, lista);
    }
    return porNota;
  }

  /**
   * La encuesta del último cierre de cada conversación (4b). Las
   * conversaciones ya vienen filtradas por la empresa y por quien pide.
   */
  async encuestas(
    conversationIds: string[],
  ): Promise<Map<string, ConversationRating>> {
    if (conversationIds.length === 0) return new Map();
    const filas = await this.dataSource
      .getRepository(ConversationRating)
      .createQueryBuilder('r')
      .distinctOn(['r.conversationId'])
      .where('r.conversationId IN (:...ids)', { ids: conversationIds })
      .orderBy('r.conversationId')
      .addOrderBy('r.requestedAt', 'DESC')
      .getMany();
    return new Map(filas.map((r) => [r.conversationId, r]));
  }

  /**
   * El `seq` del primer mensaje del asistente de cada conversación (respuesta
   * automática o aviso de recibido, visible): ahí van los botones de acción
   * del cliente (4e).
   */
  async primerMensajeDelAsistente(
    conversationIds: readonly string[],
  ): Promise<Map<string, number>> {
    const ids = [...new Set(conversationIds)];
    if (ids.length === 0) return new Map();
    const filas: Array<{ conversation_id: string; seq: string }> =
      await this.dataSource.query(
        `SELECT "conversation_id", min("seq") AS seq FROM "message"
          WHERE "conversation_id" = ANY($1::uuid[]) AND "sender_party" = 'system'
            AND "visibility" = 'all'
            AND ("kind" = 'auto_reply' OR "system_code" = 'received_ack')
          GROUP BY "conversation_id"`,
        [ids],
      );
    return new Map(filas.map((f) => [f.conversation_id, Number(f.seq)]));
  }

  /**
   * Menciones sin leer a esa persona en cada conversación (las conversaciones
   * ya vienen filtradas por la empresa y los canales de quien pide).
   */
  async mencionesSinLeer(
    conversationIds: string[],
    userId: string,
  ): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const filas: Array<{ conversation_id: string; n: string }> =
      await this.dataSource.query(
        `SELECT "conversation_id", count(*) AS n FROM "message_mention"
          WHERE "conversation_id" = ANY($1::uuid[]) AND "mentioned_user_id" = $2
            AND "read_at" IS NULL
          GROUP BY "conversation_id"`,
        [conversationIds, userId],
      );
    return new Map(filas.map((f) => [f.conversation_id, Number(f.n)]));
  }

  /**
   * Las etiquetas vigentes puestas en cada conversación (tanda 7c), por
   * nombre. Sólo las de la empresa de cada conversación (el vínculo y la
   * etiqueta comparten `distributor_id` por la FK compuesta).
   */
  async etiquetas(
    conversationIds: string[],
  ): Promise<Map<string, EtiquetaDeLaConversacion[]>> {
    if (conversationIds.length === 0) return new Map();
    const filas: Array<{
      conversation_id: string;
      label_id: string;
      name: string;
      color: string;
    }> = await this.dataSource.query(SQL_ETIQUETAS_DE_LAS_CONVERSACIONES, [
      conversationIds,
    ]);
    const r = new Map<string, EtiquetaDeLaConversacion[]>();
    for (const f of filas) {
      const de = r.get(f.conversation_id) ?? [];
      de.push({ id: f.label_id, name: f.name, color: f.color });
      r.set(f.conversation_id, de);
    }
    return r;
  }

  /** Los mensajes a los que responden otros, por `conversationId:seq`. */
  async respondidos(
    mensajes: readonly Message[],
  ): Promise<Map<string, Message>> {
    const pares = mensajes
      .filter((m) => m.replyToSeq !== null)
      .map((m) => [m.conversationId, m.replyToSeq as number] as const);
    if (pares.length === 0) return new Map();
    const ids: Array<{ message_id: string }> = await this.dataSource.query(
      `SELECT m."message_id" FROM "message" m
         JOIN unnest($1::uuid[], $2::bigint[]) AS p(conversation_id, seq)
           ON m."conversation_id" = p.conversation_id AND m."seq" = p.seq`,
      [pares.map(([c]) => c), pares.map(([, s]) => s)],
    );
    if (ids.length === 0) return new Map();
    const filas = await this.dataSource
      .getRepository(Message)
      .findBy({ messageId: In(ids.map((f) => f.message_id)) });
    return new Map(filas.map((m) => [`${m.conversationId}:${m.seq}`, m]));
  }

  /** Cuándo escribió por primera vez el cliente o el chofer en cada conversación. */
  async primerMensajeEntrante(
    conversationIds: string[],
  ): Promise<Map<string, Date>> {
    if (conversationIds.length === 0) return new Map();
    const filas: Array<{ conversation_id: string; at: Date }> =
      await this.dataSource.query(
        `SELECT "conversation_id", min("created_at") AS at FROM "message"
          WHERE "conversation_id" = ANY($1::uuid[])
            AND "sender_party" IN ('customer', 'driver')
          GROUP BY "conversation_id"`,
        [conversationIds],
      );
    return new Map(filas.map((f) => [f.conversation_id, new Date(f.at)]));
  }

  /**
   * De esos mensajes, los que quedaron atados (D-C22, D-C23): conversación por
   * un pedido, anteriores al reclamo creado desde el hilo, citados en un
   * reclamo o un ticket, o citados en una respuesta. La misma regla que
   * `BandejaService.ataduras` (la del PATCH), para todos de una vez: el `canEdit`
   * no promete lo que el PATCH va a rechazar.
   */
  async atados(messageIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) return new Set();
    const filas: Array<{ message_id: string }> = await this.dataSource.query(
      `SELECT m."message_id"
         FROM "message" m
         JOIN "conversation" c ON c."conversation_id" = m."conversation_id"
        WHERE m."message_id" = ANY($1::uuid[])
          AND (c."subject_type" = 'order'
               OR EXISTS (SELECT 1 FROM "claims" cl
                           WHERE cl."claim_id" = c."linked_claim_id"
                             AND cl."createdAt" >= m."created_at")
               OR EXISTS (SELECT 1 FROM "support_ticket_message_link" l
                           WHERE l."message_id" = m."message_id")
               OR EXISTS (SELECT 1 FROM "message" r
                           WHERE r."conversation_id" = m."conversation_id"
                             AND r."reply_to_seq" = m."seq"))`,
      [ids],
    );
    return new Set(filas.map((f) => f.message_id));
  }

  /**
   * El resumen de la bandeja para las insignias, en una sola consulta: de las
   * abiertas de esos canales de la empresa, sin asignar, asignadas a quien
   * pide, esperando a una persona (el asistente las derivó), con algo sin leer
   * para quien pide (la misma regla que `noLeidos`, sin las asignadas a otra
   * persona: ésas las atiende ella), las que piden atención (sin asignar ∪
   * esperando persona ∪ sin leer, contadas una vez) y las menciones sin leer
   * a quien pide (en notas de conversaciones de esos canales, abiertas o no).
   */
  async resumen(
    distributorId: string,
    canales: readonly string[],
    quien: Lector,
  ): Promise<ResumenDeLaBandeja> {
    const sinLeer = `(c."assigned_to_user_id" IS NULL OR c."assigned_to_user_id" = $3)
                 AND EXISTS (
                SELECT 1 FROM "message" m
                 WHERE m."conversation_id" = c."conversation_id"
                   AND ${condicionDeNoLeidoEnLaBandeja('$4')})`;
    const [fila]: Array<Record<string, string>> = await this.dataSource.query(
      `SELECT count(*) FILTER (WHERE c."assigned_to_user_id" IS NULL) AS unassigned,
              count(*) FILTER (WHERE c."assigned_to_user_id" = $3) AS mine,
              count(*) FILTER (WHERE c."awaiting_human_since" IS NOT NULL) AS awaiting,
              count(*) FILTER (WHERE ${sinLeer}) AS unread,
              count(*) FILTER (WHERE c."assigned_to_user_id" IS NULL
                                  OR c."awaiting_human_since" IS NOT NULL
                                  OR (${sinLeer})) AS attention,
              (SELECT count(*) FROM "message_mention" mm
                 JOIN "conversation" cm ON cm."conversation_id" = mm."conversation_id"
                WHERE mm."distributor_id" = $1 AND mm."mentioned_user_id" = $3
                  AND mm."read_at" IS NULL AND cm."channel" = ANY($2::text[])
                  AND cm."deleted_at" IS NULL) AS mentions
         FROM "conversation" c
         LEFT JOIN "conversation_read_state" r
           ON r."conversation_id" = c."conversation_id" AND r."user_id" = $3
        WHERE c."distributor_id" = $1 AND c."channel" = ANY($2::text[])
          AND c."status" = 'open' AND c."deleted_at" IS NULL`,
      [distributorId, [...canales], quien.userId, quien.party],
    );
    return {
      unassigned: Number(fila?.unassigned ?? 0),
      mine: Number(fila?.mine ?? 0),
      awaitingHuman: Number(fila?.awaiting ?? 0),
      unread: Number(fila?.unread ?? 0),
      attention: Number(fila?.attention ?? 0),
      mentions: Number(fila?.mentions ?? 0),
    };
  }

  /**
   * El personal vigente de la empresa (usuario sin baja ni bloqueo) con su rol
   * de personal vigente: lo que hace falta para saber quién atiende un canal.
   * Sólo de esa empresa.
   */
  /**
   * El personal vigente de la empresa. Dentro de una transacción (el reparto
   * de la asignación automática, 8b) se pasa su `manager`: así no pide una
   * segunda conexión del pool mientras tiene el cerrojo.
   */
  async personalDeLaEmpresa(
    distributorId: string,
    consulta: Pick<EntityManager, 'query'> = this.dataSource,
  ): Promise<PersonaDelPersonal[]> {
    const filas: Array<{
      user_id: string;
      full_name: string | null;
      photo_key: string | null;
      is_system: boolean;
      permissions: string[] | null;
    }> = await consulta.query(
      `SELECT u."user_id", u."full_name", u."photo_key", sr."is_system", sr."permissions"
         FROM "admin" a
         JOIN "user" u ON u."user_id" = a."user_id"
         JOIN "staff_role" sr ON sr."staff_role_id" = a."staff_role_id" AND sr."deletedAt" IS NULL
        WHERE a."distributor_id" = $1
          AND u."deletedAt" IS NULL AND u."blocked" = false
        ORDER BY u."full_name" ASC NULLS LAST, u."user_id" ASC`,
      [distributorId],
    );
    return filas.map((f) => ({
      userId: f.user_id,
      fullName: f.full_name ?? 'Sin nombre',
      photoKey: f.photo_key,
      todos: f.is_system,
      permisos: f.permissions ?? [],
    }));
  }

  /** El personal de la empresa con su rol (para asignar): `null` si no es de esa empresa. */
  async adminDeLaEmpresa(
    userId: string,
    distributorId: string,
  ): Promise<boolean> {
    const filas: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "admin" a JOIN "user" u ON u."user_id" = a."user_id"
        WHERE a."user_id" = $1 AND a."distributor_id" = $2
          AND u."deletedAt" IS NULL AND u."blocked" = false`,
      [userId, distributorId],
    );
    return filas.length > 0;
  }
}
