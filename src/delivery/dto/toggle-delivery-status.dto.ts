import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Habilitación administrativa del chofer dentro de la distribuidora. */
export class ToggleDeliveryStatusDto {
  @ApiProperty({
    description:
      'true habilita al chofer; false lo deshabilita y, si estaba en línea, ' +
      'también lo desconecta y lo saca del radar de despacho',
    example: true,
  })
  @IsBoolean({ message: 'isEnabled tiene que ser true o false' })
  isEnabled!: boolean;
}
