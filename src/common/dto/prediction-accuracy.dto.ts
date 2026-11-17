import { ApiProperty } from '@nestjs/swagger';

/** Qué tan bien acertó una fecha proyectada contra lo que pasó (M3 y M2). */
export class PredictionAccuracyDto {
  @ApiProperty({ description: 'Predicciones que ya se pudieron comparar' })
  measured!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Error medio absoluto en días; `null` si no hay nada medido',
  })
  meanAbsoluteErrorDays!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Parte de las medidas dentro del margen, de 0 a 1; `null` si no hay nada medido',
  })
  withinMarginRate!: number | null;
  @ApiProperty({ description: 'Margen en días de `withinMarginRate`' })
  marginDays!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Error medio con signo en días: positivo = pasó después de lo proyectado, negativo = antes; `null` si no hay nada medido',
  })
  meanBiasDays!: number | null;
}
