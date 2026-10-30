import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsUUID } from 'class-validator';

/**
 * El pago de un gasto de la flota o de una compra (API v2): de qué caja sale y
 * cuándo se pagó.
 */
export class PayFromCashBoxDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Caja de la que sale el pago: efectivo, banco o billetera de la distribuidora',
  })
  @IsUUID()
  cashBoxId!: string;

  @ApiProperty({
    type: String,
    example: '2026-10-28T14:30:00-03:00',
    description:
      'Cuándo se pagó (fecha o fecha y hora ISO 8601); no puede ser futura',
  })
  @IsISO8601({ strict: true })
  paidAt!: string;
}
