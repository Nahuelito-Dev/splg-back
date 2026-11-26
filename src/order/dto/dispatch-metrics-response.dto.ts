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

export class AsignacionPorMetodoDto {
  @ApiProperty({
    enum: ['automatic', 'manual_override', 'route_sheet', 'batch'],
    description:
      '`automatic` (despacho automático), `manual_override` (asignación manual), `route_sheet` (hoja de ruta), `batch` (lote de recorrido)',
  })
  method!: 'automatic' | 'manual_override' | 'route_sheet' | 'batch';

  @ApiProperty({ example: 12 })
  cantidad!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Sobre los pedidos asignados que tienen método, 0 a 100; null si ninguno lo tiene',
  })
  porcentaje!: number | null;
}

export class DispatchMetricsResponseDto {
  @ApiProperty({ format: 'date-time' })
  from!: string;

  @ApiProperty({ format: 'date-time' })
  to!: string;

  @ApiProperty({
    description:
      'Pedidos del período que hoy tienen chofer, por cualquier camino. Cuenta la asignación vigente: un pedido liberado no entra y uno reasignado cuenta con su último método (no es un historial)',
  })
  pedidosAsignados!: number;

  @ApiProperty({
    description:
      'De los asignados, los anteriores al registro del método (no se les inventa uno)',
  })
  asignadosSinMetodo!: number;

  @ApiProperty({
    type: AsignacionPorMetodoDto,
    isArray: true,
    description: 'Siempre los cuatro métodos, aunque tengan 0',
  })
  asignacionPorMetodo!: AsignacionPorMetodoDto[];

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

  @ApiProperty({
    description:
      'Ofertas del período que guardaron el tiempo estimado al cliente (base de las dos cifras siguientes)',
  })
  ofertasConEstimacion!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'De las ofertas con estimación, el porcentaje (0 a 100) que se ordenó por calle con OSRM y no con la línea recta; null si no hay ninguna',
  })
  porcentajeOrdenadasPorOsrm!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Promedio de minutos que se estimó que el chofer tardaba en llegar al cliente al ofrecerle el pedido; null si no hay datos',
  })
  minutosEstimadosPromedio!: number | null;

  @ApiProperty({ type: ChoferEnElTopDto, isArray: true })
  topChoferes!: ChoferEnElTopDto[];
}
