import { DocumentReadingDto } from './dto/document-reading.dto';
import { DocumentReading } from './entities/document-reading.entity';

export const DocumentReadingMapper = {
  toDto(r: DocumentReading): DocumentReadingDto {
    const dto: DocumentReadingDto = {
      readingId: r.readingId,
      attachmentId: r.attachmentId,
      status: r.status,
      expectedType: r.expectedType,
      detectedType: r.detectedType,
      legible: r.legible,
      fields: r.fields,
      warnings: r.warnings,
      duplicateOfId: r.duplicateOfId,
      model: r.model,
      costUsd: Number(r.costUsd),
      attempts: r.attempts,
      lastError: r.lastError,
      proposal: r.proposal,
      proposalExpiresAt: r.proposalExpiresAt?.toISOString() ?? null,
      remindedAt: r.remindedAt?.toISOString() ?? null,
      escalatedAt: r.escalatedAt?.toISOString() ?? null,
      reconciledAt: r.reconciledAt?.toISOString() ?? null,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    };
    if (r.attachment) {
      dto.attachment = {
        attachmentId: r.attachment.attachmentId,
        originalName: r.attachment.originalName,
        mimeType: r.attachment.mimeType,
        ownerType: r.attachment.ownerType,
        ownerId: r.attachment.ownerId,
      };
    }
    return dto;
  },
};
