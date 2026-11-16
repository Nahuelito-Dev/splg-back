import { ApiProperty } from '@nestjs/swagger';

/**
 * No incluye `storageKey`: es un detalle de infraestructura (dónde vive el
 * archivo en disco o en S3), no algo que el panel necesite.
 */
export class FleetTaskAttachmentResponseDto {
  @ApiProperty({ format: 'uuid' }) attachmentId!: string;
  @ApiProperty({ format: 'uuid' }) taskId!: string;
  @ApiProperty({ example: 'poliza-2026.pdf' }) originalName!: string;
  @ApiProperty({ example: 'application/pdf' }) mimeType!: string;
  @ApiProperty({ example: 245678 }) sizeBytes!: number;
  @ApiProperty({ format: 'uuid' }) uploadedByUserId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) uploadedAt!: Date;
}
