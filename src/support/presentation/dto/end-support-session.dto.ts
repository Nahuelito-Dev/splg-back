import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { Recortar } from './recortar';

/** Cuerpo opcional de `DELETE /v2/support-sessions/:id`. */
export class EndSupportSessionDto {
  @ApiPropertyOptional({
    minLength: 20,
    maxLength: 1000,
    description:
      'Obligatorio para cortar la sesión de otro administrador general: por qué se corta. Queda en la auditoría.',
  })
  @IsOptional()
  @Recortar()
  @IsString()
  @Length(20, 1000)
  reason?: string;
}
