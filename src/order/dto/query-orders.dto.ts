import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  Matches,
} from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { OrderStatus, PaymentStatus } from '../entities/order.entity';

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

export const ORDEN_DE_PEDIDOS = ['createdAt', 'deliveredAt'] as const;
export const SENTIDO_DE_ORDEN = ['asc', 'desc'] as const;

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
    enum: PaymentStatus,
    description:
      'Filtra por estado del pago. `pending` + `status=delivered` lista el efectivo entregado sin confirmar; ' +
      '`unpaid` los impagos sin resolver; `written_off` las pérdidas. Siempre acotado a la distribuidora en contexto.',
  })
  @IsOptional()
  @IsEnum(PaymentStatus, {
    message: 'paymentStatus debe ser un estado de pago válido',
  })
  paymentStatus?: PaymentStatus;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-09-01',
    description: 'Fecha desde (inclusive), día en hora argentina, YYYY-MM-DD',
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
    description: 'Fecha hasta (inclusive), día en hora argentina, YYYY-MM-DD',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to debe tener formato YYYY-MM-DD',
  })
  @IsDateString({ strict: true }, { message: 'to no es una fecha válida' })
  to?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-09-01',
    description:
      'Entregados desde (inclusive), día en hora argentina, YYYY-MM-DD. Filtra por `deliveredAt`: deja afuera los pedidos sin entregar',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'deliveredFrom debe tener formato YYYY-MM-DD',
  })
  @IsDateString(
    { strict: true },
    { message: 'deliveredFrom no es una fecha válida' },
  )
  deliveredFrom?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-09-30',
    description:
      'Entregados hasta (inclusive), día en hora argentina, YYYY-MM-DD. Filtra por `deliveredAt`',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'deliveredTo debe tener formato YYYY-MM-DD',
  })
  @IsDateString(
    { strict: true },
    { message: 'deliveredTo no es una fecha válida' },
  )
  deliveredTo?: string;

  @ApiPropertyOptional({
    enum: ORDEN_DE_PEDIDOS,
    default: 'createdAt',
    description:
      'Campo por el que se ordena. Con `deliveredAt` los pedidos sin entregar quedan al final',
  })
  @IsOptional()
  @IsIn(ORDEN_DE_PEDIDOS, {
    message: 'sort debe ser createdAt o deliveredAt',
  })
  sort?: (typeof ORDEN_DE_PEDIDOS)[number];

  @ApiPropertyOptional({
    enum: SENTIDO_DE_ORDEN,
    default: 'desc',
    description: 'Sentido del orden: `desc` los más nuevos primero',
  })
  @IsOptional()
  @IsIn(SENTIDO_DE_ORDEN, { message: 'order debe ser asc o desc' })
  order?: (typeof SENTIDO_DE_ORDEN)[number];
}
