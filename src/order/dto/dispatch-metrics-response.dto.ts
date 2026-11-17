import { ApiProperty } from '@nestjs/swagger';

export class TiempoEnSegundosDto {
  @ApiProperty({ type: Number, nullable: true, example: 14.5 })
  mediana!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 28 })
  p90!: number | null;
}

export class ChoferEnElTopDto {
  @ApiProperty({ format: 'uuid' })
  driverId!: string;

  @ApiProperty({ example: 'Ana Pérez' })
  nombre!: string;

  @ApiProperty({ description: 'Ofertas ya resueltas del período' })
  ofertas!: number;

  @ApiProperty()
  aceptadas!: number;

  @ApiProperty({ description: '0 a 100', example: 80 })
  tasaAceptacion!: number;

  @ApiProperty({ type: Number, nullable: true })
  medianaRespuestaSegundos!: number | null;
}

export class DispatchMetricsResponseDto {
  @ApiProperty({ format: 'date-time' })
  from!: string;

  @ApiProperty({ format: 'date-time' })
  to!: string;

  @ApiProperty({ description: 'Pedidos con al menos una oferta en el período' })
  pedidosDespachados!: number;

  @ApiProperty({ type: Number, nullable: true })
  ofertasPorPedido!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Sobre las ofertas resueltas, 0 a 100',
  })
  porcentajeAceptadas!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  porcentajeRechazadas!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  porcentajeVencidas!: number | null;

  @ApiProperty({
    type: TiempoEnSegundosDto,
    description: 'Sólo ofertas con respuesta registrada',
  })
  respuestaDelChofer!: TiempoEnSegundosDto;

  @ApiProperty({
    type: TiempoEnSegundosDto,
    description:
      'Desde que el pedido quedó pendiente hasta que un chofer lo aceptó',
  })
  hastaAsignar!: TiempoEnSegundosDto;

  @ApiProperty({
    description: 'Pedidos que el sistema canceló porque ningún chofer los tomó',
  })
  pedidosSinChofer!: number;

  @ApiProperty({ type: ChoferEnElTopDto, isArray: true })
  topChoferes!: ChoferEnElTopDto[];
}
