import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Recortar } from './recortar';

/** Rechazo de un pedido de soporte, con nota opcional. */
export class RejectSupportAccessDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'Por qué se rechaza' })
  @IsOptional()
  @Recortar()
  @IsString()
  @MaxLength(500)
  note?: string;
}
