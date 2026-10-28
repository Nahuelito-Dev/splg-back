import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';

/**
 * Un adjunto del pedido con su enlace de descarga firmado y de corta vida.
 * Para el cliente son sólo los comprobantes de transferencia y no trae
 * `uploadedByUserId`.
 */
export class OrderReceiptFileDto {
  @ApiProperty({ format: 'uuid' }) attachmentId!: string;
  @ApiProperty({ enum: AttachmentOwnerType, enumName: 'AttachmentOwnerType' })
  ownerType!: AttachmentOwnerType;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Comprobante de transferencia',
  })
  label!: string | null;
  @ApiProperty({ example: 'comprobante.jpg' }) originalName!: string;
  @ApiProperty({ example: 'image/jpeg' }) mimeType!: string;
  @ApiProperty({ example: 245678 }) sizeBytes!: number;
  @ApiProperty({ type: String, format: 'date-time' }) uploadedAt!: Date;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Quién lo subió. Sólo lo ven admin y super admin.',
  })
  uploadedByUserId?: string;

  @ApiProperty({
    description:
      'URL firmada de S3, se abre sin token. Los PDF y las imágenes se muestran en el navegador; cualquier otro tipo se descarga.',
  })
  url!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;
}
