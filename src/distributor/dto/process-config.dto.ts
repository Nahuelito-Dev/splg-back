import { ApiProperty } from '@nestjs/swagger';
import { ConfigurableProcess } from '../entities/module-config.entity';
import { PROCESOS_AUTOMATICOS } from '../process-config';

/** Un parámetro del proceso: su tipo, rango y valor por omisión. */
export class ProcessConfigFieldDto {
  @ApiProperty({ example: 'anticipationDays' })
  key!: string;

  @ApiProperty({ enum: ['integer', 'number'] })
  type!: 'integer' | 'number';

  @ApiProperty({ example: 1 })
  min!: number;

  @ApiProperty({ example: 30 })
  max!: number;

  @ApiProperty({ example: 3 })
  default!: number;

  @ApiProperty({ type: String, nullable: true, example: 'días' })
  unit!: string | null;

  @ApiProperty({
    example: 'Anticipación con que se envía la invitación a reponer',
  })
  description!: string;
}

/** Respuesta de `GET`/`PUT /module-config/{proceso}` y elementos de `GET /module-config/processes`. */
export class ProcessConfigResponseDto {
  @ApiProperty({
    enum: PROCESOS_AUTOMATICOS,
    example: ConfigurableProcess.REPURCHASE,
  })
  process!: string;

  @ApiProperty({ example: 'Anticipación de recompra' })
  title!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: [ProcessConfigFieldDto] })
  fields!: ProcessConfigFieldDto[];

  @ApiProperty({
    description:
      'Valor efectivo de cada parámetro (el de la distribuidora o, si no lo configuró, el de omisión)',
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { minOrders: 3, anticipationDays: 3 },
  })
  params!: Record<string, number>;

  @ApiProperty({
    description:
      'true si rigen los valores por omisión (nada configurado o todo coincide con ellos)',
  })
  isDefault!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo se modificó por última vez (null si nunca)',
  })
  updatedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Usuario que la modificó por última vez (null si nunca)',
  })
  updatedByUserId!: string | null;
}
