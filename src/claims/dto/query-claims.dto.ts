import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/** Filtros de `GET /claims` (panel). */
export class QueryClaimsDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sólo los reclamos de ese pedido (de la distribuidora del que pregunta: un pedido ajeno da la lista vacía)',
  })
  @IsOptional()
  @IsUUID()
  orderId?: string;
}
