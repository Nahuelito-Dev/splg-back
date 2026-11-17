import { In, type EntityManager } from 'typeorm';
import {
  Attachment,
  AttachmentOwnerType,
} from '../../attachment/entities/attachment.entity';
import { MessageKind } from '../domain/chat.enums';
import type { Message } from '../entities/message.entity';

/**
 * Los adjuntos vigentes de los mensajes de adjunto, por `messageId`, en una
 * sola consulta. Uno dado de baja (al redactar el mensaje) no viene.
 */
export async function adjuntosDeLosMensajes(
  manager: EntityManager,
  mensajes: readonly Pick<Message, 'messageId' | 'kind'>[],
): Promise<Map<string, Attachment>> {
  const ids = [
    ...new Set(
      mensajes
        .filter((m) => m.kind === MessageKind.ATTACHMENT)
        .map((m) => m.messageId),
    ),
  ];
  if (ids.length === 0) return new Map();
  const filas = await manager.getRepository(Attachment).find({
    where: { ownerType: AttachmentOwnerType.CHAT_MESSAGE, messageId: In(ids) },
  });
  return new Map(filas.map((a) => [a.messageId as string, a]));
}
