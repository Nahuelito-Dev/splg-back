import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { CylinderState } from '../entities/cylinder.entity';

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
