import { ApiProperty } from '@nestjs/swagger';

export class ConsumptionResponseDto {
  @ApiProperty({
    format: 'uuid',
    type: String,
    nullable: true,
    description: 'Tipo de garrafa habitual; null si el cliente no declaró',
  })
  cylinderTypeId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '10kg' })
  cylinderType!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 20,
    description: 'Consumo declarado en kilos por mes; null si no declaró',
  })
  avgMonthlyConsumptionKg!: number | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Fecha estimada de la próxima recompra',
  })
  nextRepurchaseEstimateAt!: Date | null;
}
