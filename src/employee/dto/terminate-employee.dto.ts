import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { EmployeeTerminationReason } from '../entities/employee.entity';
import {
  FechaCalendario,
  FechaCalendarioOpcional,
} from './fecha-calendario.decorator';

export class TerminateEmployeeDto {
  @FechaCalendario('2026-10-04')
  terminationDate!: string;

  @ApiProperty({ enum: EmployeeTerminationReason, example: 'resignation' })
  @IsEnum(EmployeeTerminationReason)
  reason!: EmployeeTerminationReason;
}

export class ReinstateEmployeeDto {
  /** Fecha de ingreso nueva. Si falta, hoy (día argentino). */
  @FechaCalendarioOpcional('2026-10-05', undefined)
  hireDate?: string;
}
