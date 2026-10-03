import { ApiProperty } from '@nestjs/swagger';
import { AttachmentOwnerType } from '../entities/attachment.entity';

/**
 * No incluye `storageKey`: es un detalle de infraestructura (dónde vive el
 * archivo en disco o en S3), no algo que el panel necesite.
 */
export class AttachmentResponseDto {
  @ApiProperty({ format: 'uuid' }) attachmentId!: string;
  @ApiProperty({ enum: AttachmentOwnerType, enumName: 'AttachmentOwnerType' })
  ownerType!: AttachmentOwnerType;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'DNI frente' })
  label!: string | null;
  @ApiProperty({ example: 'dni-frente.jpg' }) originalName!: string;
  @ApiProperty({ example: 'image/jpeg' }) mimeType!: string;
  @ApiProperty({ example: 245678 }) sizeBytes!: number;
  @ApiProperty({ format: 'uuid' }) uploadedByUserId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) uploadedAt!: Date;
}
