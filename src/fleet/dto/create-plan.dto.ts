import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MaintenanceCriticality,
  MaintenanceSubject,
  MaintenanceTrigger,
} from '../entities/maintenance-plan.entity';

export class CreateFleetPlanDto {
  @ApiProperty({ example: 'Seguro del vehículo', minLength: 3, maxLength: 120 })
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    enum: MaintenanceSubject,
    description: 'A qué aplica: al vehículo o al chofer',
  })
  @IsEnum(MaintenanceSubject)
  subject!: MaintenanceSubject;

  @ApiProperty({
    enum: MaintenanceTrigger,
    description:
      'Qué dispara el vencimiento: una fecha fija, un intervalo de km o de tiempo',
  })
  @IsEnum(MaintenanceTrigger)
  trigger!: MaintenanceTrigger;

  @ApiPropertyOptional({
    description: 'Obligatorio si trigger=by_km (p. ej. cada 10000 km)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  intervalKm?: number;

  @ApiPropertyOptional({
    description: 'Obligatorio si trigger=by_time (p. ej. cada 6 meses)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  intervalMonths?: number;

  @ApiProperty({
    example: 30,
    description: 'Con cuántos días de anticipación avisa antes del vencimiento',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  leadTimeDays!: number;

  @ApiProperty({
    enum: MaintenanceCriticality,
    description:
      'blocking: sin esto vigente, el vehículo/chofer no puede salir (CU-136/137/138)',
  })
  @IsEnum(MaintenanceCriticality)
  criticality!: MaintenanceCriticality;

  @ApiPropertyOptional({
    description: 'Tipo de vehículo al que aplica (null = todos)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  carType?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
