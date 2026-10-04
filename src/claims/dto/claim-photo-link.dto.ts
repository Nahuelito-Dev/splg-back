import { ApiProperty } from '@nestjs/swagger';

/** Respuesta de `GET /claims/:id/photo?modo=url`. */
export class ClaimPhotoLinkResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Foto subida con S3: URL firmada, se abre sin token. Foto subida con el ' +
      'driver local: la ruta de este mismo backend, que hay que pedir con el ' +
      'token. Reclamo con sólo una `photoUrl` externa (http/https): esa URL. ' +
      '`null` si no tiene foto.',
  })
  url!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo vence la URL; `null` si no vence (driver local) o no hay foto.',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    description:
      '`true` sólo con el driver local (la ruta del backend exige el token). ' +
      '`false` con URL firmada, con URL externa y sin foto.',
  })
  requiresAuth!: boolean;
}
