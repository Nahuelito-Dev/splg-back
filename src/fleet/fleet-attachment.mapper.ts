import { MaintenanceTaskAttachment } from './entities/maintenance-task-attachment.entity';
import { FleetTaskAttachmentResponseDto } from './dto/attachment-response.dto';

export class FleetAttachmentMapper {
  static toDto(a: MaintenanceTaskAttachment): FleetTaskAttachmentResponseDto {
    const dto = new FleetTaskAttachmentResponseDto();
    dto.attachmentId = a.attachmentId;
    dto.taskId = a.taskId;
    dto.originalName = a.originalName;
    dto.mimeType = a.mimeType;
    dto.sizeBytes = a.sizeBytes;
    dto.uploadedByUserId = a.uploadedByUserId;
    dto.uploadedAt = a.uploadedAt;
    return dto;
  }
}
