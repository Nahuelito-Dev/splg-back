import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { JobPositionCategory } from '../entities/job-position.entity';

const sinEspacios = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateJobPositionDto {
  @ApiProperty({ example: 'Chofer de reparto', maxLength: 80 })
  @Transform(sinEspacios)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    enum: JobPositionCategory,
    description:
      'La categoría manda las reglas (rol de acceso, documentación); el nombre es libre',
  })
  @IsEnum(JobPositionCategory)
  category!: JobPositionCategory;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateJobPositionDto extends PartialType(CreateJobPositionDto) {}
