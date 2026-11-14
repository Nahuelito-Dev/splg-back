import { ApiProperty } from '@nestjs/swagger';

/** Los datos públicos de la plataforma (no de una distribuidora). */
export class PlatformResponseDto {
  @ApiProperty({
    example: 'SPLG',
    description: 'Nombre comercial de la plataforma',
  })
  name!: string;

  @ApiProperty({ example: 'SPLG', description: 'Razón social' })
  legalName!: string;

  @ApiProperty({
    example: 'soporte@example.com',
    nullable: true,
    type: String,
    description: 'Correo de contacto del soporte; null si no se configuró',
  })
  supportEmail!: string | null;
}
