import { IsIn } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { ApiProperty } from '@nestjs/swagger';
import { ClaimStatus } from '../entities/claim.entity';

/** Destinos de `resolve`: sólo cierres. Tomar el reclamo es `take`. */
const ESTADOS_FINALES = [ClaimStatus.RESOLVED, ClaimStatus.REJECTED];

/**
 * Body de `PATCH /claims/:id/resolve`. Valida que `status` sea un estado real de
 * reclamo (rechaza con 400 claro antes de tocar la DB) y que `resolution` no sea
 * vacío. Reemplaza el tipo inline sin validación.
 */
export class ResolveClaimDto {
  @ApiProperty({ description: 'Texto de resolución del reclamo' })
  @TextoNoVacio()
  resolution!: string;

  @ApiProperty({
    description:
      'Estado final del reclamo. Pasarlo a "en proceso" es `PATCH /claims/:id/take`.',
    enum: ESTADOS_FINALES,
    example: ClaimStatus.RESOLVED,
  })
  @IsIn(ESTADOS_FINALES, {
    message: `status debe ser uno de: ${ESTADOS_FINALES.join(', ')}`,
  })
  status!: ClaimStatus.RESOLVED | ClaimStatus.REJECTED;
}
