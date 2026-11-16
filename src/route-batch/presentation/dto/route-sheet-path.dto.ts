import { ApiProperty } from '@nestjs/swagger';

export class RouteSheetPathLegDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Pedido al que llega el tramo; `null` en la vuelta al depósito',
  })
  orderId!: string | null;

  @ApiProperty({ example: 1830, description: 'Metros por calles del tramo' })
  distanceMeters!: number;

  @ApiProperty({ example: 240, description: 'Segundos estimados del tramo' })
  durationSeconds!: number;
}

export class RouteSheetPathWarehouseDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  warehouseId!: string | null;
  @ApiProperty({ example: -27.3671 }) lat!: number;
  @ApiProperty({ example: -55.8961 }) lng!: number;
}

/** `GET /v2/route-sheets/:id/path`: el recorrido por calles de la hoja. */
export class RouteSheetPathDto {
  @ApiProperty({ format: 'uuid' }) sheetId!: string;

  @ApiProperty({
    example: 7,
    description:
      'Versión de la hoja que se trazó (la misma de `GET /v2/route-sheets/:id`)',
  })
  version!: number;

  @ApiProperty({
    type: String,
    enum: ['google', 'osrm'],
    nullable: true,
    description:
      'Quién calculó el recorrido (`osrm` si el servidor no tiene clave de Google o Google falló); `null` si no hay nada que trazar',
  })
  provider!: 'google' | 'osrm' | null;

  @ApiProperty({
    example: 18450,
    description: 'Metros por calles de todo el recorrido',
  })
  distanceMeters!: number;

  @ApiProperty({
    example: 2310,
    description: 'Segundos de manejo estimados (sin el tiempo en cada parada)',
  })
  durationSeconds!: number;

  @ApiProperty({
    example: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
    description:
      'Polilínea codificada (formato de Google, precisión 5) del recorrido entero; vacía si no hay nada que trazar',
  })
  encodedPolyline!: string;

  @ApiProperty({
    type: [RouteSheetPathLegDto],
    description:
      'Un tramo por cada punto después del primero: depósito → 1.ª parada, …, última parada → depósito',
  })
  legs!: RouteSheetPathLegDto[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Paradas que no entran en el recorrido porque su dirección no tiene coordenadas',
  })
  skippedOrderIds!: string[];

  @ApiProperty({
    type: RouteSheetPathWarehouseDto,
    nullable: true,
    description:
      'Depósito de salida y vuelta: el de la hoja o, si la hoja no tiene, el predeterminado de la distribuidora (el mismo que usa el cálculo de horarios). `null` si ese depósito está dado de baja o sin ubicación (no se reemplaza por otro): el recorrido va de la primera a la última parada',
  })
  warehouse!: RouteSheetPathWarehouseDto | null;
}
