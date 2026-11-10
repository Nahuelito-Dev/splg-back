import { ApiProperty } from '@nestjs/swagger';

export class CustomerContainerResponseDto {
  @ApiProperty({ format: 'uuid' })
  gasCylinderId!: string;

  @ApiProperty({ example: 'Garrafa 10 kg' })
  type!: string;

  @ApiProperty({ minimum: 0 })
  owned!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Envases con serie de este tipo que el recupero (M5) le puede reclamar al cliente. Con «Cobrar envases» encendido, sólo los que exceden a los propios: max(0, envases en su poder − owned); apagado, todos los que tiene en su poder.',
  })
  loanedByM5!: number;

  @ApiProperty()
  isActive!: boolean;
}

export class CustomerContainersResponseDto {
  @ApiProperty({ type: CustomerContainerResponseDto, isArray: true })
  items!: CustomerContainerResponseDto[];
}
