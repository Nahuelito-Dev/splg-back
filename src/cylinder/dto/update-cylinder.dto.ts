import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDate,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Datos maestros del envase. El estado NO se edita acá: cambia sólo por la
 * máquina de estados (`/transition`, `/retire`). La última revisión y el
 * vencimiento tampoco: se asientan sólo con `POST /cylinders/:id/inspections`.
 */
export class UpdateCylinderDto {
  @ApiPropertyOptional({ example: 'SN-000123' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  serial?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Producto del catálogo' })
  @IsOptional()
  @IsUUID()
  gasCylinderId?: string;

  @ApiPropertyOptional({ example: 5000, description: 'Depósito del envase' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  deposit?: number;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Fecha de fabricación',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  manufacturedAt?: Date;
}
