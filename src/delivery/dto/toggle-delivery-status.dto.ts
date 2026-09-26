import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Alta o baja operativa del chofer dentro de la distribuidora. */
export class ToggleDeliveryStatusDto {
  @ApiProperty({
    description: 'true deja al chofer activo, false lo da de baja operativa',
    example: true,
  })
  @IsBoolean({ message: 'isActive tiene que ser true o false' })
  isActive!: boolean;
}
