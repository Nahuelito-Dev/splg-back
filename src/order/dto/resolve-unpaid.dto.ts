import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import type { ResolucionDeImpago } from '../application/cash-collection.use-case';

export const RESOLUCIONES_DE_IMPAGO: ResolucionDeImpago[] = [
  'paid',
  'written_off',
];

/** Body de `PATCH /orders/:id/payment/resolve-unpaid`. */
export class ResolveUnpaidDto {
  @ApiProperty({
    enum: RESOLUCIONES_DE_IMPAGO,
    example: 'paid',
    description:
      '`paid`: el cliente terminó pagando (el pedido queda `paid`). `written_off`: se da por perdido (queda `written_off`).',
  })
  @IsIn(RESOLUCIONES_DE_IMPAGO)
  resolution!: ResolucionDeImpago;

  @ApiProperty({
    example: 'El cliente transfirió el lunes',
    description: 'Motivo de la resolución (queda en el pedido y en auditoría)',
  })
  @TextoNoVacio()
  note!: string;
}
