import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DistributorStatus } from '../entities/distributor.entity';

export class CreateDistributorDto {
  @ApiProperty({ example: 'Distribuidora Demo', minLength: 2, maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** slug URL-safe: minúsculas, números y guiones. */
  @ApiProperty({ example: 'demo', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug debe ser minúsculas, números y guiones (ej: demo)',
  })
  slug!: string;

  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  legal_name?: string;

  @ApiPropertyOptional({ example: '30-12345678-9', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tax_id?: string;

  @ApiPropertyOptional({ example: 'contacto@demo.splg.app' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ enum: DistributorStatus })
  @IsOptional()
  @IsEnum(DistributorStatus, {
    message: 'status debe ser active o suspended',
  })
  status?: DistributorStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  plan?: string;
}
