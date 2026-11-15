import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Channel, MessageVisibility, Party } from '../domain/chat.enums';
import { ConversacionNoEncontradaError } from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import type { Lector } from '../infrastructure/chat-read-model';
import type { MessagesQueryDto } from '../presentation/dto/chat-input.dto';
import { ChatEvents } from './chat.events';

/** Una conversación de un canal, de una empresa (o de cualquiera, para la plataforma). */
export interface HiloBuscado {
  conversationId: string;
  channel: Channel;
  /** La empresa de quien pide; nula para la plataforma (ve todas). */
  distributorId: string | null;
}

/**
 * Lectura de los hilos (chat e hilo del ticket): páginas de mensajes por
 * `seq` y la marca de «leído». Una conversación de otra empresa o de otro
 * canal es 404; la empresa nunca recibe notas internas.
 */
@Injectable()
export class ChatThreadsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventos: ChatEvents,
  ) {}

  async buscar(
    hilo: HiloBuscado,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Conversation> {
    const c = await manager.getRepository(Conversation).findOne({
      where: {
        conversationId: hilo.conversationId,
        channel: hilo.channel,
        ...(hilo.distributorId ? { distributorId: hilo.distributorId } : {}),
      },
    });
    if (!c) throw new ConversacionNoEncontradaError();
    return c;
  }

  async mensajes(
    conversation: Conversation,
    quien: Lector,
    query: MessagesQueryDto,
  ): Promise<{ items: Message[]; hasMore: boolean }> {
    if (query.afterSeq !== undefined && query.beforeSeq !== undefined) {
      throw new BadRequestException(
        'Pedí los mensajes posteriores o los anteriores, no las dos cosas a la vez',
      );
    }
    const qb = this.dataSource
      .getRepository(Message)
      .createQueryBuilder('m')
      .where('m.conversationId = :id', { id: conversation.conversationId })
      .andWhere('m.distributorId = :dist', {
        dist: conversation.distributorId,
      });
    if (quien.party !== Party.PLATFORM) {
      qb.andWhere('m.visibility = :todos', { todos: MessageVisibility.ALL });
    }
    const limite = query.limit;
    if (query.afterSeq !== undefined) {
      const filas = await qb
        .andWhere('m.seq > :desde', { desde: query.afterSeq })
        .orderBy('m.seq', 'ASC')
        .take(limite + 1)
        .getMany();
      return { items: filas.slice(0, limite), hasMore: filas.length > limite };
    }
    if (query.beforeSeq !== undefined) {
      qb.andWhere('m.seq < :hasta', { hasta: query.beforeSeq });
    }
    const filas = await qb
      .orderBy('m.seq', 'DESC')
      .take(limite + 1)
      .getMany();
    return {
      items: filas.slice(0, limite).reverse(),
      hasMore: filas.length > limite,
    };
  }

  /**
   * Marca leído hasta `seq` para esa persona y, si sube, para su punta (lo que
   * la otra ve como «leído»). Avisa a las otras pestañas de la persona y, si
   * subió la punta, a la otra punta. Nunca baja (`GREATEST`); un número posterior al
   * último mensaje se toma como el último.
   */
  async leer(
    conversation: Conversation,
    quien: Lector,
    seq: number,
  ): Promise<void> {
    const hasta = Math.min(seq, conversation.lastMessageSeq);
    const subio = await this.dataSource.transaction(async (manager) => {
      const personal: unknown = await manager.query(
        `INSERT INTO "conversation_read_state" ("conversation_id", "user_id", "distributor_id", "last_read_seq", "updated_at")
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT ("conversation_id", "user_id") DO UPDATE
            SET "last_read_seq" = EXCLUDED."last_read_seq", "updated_at" = now()
          WHERE "conversation_read_state"."last_read_seq" < EXCLUDED."last_read_seq"
         RETURNING "last_read_seq"`,
        [
          conversation.conversationId,
          quien.userId,
          conversation.distributorId,
          hasta,
        ],
      );
      const filas: unknown = await manager.query(
        `UPDATE "conversation_party" SET "last_read_seq" = $3
          WHERE "conversation_id" = $1 AND "party" = $2 AND "last_read_seq" < $3
          RETURNING "last_read_seq"`,
        [conversation.conversationId, quien.party, hasta],
      );
      return { personal: huboFilas(personal), deLaParte: huboFilas(filas) };
    });
    if (subio.personal || subio.deLaParte) {
      this.eventos.lectura({
        conversationId: conversation.conversationId,
        distributorId: conversation.distributorId,
        channel: conversation.channel,
        party: quien.party,
        lastReadSeq: hasta,
        userId: quien.userId,
        ...subio,
      });
    }
  }
}

/** Un `UPDATE ... RETURNING` de Postgres devuelve `[filas, cantidad]`. */
function huboFilas(resultado: unknown): boolean {
  if (!Array.isArray(resultado)) return false;
  const filas: unknown = Array.isArray(resultado[0]) ? resultado[0] : resultado;
  return Array.isArray(filas) && filas.length > 0;
}
