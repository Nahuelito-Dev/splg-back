import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsUUID, Min } from 'class-validator';
import { SerialDeEnvase } from './serial-de-envase';

export class CreateCylinderDto {
  /** Número de serie físico grabado en el envase. */
  @ApiProperty({
    example: 'SN-000123',
    description:
      'Hasta 100 caracteres. Se guarda sin espacios en los bordes y en mayúsculas',
    maxLength: 100,
  })
  @SerialDeEnvase()
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
