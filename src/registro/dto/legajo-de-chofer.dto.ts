import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  EmployeeDocumentType,
  EmploymentType,
} from '../../employee/entities/employee.entity';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import { Cuil } from '../../employee/dto/is-cuil.decorator';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';

/**
 * Datos del legajo que se crea junto con un chofer (`POST /users`, rol
 * `delivery`). Todo es opcional: lo que falta lo completa el administrador
 * después en la ficha del empleado.
 */
export class LegajoDeChoferDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Puesto de categoría chofer. Por defecto, el primero activo',
  })
  @IsOptional()
  @IsUUID()
  positionId?: string;

  @ApiPropertyOptional({ enum: EmployeeDocumentType, default: 'dni' })
  @IsOptional()
  @IsEnum(EmployeeDocumentType)
  documentType?: EmployeeDocumentType;

  @ApiPropertyOptional({
    example: '30123456',
    description: 'Si falta, queda "PENDIENTE-<legajo>" para completar después',
  })
  @IsOptional()
  @VacioANulo(undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  documentNumber?: string;

  @Cuil(undefined)
  cuil?: string;

  @FechaCalendarioOpcional('2026-10-05', undefined)
  hireDate?: string;

  @ApiPropertyOptional({ enum: EmploymentType, default: 'permanent' })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;
}
