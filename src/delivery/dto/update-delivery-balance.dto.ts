import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';

/**
 * Ajuste del saldo del chofer.
 *
 * Mueve dinero, así que el monto se valida en el borde: antes el endpoint
 * recibía el cuerpo con un tipo literal y `{"amount": "mil"}` llegaba hasta la
 * base.
 */
export class UpdateDeliveryBalanceDto {
  @ApiProperty({
    description: 'Monto a acreditar (positivo) o debitar (negativo)',
    example: 1500,
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'amount debe ser un número con hasta dos decimales' },
  )
  @Min(-1_000_000, { message: 'amount fuera de rango' })
  @Max(1_000_000, { message: 'amount fuera de rango' })
  amount!: number;
}
