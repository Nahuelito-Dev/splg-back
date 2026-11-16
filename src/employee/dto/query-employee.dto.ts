import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { EmployeeDocumentStatus } from '../domain/document-status';
import { EmployeeStatus } from '../entities/employee.entity';
import { JobPositionCategory } from '../entities/job-position.entity';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class QueryEmployeeDto extends PickType(PaginationDto, [
  'page',
  'limit',
] as const) {
  @ApiPropertyOptional({ description: 'Nombre, apellido o número de legajo' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  positionId?: string;

  @ApiPropertyOptional({ enum: JobPositionCategory })
  @IsOptional()
  @IsEnum(JobPositionCategory)
  category?: JobPositionCategory;

  @ApiPropertyOptional({ enum: EmployeeStatus })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiPropertyOptional({
    description: 'true: con cuenta de acceso; false: sin ella',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  hasAccount?: boolean;

  @ApiPropertyOptional({
    enum: EmployeeDocumentStatus,
    description:
      'Estado de la documentación (CU-180). Sólo alcanza a los legajos activos: ' +
      'los egresados no tienen estado y no aparecen con este filtro',
  })
  @IsOptional()
  @IsEnum(EmployeeDocumentStatus)
  documentStatus?: EmployeeDocumentStatus;
}
