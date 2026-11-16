import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  NuevoMensaje,
  MensajesRepositorio,
} from '../application/mensajes.port';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';

/** Adaptador del envío sobre Postgres (TypeORM). */
@Injectable()
export class TypeormMensajesRepository extends MensajesRepositorio {
  bloquearConversacion(
    manager: EntityManager,
    conversationId: string,
    distributorId: string,
  ): Promise<Conversation | null> {
    return manager.getRepository(Conversation).findOne({
      where: { conversationId, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  buscarPorClientId(
    manager: EntityManager,
    conversationId: string,
    senderUserId: string,
    clientMessageId: string,
  ): Promise<Message | null> {
    return manager.getRepository(Message).findOne({
      where: { conversationId, senderUserId, clientMessageId },
    });
  }

  /**
   * Un `UPDATE ... RETURNING`: el contador sube en la misma transacción que
   * el mensaje y vuelve atrás si ésta se revierte. Los `last_message_*` no se
   * auditan (el mensaje tiene su propio asiento).
   */
  async siguienteSeq(
    manager: EntityManager,
    conversation: Conversation,
    vistaPrevia: string | null,
    visible = true,
  ): Promise<number> {
    const filas: unknown = await manager.query(
      `UPDATE "conversation"
          SET "last_message_seq" = "last_message_seq" + 1,
              "last_message_at" = CASE WHEN $4 THEN now() ELSE "last_message_at" END,
              "last_message_preview" = COALESCE($3, "last_message_preview"),
              "updated_at" = CASE WHEN $4 THEN now() ELSE "updated_at" END
        WHERE "conversation_id" = $1 AND "distributor_id" = $2
        RETURNING "last_message_seq" AS seq`,
      [
        conversation.conversationId,
        conversation.distributorId,
        vistaPrevia,
        visible,
      ],
    );
    return Number(primeraFila(filas).seq);
  }

  mensajePorSeq(
    manager: EntityManager,
    conversationId: string,
    seq: number,
  ): Promise<Message | null> {
    return manager
      .getRepository(Message)
      .findOne({ where: { conversationId, seq } });
  }

  insertar(
    manager: EntityManager,
    mensaje: NuevoMensaje & { seq: number },
  ): Promise<Message> {
    const repo = manager.getRepository(Message);
    return repo.save(
      repo.create({
        conversationId: mensaje.conversationId,
        distributorId: mensaje.distributorId,
        seq: mensaje.seq,
        clientMessageId: mensaje.clientMessageId,
        senderParty: mensaje.senderParty,
        senderUserId: mensaje.senderUserId,
        kind: mensaje.kind,
        visibility: mensaje.visibility,
        payload: mensaje.payload,
        body: mensaje.body,
        bodyFiltered: false,
        templateKey: mensaje.templateKey,
        systemCode: mensaje.systemCode,
        replyToSeq: mensaje.replyToSeq ?? null,
        replyToPreview: mensaje.replyToPreview ?? null,
        editedAt: null,
        withdrawnAt: null,
        withdrawnByUserId: null,
        redactedAt: null,
      }),
    );
  }
}

/**
 * La primera fila de un `UPDATE ... RETURNING` (el driver de Postgres devuelve
 * `[filas, cantidad]`).
 */
function primeraFila(resultado: unknown): { seq: unknown } {
  const filas: unknown =
    Array.isArray(resultado) && Array.isArray(resultado[0])
      ? resultado[0]
      : resultado;
  const fila: unknown = Array.isArray(filas) ? filas[0] : undefined;
  if (typeof fila !== 'object' || fila === null || !('seq' in fila)) {
    throw new InternalServerErrorException('No se pudo numerar el mensaje');
  }
  return fila;
}
