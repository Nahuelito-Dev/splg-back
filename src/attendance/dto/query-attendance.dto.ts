import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class QueryAttendanceDto extends PickType(PaginationDto, [
  'page',
  'limit',
] as const) {
  @FechaCalendarioOpcional('2026-03-02', undefined)
  date?: string;

  @FechaCalendarioOpcional('2026-03-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-03-31', undefined)
  to?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({
    description: 'true: sólo las jornadas sin cerrar; false: sólo las cerradas',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  open?: boolean;
}
