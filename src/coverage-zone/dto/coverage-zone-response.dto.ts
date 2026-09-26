import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Polígono en GeoJSON: un anillo cerrado de puntos [longitud, latitud]. */
export class PoligonoGeoJsonDto {
  @ApiProperty({ enum: ['Polygon'] }) type!: 'Polygon';
  @ApiProperty({
    type: 'array',
    items: {
      type: 'array',
      items: { type: 'array', items: { type: 'number' } },
    },
    example: [
      [
        [-55.97, -27.41],
        [-55.96, -27.41],
        [-55.96, -27.42],
        [-55.97, -27.41],
      ],
    ],
  })
  coordinates!: number[][][];
}

export class CoverageZoneResponseDto {
  @ApiProperty({ format: 'uuid' }) coverage_zone_id!: string;
  @ApiProperty({ format: 'uuid' }) distributor_id!: string;
  @ApiProperty({ example: 'Itaembé Miní' }) name!: string;
  @ApiProperty({ type: PoligonoGeoJsonDto }) area!: PoligonoGeoJsonDto;
  @ApiProperty({ example: 500 }) surcharge!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}

/** Si una dirección cae dentro de una zona activa de la distribuidora. */
export class CoverageCheckResponseDto {
  @ApiProperty() covered!: boolean;
  @ApiPropertyOptional({ format: 'uuid' }) zoneId?: string;
  @ApiPropertyOptional() zoneName?: string;
  @ApiProperty({ example: 0 }) surcharge!: number;
}
