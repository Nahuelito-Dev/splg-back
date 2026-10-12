import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

/** Cómo quiere el cliente recibir un archivo. */
export enum DownloadMode {
  /** `{ url, expiresAt, requiresAuth }`: el cliente baja el archivo por su cuenta. */
  URL = 'url',
  /** El archivo mismo (redirección 302 a la URL firmada de S3). */
  FILE = 'archivo',
}

/** Cómo entrega el navegador el archivo de la URL firmada. */
export enum DownloadDisposition {
  /** Lo baja (`Content-Disposition: attachment`). Es el valor por defecto. */
  ATTACHMENT = 'attachment',
  /** Lo muestra en el navegador. Sólo PDF e imágenes; el resto se baja igual. */
  INLINE = 'inline',
}

export class DownloadQueryDto {
  @ApiProperty({
    enum: DownloadMode,
    enumName: 'DownloadMode',
    required: false,
    description:
      '`url` devuelve `{ url, expiresAt, requiresAuth }` en JSON (sin redirect: sirve para ' +
      'el panel y las apps, que no siguen un 302 cross-origin con el token). ' +
      '`archivo` devuelve el archivo (302 a la URL firmada de S3).',
  })
  @IsOptional()
  @IsEnum(DownloadMode)
  modo?: DownloadMode;
}

/** Descarga de adjuntos (documentos): además del modo, cómo se muestra. */
export class DownloadAttachmentQueryDto extends DownloadQueryDto {
  @ApiProperty({
    enum: DownloadDisposition,
    enumName: 'DownloadDisposition',
    required: false,
    description:
      '`attachment` (por defecto) baja el archivo; `inline` lo muestra en el ' +
      'navegador. `inline` sólo se respeta para PDF, JPG, PNG, WEBP y GIF: ' +
      'cualquier otro tipo (HTML, SVG...) se entrega como `attachment`.',
  })
  @IsOptional()
  @IsEnum(DownloadDisposition)
  disposicion?: DownloadDisposition;
}

export class DownloadLinkResponseDto {
  @ApiProperty({
    description: 'URL firmada de S3: se abre sin token.',
  })
  url!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo vence la URL; `null` si no vence (p. ej. la URL externa de un reclamo viejo).',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    description:
      'Siempre `false`: la URL firmada se abre sin token. Se conserva en el ' +
      'contrato por compatibilidad con el panel y las apps.',
  })
  requiresAuth!: boolean;
}
