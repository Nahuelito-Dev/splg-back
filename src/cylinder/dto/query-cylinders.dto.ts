import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { CylinderState } from '../entities/cylinder.entity';
import {
  FILTROS_DE_VIGENCIA,
  type FiltroDeVigencia,
} from '../domain/cylinder-vigencia';

/** `GET /cylinders`: filtros combinables y paginación opcional. */
export class QueryCylindersDto {
  @ApiPropertyOptional({ enum: CylinderState })
  @IsOptional()
  @IsEnum(CylinderState)
  state?: CylinderState;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Los envases que salieron en ese pedido: los que lo tienen como pedido ' +
      'actual o que registraron algún movimiento en él. Un pedido ya ' +
      'entregado sigue mostrando sus series.',
  })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'user_id del cliente (el mismo que `customer_id` de un pedido y ' +
      '`user_id` de un cliente; NO el `customer_id` del perfil). Devuelve los ' +
      'envases que tiene hoy en su poder.',
  })
  @IsOptional()
  @IsUUID()
  customerUserId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Tipo de producto del envase (para buscar un reemplazo).',
  })
  @IsOptional()
  @IsUUID()
  gasCylinderId?: string;

  @ApiPropertyOptional({
    enum: FILTROS_DE_VIGENCIA,
    description:
      'Vigencia de la revisión: `valid` (no venció), `expired` (venció, no ' +
      'se puede despachar), `unverified` (sin revisión registrada) o ' +
      '`dispatchable` (vigentes y sin revisión registrada: los que se pueden ' +
      'asignar a un pedido).',
  })
  @IsOptional()
  @IsIn(FILTROS_DE_VIGENCIA)
  vigencia?: FiltroDeVigencia;

  @ApiPropertyOptional({
    maximum: 100,
    description: 'Sin `limit` devuelve todos los envases.',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}
