import { ApiProperty } from '@nestjs/swagger';

/** Respuesta de `GET /claims/:id/photo?modo=url`. */
export class ClaimPhotoLinkResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL firmada de S3, se abre sin token. `null` si no tiene foto.',
  })
  url!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo vence la URL; `null` si no hay foto.',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    description: 'Siempre `false`: la URL firmada se abre sin token.',
  })
  requiresAuth!: boolean;
}
