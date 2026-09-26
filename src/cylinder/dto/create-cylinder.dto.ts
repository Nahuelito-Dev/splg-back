import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateCylinderDto {
  /** Número de serie físico grabado en el envase. */
  @ApiProperty({ example: 'SN-000123' })
  @IsString()
  serial!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Producto del catálogo' })
  @IsOptional()
  @IsUUID()
  gasCylinderId?: string;

  @ApiPropertyOptional({ example: 5000, description: 'Depósito del envase' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  deposit?: number;
}
