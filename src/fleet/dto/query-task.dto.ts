import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { MaintenanceTaskStatus } from '../entities/maintenance-task.entity';

export class QueryFleetTaskDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  deliveryId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sólo las tareas de este plan',
  })
  @IsOptional()
  @IsUUID()
  planId?: string;

  @ApiPropertyOptional({ enum: MaintenanceTaskStatus })
  @IsOptional()
  @IsEnum(MaintenanceTaskStatus)
  status?: MaintenanceTaskStatus;
}
