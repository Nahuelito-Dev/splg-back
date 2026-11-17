import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../../common/dtos/pagination.dto';
import { PlanningCaseStatus } from '../../entities/maintenance-planning-case.entity';

/** Una ventana de taller: inicio y fin con zona horaria. */
export class WindowDto {
  @ApiProperty({ type: String, example: '2026-11-03T08:00:00-03:00' })
  @IsISO8601({ strict: true })
  start!: string;

  @ApiProperty({ type: String, example: '2026-11-03T13:00:00-03:00' })
  @IsISO8601({ strict: true })
  end!: string;
}

/** El chofer rechaza una ventana. El motivo es obligatorio; puede proponer otra. */
export class RejectProposalDto {
  @ApiProperty({
    example: 'Ese día tengo el turno médico',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    type: WindowDto,
    description:
      'Otra ventana que le sirve. Tiene que caber en un día dentro del horario de taller, respetar el aviso mínimo, caer antes del vencimiento proyectado y no dejar la zona bajo el mínimo de unidades. Si es viable, queda acordada a la espera del administrador; si no, 400.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WindowDto)
  alternative?: WindowDto;
}

class DatosDelTaller {
  @ApiPropertyOptional({
    description:
      'Confirma aunque la ventana deje la zona de cobertura por debajo del mínimo de unidades (decide el administrador). Sin esto, esa ventana responde 409.',
  })
  @IsOptional()
  @IsBoolean()
  ignoreCoverage?: boolean;

  @ApiPropertyOptional({ example: 'Taller Los Pinos', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  provider?: string;

  @ApiPropertyOptional({
    example: 85000,
    description: 'Gasto previsto del taller; queda como costo de la tarea',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000_000)
  cost?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * El administrador confirma el taller. Sin ventana confirma la que acordó el
 * chofer; con ventana (los dos extremos) elige otra, que es la única forma de
 * resolver un caso escalado.
 */
export class ConfirmPlanningCaseDto extends DatosDelTaller {
  @ApiPropertyOptional({ type: String, example: '2026-11-04T08:00:00-03:00' })
  @IsOptional()
  @IsISO8601({ strict: true })
  windowStart?: string;

  @ApiPropertyOptional({ type: String, example: '2026-11-04T13:00:00-03:00' })
  @IsOptional()
  @IsISO8601({ strict: true })
  windowEnd?: string;
}

/** El administrador fija la ventana de una tarea sin esperar al planificador. */
export class ForceWindowDto extends DatosDelTaller {
  @ApiProperty({ type: String, example: '2026-11-04T08:00:00-03:00' })
  @IsISO8601({ strict: true })
  windowStart!: string;

  @ApiProperty({ type: String, example: '2026-11-04T13:00:00-03:00' })
  @IsISO8601({ strict: true })
  windowEnd!: string;
}

export class QueryPlanningCasesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: PlanningCaseStatus })
  @IsOptional()
  @IsEnum(PlanningCaseStatus)
  status?: PlanningCaseStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({
    description:
      'Sólo los casos que esperan al administrador (escalados o a confirmar)',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  pending?: boolean;
}

export class QueryPlannerAccuracyDto {
  @ApiPropertyOptional({
    example: '2026-06-01',
    description: 'Desde este día (por omisión, 180 días atrás)',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-17',
    description: 'Hasta este día inclusive (por omisión, hoy)',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class QueryPlannerForecastDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;
}

/** Parámetros del planificador a cambiar; lo que no viene queda como estaba. */
export class PatchPlannerSettingsDto {
  @ApiPropertyOptional({
    description: 'Hora de ejecución diaria (0 a 23, hora de Argentina)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  cronHour?: number;

  @ApiPropertyOptional({
    description: 'Vigencia de la propuesta al chofer, en horas (1 a 168)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  proposalTtlHours?: number;

  @ApiPropertyOptional({
    description: 'Ventanas que se ofrecen antes de escalar (1 a 10)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  topNWindows?: number;

  @ApiPropertyOptional({
    description: 'Mínimo de vehículos por zona (0 a 100)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  minVehiclesPerZone?: number;

  @ApiPropertyOptional({
    description:
      'Días de historial para confiar en la predicción propia (1 a 365)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  minSampleDays?: number;

  @ApiPropertyOptional({
    description: 'Peso de las semanas recientes en la media móvil (0 a 1)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  decay?: number;

  @ApiPropertyOptional({
    description: 'Días hacia adelante en que se buscan ventanas (1 a 180)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  horizonDays?: number;

  @ApiPropertyOptional({
    description: 'Días de aviso mínimos hasta la ventana (0 a 30)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  minLeadDays?: number;

  @ApiPropertyOptional({
    description: 'Días hacia atrás para derivar la zona del vehículo (1 a 90)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  zoneLookbackDays?: number;

  @ApiPropertyOptional({
    description: 'Semanas de pedidos para estimar la demanda (1 a 26)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(26)
  demandWeeks?: number;

  @ApiPropertyOptional({
    description: 'Hora en que empieza el taller (0 a 23)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  workshopStartHour?: number;

  @ApiPropertyOptional({
    description: 'Hora en que termina el taller (1 a 24); posterior al inicio',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  workshopEndHour?: number;

  @ApiPropertyOptional({
    description:
      'Días en que atiende el taller: suma de 1 domingo, 2 lunes, 4 martes, 8 miércoles, 16 jueves, 32 viernes y 64 sábado',
    minimum: 1,
    maximum: 127,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(127)
  workshopDays?: number;

  @ApiPropertyOptional({
    description:
      'Días sin registros de uso a partir de los cuales los datos se consideran desactualizados',
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  usageStaleDays?: number;

  @ApiPropertyOptional({
    description:
      'Planificar también cuando faltan estos kilómetros (0 la desactiva)',
    minimum: 0,
    maximum: 1_000_000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  anticipationKm?: number;

  @ApiPropertyOptional({
    description:
      'Mandar también un correo al chofer con cada propuesta (0 no, 1 sí)',
    minimum: 0,
    maximum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1)
  driverEmail?: number;
}

export class CancelPlanningCaseDto {
  @ApiPropertyOptional({
    maxLength: 500,
    example: 'El vehículo sale de la flota',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
