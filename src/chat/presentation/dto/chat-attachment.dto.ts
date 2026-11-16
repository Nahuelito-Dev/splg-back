import {
  ApiProperty,
  ApiPropertyOptional,
  type ApiBodyOptions,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AttachmentScanStatus } from '../../../attachment/attachment-scan-status';
import { LARGO_DEL_EPIGRAFE } from '../../domain/adjuntos';

/**
 * El adjunto de un mensaje (`kind = 'attachment'`, CH7). Sin URL: la URL
 * firmada se pide aparte (`GET …/messages/:messageId/attachment`), cuando se
 * va a mostrar o bajar.
 */
export class ChatAttachmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'remito-octubre.pdf' }) fileName!: string;
  @ApiProperty({
    example: 'application/pdf',
    description: 'El tipo que detectó el back por el contenido del archivo',
  })
  mimeType!: string;
  @ApiProperty({
    description: 'Tamaño guardado (una foto, ya re-codificada sin EXIF)',
  })
  sizeBytes!: number;
  @ApiProperty({
    enum: AttachmentScanStatus,
    enumName: 'AttachmentScanStatus',
    description:
      '`clean` se puede ver; `pending` «Verificando archivo…» (la descarga da 409); `infected` bloqueado (oculto, la descarga da 404); `failed` no se pudo verificar todavía (se reintenta solo; la descarga da 409 para todos).',
  })
  scanStatus!: AttachmentScanStatus;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Ancho en píxeles (sólo fotos)',
  })
  width!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Alto en píxeles (sólo fotos)',
  })
  height!: number | null;
}

/** Quita los espacios de los extremos; un epígrafe en blanco queda sin epígrafe. */
const Recortar = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  );

/** Los campos de texto del multipart de un adjunto; el archivo va en `file`. */
export class SendAttachmentDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Lo genera quien escribe. El mismo id repetido devuelve el mensaje ya guardado (200) sin volver a subir el archivo.',
  })
  @IsUUID('4')
  clientMessageId!: string;

  @ApiPropertyOptional({
    maxLength: LARGO_DEL_EPIGRAFE,
    example: 'El remito de hoy',
    description: 'Epígrafe opcional de la foto o el archivo',
  })
  @IsOptional()
  @Recortar()
  @IsString()
  @MaxLength(LARGO_DEL_EPIGRAFE)
  caption?: string;
}

/** Esquema del multipart para Swagger. */
export const CUERPO_DEL_ADJUNTO: ApiBodyOptions = {
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', format: 'binary' },
      clientMessageId: { type: 'string', format: 'uuid' },
      caption: { type: 'string', maxLength: LARGO_DEL_EPIGRAFE },
    },
    required: ['file', 'clientMessageId'],
  },
};
