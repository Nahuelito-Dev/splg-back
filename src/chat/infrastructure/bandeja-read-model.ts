import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { idCortoDePedido } from '../../common/events/aviso-al-admin';
import { Message } from '../entities/message.entity';
import type { Lector } from './chat-read-model';
import { nombreVisibleDeLaEmpresa } from './nombre-visible-de-la-empresa';

/** El pedido de una conversación, como lo muestra la bandeja. */
export interface PedidoDeLaConversacion {
  id: string;
  number: string;
  status: string;
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
            AND m."deleted_at" IS NULL
            AND m."withdrawn_at" IS NULL
            AND m."seq" > COALESCE(r."last_read_seq", 0)
            AND m."sender_party" <> $3
            AND m."kind" <> 'system'
            AND NOT ($3 = 'company' AND m."kind" = 'auto_reply')
          GROUP BY m."conversation_id"`,
        [conversationIds, quien.userId, quien.party],
      );
    return new Map(filas.map((f) => [f.conversation_id, Number(f.n)]));
  }

  /** Hasta dónde leyó la otra punta (la que no es la de quien mira) en cada conversación. */
  async lecturaDeLaOtraParte(
    conversationIds: string[],
    party: string,
  ): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const filas: Array<{ conversation_id: string; last_read_seq: string }> =
      await this.dataSource.query(
        `SELECT "conversation_id", "last_read_seq" FROM "conversation_party"
          WHERE "conversation_id" = ANY($1::uuid[]) AND "party" <> $2`,
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

  /** El último mensaje de cada conversación (en la bandeja no hay notas internas). */
  async ultimos(conversationIds: string[]): Promise<Map<string, Message>> {
    if (conversationIds.length === 0) return new Map();
    const filas = await this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .distinctOn(['m.conversationId'])
      .where('m.conversationId IN (:...ids)', { ids: conversationIds })
      .orderBy('m.conversationId')
      .addOrderBy('m.seq', 'DESC')
      .getMany();
    return new Map(filas.map((m) => [m.conversationId, m]));
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
