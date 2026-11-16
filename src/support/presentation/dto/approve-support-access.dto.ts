import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { SupportScope } from '../../domain/support-session.enums';
import { DURACIONES_PERMITIDAS } from '../../domain/support-session.machine';
import { Recortar } from './recortar';

/** Aprobación de un pedido de soporte: se puede acortar y achicar, no ampliar. */
export class ApproveSupportAccessDto {
  @ApiPropertyOptional({
    enum: DURACIONES_PERMITIDAS,
    description:
      'Minutos aprobados (igual o menos que lo pedido). Sin valor: lo pedido.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(DURACIONES_PERMITIDAS)
  minutes?: number;

  @ApiPropertyOptional({
    enum: SupportScope,
    isArray: true,
    description: 'Alcance aprobado (lo pedido o parte). Sin valor: lo pedido.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(SupportScope, { each: true })
  scope?: SupportScope[];

  @ApiPropertyOptional({ maxLength: 500, description: 'Nota de la decisión' })
  @IsOptional()
  @Recortar()
  @IsString()
  @MaxLength(500)
  note?: string;
}
