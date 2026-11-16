import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  LARGO_MINIMO_NOTA_DE_IMPAGO,
  LARGO_NOTA,
} from '../../common/constants/largos-de-texto';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { OrderResponseDto } from './order-response.dto';
import { CASH_BOX_ID_DESCRIPCION } from './payment-admin.dto';
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
    minLength: LARGO_MINIMO_NOTA_DE_IMPAGO,
    maxLength: LARGO_NOTA,
  })
  @TextoNoVacio()
  @MinLength(LARGO_MINIMO_NOTA_DE_IMPAGO)
  @MaxLength(LARGO_NOTA)
  note!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: `${CASH_BOX_ID_DESCRIPCION} Sólo aplica con \`resolution: paid\`; con \`written_off\` no se usa.`,
  })
  @IsOptional()
  @IsUUID()
  cashBoxId?: string;
}

/** Respuesta de `PATCH /orders/:id/payment/resolve-unpaid`: el pedido y si ya estaba resuelto. */
export class ResolveUnpaidResponseDto extends OrderResponseDto {
  @ApiProperty({
    example: false,
    description:
      '`true` si el pedido ya estaba en el destino pedido (reintento o segundo admin): no se tocó nada, ni la nota del pedido ni la incidencia.',
  })
  alreadyResolved!: boolean;
}
