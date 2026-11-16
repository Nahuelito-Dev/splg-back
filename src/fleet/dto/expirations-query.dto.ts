import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { JobPositionCategory } from '../../employee/entities/job-position.entity';

/** Qué parte de la flota y del personal trae el tablero de vencimientos. */
export enum FleetExpirationsSubject {
  VEHICLE = 'vehicle',
  EMPLOYEE = 'employee',
}

export class FleetExpirationsQueryDto {
  @ApiPropertyOptional({
    default: 30,
    minimum: 0,
    maximum: 365,
    description:
      'Ventana en días: trae lo vencido y lo que vence dentro de esta cantidad de días',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  withinDays: number = 30;

  @ApiPropertyOptional({
    enum: FleetExpirationsSubject,
    description:
      '`vehicle`: sólo vehículos y choferes (CU-139); `employee`: sólo personal (CU-187). Sin indicar, todo.',
  })
  @IsOptional()
  @IsEnum(FleetExpirationsSubject)
  subject?: FleetExpirationsSubject;

  @ApiPropertyOptional({
    enum: JobPositionCategory,
    description: 'Filtra el personal por la categoría de su puesto (CU-187)',
  })
  @IsOptional()
  @IsEnum(JobPositionCategory)
  category?: JobPositionCategory;
}
