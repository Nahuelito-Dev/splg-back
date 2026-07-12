import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DistributorStatus } from '../entities/distributor.entity';

export class CreateDistributorDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  /** slug URL-safe: minúsculas, números y guiones. */
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug debe ser minúsculas, números y guiones (ej: jeny-gas)',
  })
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  legal_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  tax_id?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  logo_url?: string;

  @IsOptional()
  @IsEnum(DistributorStatus, {
    message: 'status debe ser active o suspended',
  })
  status?: DistributorStatus;

  @IsOptional()
  @IsString()
  plan?: string;
}
