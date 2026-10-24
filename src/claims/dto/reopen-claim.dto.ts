import { ApiProperty } from '@nestjs/swagger';
import { MaxLength } from 'class-validator';
import { LARGO_DESCRIPCION } from '../../common/constants/largos-de-texto';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

/**
 * Body de `PATCH /claims/:id/reopen`. Sólo aplica sobre un reclamo RESOLVED o
 * REJECTED (la máquina de estados lo valida) y exige el motivo de la
 * reapertura, igual que `resolve` exige la nota de resolución.
 */
export class ReopenClaimDto {
  @ApiProperty({
    description: 'Motivo por el que se reabre el reclamo',
    maxLength: LARGO_DESCRIPCION,
  })
  @TextoNoVacio()
  @MaxLength(LARGO_DESCRIPCION)
  reason!: string;
}
