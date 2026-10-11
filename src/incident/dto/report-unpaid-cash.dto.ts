import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body de `PATCH /orders/:id/payment/unpaid`. */
export class ReportUnpaidCashDto {
  @ApiPropertyOptional({
    example: 'El cliente dice que paga mañana',
    maxLength: 500,
    description:
      'Nota del chofer; queda como descripción de la incidencia. La foto se sube después con `PUT /incidents/:incidentId/photo`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
