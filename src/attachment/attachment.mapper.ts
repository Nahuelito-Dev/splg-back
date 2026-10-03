import { Attachment } from './entities/attachment.entity';
import { AttachmentResponseDto } from './dto/attachment-response.dto';

export class AttachmentMapper {
  static toDto(a: Attachment): AttachmentResponseDto {
    const dto = new AttachmentResponseDto();
    dto.attachmentId = a.attachmentId;
    dto.ownerType = a.ownerType;
    dto.ownerId = a.ownerId;
    dto.label = a.label;
    dto.originalName = a.originalName;
    dto.mimeType = a.mimeType;
    dto.sizeBytes = a.sizeBytes;
    dto.uploadedByUserId = a.uploadedByUserId;
    dto.uploadedAt = a.uploadedAt;
    return dto;
  }
}
