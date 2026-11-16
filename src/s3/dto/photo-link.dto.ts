import { ApiProperty } from '@nestjs/swagger';

/** Respuesta de `GET .../photo?modo=url` de las entidades con foto. */
export class PhotoLinkResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL firmada de S3 (se abre sin token), o la URL externa que la entidad ' +
      'traía de antes. `null` si no tiene foto.',
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
    description: 'Siempre `false`: la URL firmada se abre sin token.',
  })
  requiresAuth!: boolean;
}

/** Respuesta de `PUT` y `DELETE .../photo` (API v2): el enlace vigente tras el cambio. */
export class PhotoCurrentResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL firmada de S3 de la foto vigente (se abre sin token); `null` si no tiene foto.',
  })
  url!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo vence la URL; `null` si no tiene foto.',
  })
  expiresAt!: Date | null;
}
