import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { CylinderInspectionResult } from '../entities/cylinder-inspection.entity';

/** `POST /cylinders/:id/inspections`: la revisión periódica (prueba hidráulica) de un envase. */
export class RegisterInspectionDto {
  @ApiProperty({
    type: String,
    format: 'date',
    example: '2026-10-15',
    description:
      'Día de la revisión (`YYYY-MM-DD`, día calendario de Buenos Aires; si ' +
      'llega un ISO completo se toma su parte de fecha). No puede ser futuro.',
  })
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}/)
  inspectedAt!: string;

  @ApiProperty({ enum: CylinderInspectionResult })
  @IsEnum(CylinderInspectionResult)
  result!: CylinderInspectionResult;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2031-10-15',
    description:
      'Último día en que puede circular (`YYYY-MM-DD`, día de Buenos Aires: ' +
      'vale hasta las 23:59 de ese día). Obligatorio salvo que el resultado ' +
      'sea `rejected`; tiene que ser posterior a `inspectedAt`. En un rechazo ' +
      'se ignora: el vencimiento queda en la fecha de la revisión.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}/)
  nextDueAt?: string;

  @ApiPropertyOptional({ example: 'Válvula reemplazada' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
