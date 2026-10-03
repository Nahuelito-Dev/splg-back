import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';

/** Estado de la cuenta del cliente, el mismo que usan las pestañas del panel. */
export enum CustomerStatusFilter {
  /** Cuenta habilitada (`user.blocked = false`). */
  ACTIVE = 'active',
  /** Cuenta bloqueada por un administrador (`user.blocked = true`). */
  BLOCKED = 'blocked',
}

/** `GET /customers`: pagina, busca por `term` y filtra por `status`. */
export class QueryCustomersDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: CustomerStatusFilter,
    description:
      'Filtra por estado de la cuenta. Sin este parámetro devuelve todos. ' +
      'Los clientes dados de baja nunca se listan. Combinado con `limit=1`, ' +
      'el total en `X-Total-Count` sirve para el contador de cada pestaña.',
  })
  @IsOptional()
  @IsEnum(CustomerStatusFilter, {
    message: 'status debe ser active o blocked',
  })
  status?: CustomerStatusFilter;
}
