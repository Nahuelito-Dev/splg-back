import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsOptional, Matches } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { OrderStatus } from '../entities/order.entity';

/**
 * El filtro acepta el vocabulario de `OrderResponseDto.status`: la respuesta
 * muestra `on_the_way` como `out_for_delivery`, así que filtrar con lo que se
 * recibió tiene que funcionar.
 */
export const ESTADOS_DE_LA_RESPUESTA = [
  'reserved',
  'pending',
  'accepted',
  'out_for_delivery',
  'delivered',
  'cancelled',
] as const;

/**
 * Consulta de `GET /orders`, para el panel. Extiende la paginación con
 * `term` (ya en `PaginationDto`) más filtros propios del listado.
 */
export class QueryOrdersDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: ESTADOS_DE_LA_RESPUESTA,
    description:
      'Filtra por estado, con los mismos valores que devuelve la respuesta ' +
      '(`out_for_delivery` es el pedido en camino)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'out_for_delivery' ? OrderStatus.ON_THE_WAY : value,
  )
  @IsEnum(OrderStatus, {
    message: 'status debe ser un estado de pedido válido',
  })
  status?: OrderStatus;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-09-01',
    description: 'Fecha desde (inclusive), en formato YYYY-MM-DD',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from debe tener formato YYYY-MM-DD',
  })
  @IsDateString({ strict: true }, { message: 'from no es una fecha válida' })
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-09-30',
    description: 'Fecha hasta (inclusive, en la fecha local), YYYY-MM-DD',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to debe tener formato YYYY-MM-DD',
  })
  @IsDateString({ strict: true }, { message: 'to no es una fecha válida' })
  to?: string;
}
