import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Cuerpo de `PUT /v2/container-charge`. */
export class ContainerChargeConfigDto {
  @ApiProperty({
    description: 'Activa el cobro de los envases que le faltan al cliente.',
    example: true,
  })
  @IsBoolean()
  enabled!: boolean;
}

/** Respuesta de `GET`/`PUT /v2/container-charge`. */
export class ContainerChargeConfigResponseDto {
  @ApiProperty({
    description:
      'Si se cobran los envases faltantes al crear o cotizar pedidos.',
    example: false,
  })
  enabled!: boolean;
}
