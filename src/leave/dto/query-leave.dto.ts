import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import { LeaveType } from '../entities/employee-leave.entity';
import { LeaveStatus } from '../domain/leave-state';

export class QueryLeaveDto extends PickType(PaginationDto, [
  'page',
  'limit',
] as const) {
  @ApiPropertyOptional({ enum: LeaveStatus })
  @IsOptional()
  @IsEnum(LeaveStatus)
  status?: LeaveStatus;

  @ApiPropertyOptional({ enum: LeaveType })
  @IsOptional()
  @IsEnum(LeaveType)
  type?: LeaveType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @FechaCalendarioOpcional('2026-12-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-12-31', undefined)
  to?: string;
}

export class QueryVacationBalanceDto {
  @ApiPropertyOptional({
    example: 2026,
    description: 'Por omisión, el año actual',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1990)
  @Max(2100)
  year?: number;
}
