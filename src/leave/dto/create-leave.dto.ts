import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { LeaveType } from '../entities/employee-leave.entity';
import { FechaCalendario } from '../../employee/dto/fecha-calendario.decorator';

export class CreateLeaveDto {
  @ApiProperty({ enum: LeaveType, example: LeaveType.VACATION })
  @IsEnum(LeaveType)
  type!: LeaveType;

  @FechaCalendario('2026-12-01')
  startDate!: string;

  @FechaCalendario('2026-12-14')
  endDate!: string;

  @ApiPropertyOptional({ example: 'Vacaciones de verano', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Modifica una licencia solicitada: tipo, período o motivo. */
export class UpdateLeaveDto extends PartialType(CreateLeaveDto) {}
