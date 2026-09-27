import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Crea una tarea (un vencimiento/servicio concreto) contra un plan. La tarea
 * apunta a UN vehículo (`carId`) o a UN chofer (`deliveryId`), según
 * `plan.subject`: el servicio valida que venga el correcto y que pertenezca a
 * la misma distribuidora.
 */
export class CreateFleetTaskDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  planId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Obligatorio si el plan es de vehículo (subject: vehicle)',
  })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Obligatorio si el plan es de chofer (subject: driver)',
  })
  @IsOptional()
  @IsUUID()
  deliveryId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2026-12-31T00:00:00.000Z',
    description: 'Fecha límite (vencimiento de la póliza, la VTV, la licencia)',
  })
  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @ApiPropertyOptional({
    description: 'Km al que corresponde el próximo service',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  dueKm?: number;

  @ApiPropertyOptional({
    example: 'La Segunda Seguros',
    description: 'Aseguradora, taller o gestoría',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  provider?: string;

  @ApiPropertyOptional({
    example: '123456789',
    description:
      'Número de póliza, de licencia, u otra referencia del proveedor',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  referenceNumber?: string;

  @ApiPropertyOptional({
    example: 'B1',
    description: 'Categoría de la licencia de conducir, si aplica',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Cuándo está agendado el turno/trámite, si ya se sabe',
  })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
