import { ApiProperty } from '@nestjs/swagger';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

/**
 * Body de `PATCH /claims/:id/reopen`. Sólo aplica sobre un reclamo RESOLVED o
 * REJECTED (la máquina de estados lo valida) y exige el motivo de la
 * reapertura, igual que `resolve` exige la nota de resolución.
 */
export class ReopenClaimDto {
  @ApiProperty({ description: 'Motivo por el que se reabre el reclamo' })
  @TextoNoVacio()
  reason!: string;
}
