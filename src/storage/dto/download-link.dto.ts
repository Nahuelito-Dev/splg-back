import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

/** Cómo quiere el cliente recibir un archivo. */
export enum DownloadMode {
  /** `{ url, expiresAt }`: el cliente baja el archivo por su cuenta. */
  URL = 'url',
  /** El archivo mismo (redirección a la URL firmada o streaming). */
  FILE = 'archivo',
}

export class DownloadQueryDto {
  @ApiProperty({
    enum: DownloadMode,
    enumName: 'DownloadMode',
    required: false,
    description:
      '`url` devuelve `{ url, expiresAt }` en JSON (sin redirect: sirve para ' +
      'el panel y las apps, que no siguen un 302 cross-origin con el token). ' +
      '`archivo` devuelve el archivo (302 a la URL firmada con S3, streaming con ' +
      'el driver local).',
  })
  @IsOptional()
  @IsEnum(DownloadMode)
  modo?: DownloadMode;
}

export class DownloadLinkResponseDto {
  @ApiProperty({
    description:
      'Con S3: URL firmada, se abre sin token. Con el driver local: la ruta ' +
      'de este mismo backend, que hay que pedir con el token.',
  })
  url!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo vence la URL; `null` si no vence (driver local).',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    description: '`true` si pedir `url` exige el token de la sesión.',
  })
  requiresAuth!: boolean;
}
