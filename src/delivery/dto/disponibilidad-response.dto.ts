import { ApiProperty } from '@nestjs/swagger';

/** Resultado de ponerse en línea o desconectarse. */
export class DisponibilidadDelChoferDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ format: 'uuid' })
  deliveryId!: string;

  @ApiProperty()
  isAvailable!: boolean;

  @ApiProperty({ example: 'Estás en línea 🟢' })
  message!: string;
}
