import type { Attachment } from '../../attachment/entities/attachment.entity';
import type { ChatAttachmentDto } from './dto/chat-attachment.dto';

/**
 * El adjunto como sale en el mensaje (sin URL). Nulo si el mensaje se redactó
 * (el adjunto quedó dado de baja) o si no tiene.
 */
export function adjuntoADto(
  a: Attachment | undefined,
  redactado: boolean,
): ChatAttachmentDto | null {
  if (!a || redactado) return null;
  return {
    id: a.attachmentId,
    fileName: a.originalName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    scanStatus: a.scanStatus,
    width: a.width,
    height: a.height,
  };
}
