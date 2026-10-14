import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';

const COORDENADAS = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;
const MENSAJE = 'debe ser "lat,lng" (p. ej. -34.6037,-58.3816)';

/** Query de `GET /routes/driving`. */
export class DrivingRouteQueryDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Pedido activo (aceptado o en camino) del que se pide la ruta. El destino es siempre su dirección de entrega',
  })
  @IsUUID()
  orderId!: string;

  @ApiPropertyOptional({
    example: '-34.6037,-58.3816',
    description:
      'Origen `lat,lng`. Se usa sólo si está a pocos metros de la última posición conocida del chofer (`ROUTES_FROM_MAX_DISTANCE_M`, 300 por defecto); si no se manda, el origen es esa última posición',
  })
  @IsOptional()
  @Matches(COORDENADAS, { message: `from ${MENSAJE}` })
  from?: string;
}

export class RoutePointDto {
  @ApiProperty({ example: -34.6037 }) lat!: number;
  @ApiProperty({ example: -58.3816 }) lng!: number;
}

export class DrivingRouteDto {
  @ApiProperty({
    enum: ['google', 'osrm'],
    description:
      'Quién calculó la ruta (`osrm` si el servidor no tiene clave de Google o Google falló)',
  })
  provider!: 'google' | 'osrm';

  @ApiProperty({
    example: 5230,
    description: 'Distancia por calles, en metros',
  })
  distanceMeters!: number;

  @ApiProperty({ example: 780, description: 'Duración estimada, en segundos' })
  durationSeconds!: number;

  @ApiProperty({
    description: 'Polilínea codificada (formato de Google, precisión 5)',
  })
  encodedPolyline!: string;

  @ApiProperty({
    type: [RoutePointDto],
    description: 'La misma polilínea ya decodificada',
  })
  points!: RoutePointDto[];
}
