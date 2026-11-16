import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CoverageZoneSurchargeType } from '../entities/coverage-zone.entity';

/** Polígono en GeoJSON: un anillo cerrado de puntos [longitud, latitud]. */
export class PoligonoGeoJsonDto {
  @ApiProperty({ enum: ['Polygon'] }) type!: 'Polygon';
  @ApiProperty({
    type: 'array',
    items: {
      type: 'array',
      items: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
      },
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
  @ApiProperty({ example: 'Villa Lanús' }) name!: string;
  @ApiProperty({ type: PoligonoGeoJsonDto }) area!: PoligonoGeoJsonDto;

  @ApiProperty({ enum: CoverageZoneSurchargeType })
  surchargeType!: CoverageZoneSurchargeType;

  @ApiProperty({ example: 10 })
  surchargeValue!: number;

  @ApiProperty({ type: String, nullable: true, example: 'Zona centro' })
  label!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '#FF7A00' })
  color!: string | null;

  @ApiProperty({ example: 0 })
  priority!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  validFrom!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  validUntil!: Date | null;

  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}

/** Resumen de la zona ganadora, para `check` y para el snapshot del pedido. */
export class CoverageZoneResumenDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Villa Lanús' }) name!: string;
  @ApiProperty({ enum: CoverageZoneSurchargeType })
  type!: CoverageZoneSurchargeType;
  @ApiProperty({ example: 10 }) value!: number;
  @ApiProperty({ type: String, nullable: true, example: '#FF7A00' })
  color!: string | null;
}

/** Si una dirección cae dentro de una zona activa y vigente de la distribuidora. */
export class CoverageCheckResponseDto {
  @ApiProperty() covered!: boolean;

  /** @deprecated usar `zone.id`. Se mantiene por compatibilidad con clientes existentes. */
  @ApiPropertyOptional({ format: 'uuid' }) zoneId?: string;
  /** @deprecated usar `zone.name`. Se mantiene por compatibilidad con clientes existentes. */
  @ApiPropertyOptional() zoneName?: string;
  /**
   * @deprecated usar `zone.value` (y `amount` si se mandó `subtotal`). Es el
   * valor CRUDO de la zona ganadora (monto si es `fixed`, porcentaje si es
   * `percentage`), no el monto ya calculado. 0 si no hay zona cubriendo.
   */
  @ApiProperty({ example: 0 }) surcharge!: number;

  @ApiProperty({ type: CoverageZoneResumenDto, nullable: true })
  zone!: CoverageZoneResumenDto | null;

  @ApiPropertyOptional({
    example: 2260,
    description:
      'Recargo YA calculado sobre `subtotal`. Sólo viene si se mandó `subtotal` en el query.',
  })
  amount?: number;
}
