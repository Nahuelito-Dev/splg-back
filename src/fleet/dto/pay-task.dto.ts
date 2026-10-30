import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsUUID,
} from 'class-validator';
import { PayFromCashBoxDto } from '../../cash/dto/pay-expense.dto';

/** Pago de una tarea de mantenimiento hecha, desde una caja (API v2). */
export class PayFleetTaskDto extends PayFromCashBoxDto {
  @ApiPropertyOptional({
    example: 45000.5,
    description:
      'Lo pagado; por omisión el costo de la tarea, y no puede superarlo',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;
}

/** «Lo pagué ahora»: la caja del pago que se registra junto con el cierre. */
export class PagoAlCerrar {
  @ApiProperty({
    format: 'uuid',
    description:
      'Caja de la que sale el pago: efectivo, banco o billetera de la distribuidora',
  })
  @IsUUID()
  cashBoxId!: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-10-28T14:30:00-03:00',
    description: 'Cuándo se pagó; por omisión, ahora. No puede ser futura',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  paidAt?: string;
}
