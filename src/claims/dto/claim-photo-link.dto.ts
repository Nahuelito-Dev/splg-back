import { ApiProperty } from '@nestjs/swagger';

/** Respuesta de `GET /claims/:id/photo?modo=url`. */
export class ClaimPhotoLinkResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Foto subida: URL firmada de S3, se abre sin token. Reclamo con sólo una `photoUrl` externa (http/https): esa URL. ' +
      '`null` si no tiene foto.',
  })
  url!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo vence la URL; `null` si no vence (URL externa) o no hay foto.',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    description:
      '`false` con URL firmada, con URL externa y sin foto (no hay descargas ' +
      'que exijan el token de la sesión).',
  })
  requiresAuth!: boolean;
}
