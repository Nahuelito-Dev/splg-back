import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';

/** Los cuatro grupos administrativos en los que el panel puede filtrar el listado de choferes. */
export enum DeliveryStatusFilter {
  /** Habilitados por un admin (independientemente de si están validados o en línea). */
  ENABLED = 'enabled',
  /** Deshabilitados por un admin. */
  DISABLED = 'disabled',
  /** En línea ahora mismo (`isAvailable`), sin importar habilitación ni validación. */
  ONLINE = 'online',
  /** Todavía no aprobados por un admin (`validated = false`). */
  UNVALIDATED = 'unvalidated',
}

/** `GET /delivery`, para el panel: pagina, busca por `term` y filtra por `status`. */
export class QueryDeliveryDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: DeliveryStatusFilter,
    description:
      'Filtra por uno de los cuatro grupos administrativos. Sin este ' +
      'parámetro, devuelve todos. Combinado con `limit=1`, el total en ' +
      '`X-Total-Count` sirve para mostrar el contador de cada grupo.',
  })
  @IsOptional()
  @IsEnum(DeliveryStatusFilter, {
    message: 'status debe ser enabled, disabled, online o unvalidated',
  })
  status?: DeliveryStatusFilter;
}
