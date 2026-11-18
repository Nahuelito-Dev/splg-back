import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Allow } from 'class-validator';

/**
 * Crea una tarea (un vencimiento/servicio concreto) contra un plan. La tarea
 * apunta a UN vehículo (`carId`), a UN chofer (`deliveryId`) o a UN empleado
 * (`employeeId`), según `plan.subject`: el servicio valida que venga el
 * correcto y que pertenezca a la misma distribuidora.
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
    format: 'uuid',
    description:
      'Obligatorio si el plan es de personal (subject: employee): curso de mercancías peligrosas, psicofísico, ART (CU-183 a CU-185)',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

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
    type: String,
    format: 'date-time',
    example: '2026-01-01T00:00:00.000Z',
    description:
      'Inicio de la vigencia (póliza, habilitación). No puede ser posterior al vencimiento',
  })
  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @ApiPropertyOptional({
    example: 185000,
    description:
      'Importe de la tarea (la prima de la póliza, el costo del service). Entra en el costo del vehículo',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cost?: number;

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
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { certificateNumber: '123/26', issuer: 'CNRT' },
    description:
      'Datos propios del tipo de documento (`plan.documentKind`): curso de mercancías peligrosas {certificateNumber, issuer}, psicofísico {examDate}, ART {insurer, policyNumber}. Los demás tipos no llevan detalle.',
  })
  @IsOptional()
  @Allow()
  details?: Record<string, string>;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Cuándo está agendado el turno/trámite, si ya se sabe. Un `YYYY-MM-DD` (o medianoche argentina) es ese día ' +
      'argentino y se guarda a las 00:00 de Argentina; un instante con hora se guarda tal cual. Inválido: 400.',
  })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

/** Alta desde el tablero (API v2): lo de la v1 más el responsable. */
export class CreateFleetTaskV2Dto extends CreateFleetTaskDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Responsable de la tarea: un empleado activo de la distribuidora (404 si no es de ella, 409 si está egresado)',
  })
  @IsOptional()
  @IsUUID()
  assigneeEmployeeId?: string;
}
