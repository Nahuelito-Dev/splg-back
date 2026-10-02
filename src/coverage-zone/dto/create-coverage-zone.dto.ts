import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  ValidateIf,
  IsString,
  Matches,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { EsAnilloGeografico } from '../../common/validators/es-anillo-geografico.validator';
import { EsRecargoValido } from '../validators/es-recargo-valido.validator';
import { EsPosteriorA } from '../validators/es-posterior-a.validator';
import { CoverageZoneSurchargeType } from '../entities/coverage-zone.entity';

/** `#RRGGBB` (6 dígitos hexadecimales, con `#`). */
const COLOR_HEX = /^#[0-9a-fA-F]{6}$/;

export class CreateCoverageZoneDto {
  @ApiProperty({ example: 'Villa Lanús' })
  @IsString()
  @MaxLength(120)
  name!: string;

  /**
   * Anillo del polígono como lista de puntos `[lng, lat]` (orden GeoJSON:
   * longitud primero). Mínimo 3 vértices; el service cierra el anillo si hace
   * falta. Ej: [[-55.90,-27.36],[-55.88,-27.36],[-55.88,-27.38],[-55.90,-27.36]]
   */
  @ApiProperty({
    description:
      'Anillo del polígono como lista de puntos [longitud, latitud] ' +
      '(orden GeoJSON: longitud primero). Mínimo tres vértices.',
    type: 'array',
    items: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
    },
    example: [
      [-55.9, -27.36],
      [-55.88, -27.36],
      [-55.88, -27.38],
      [-55.9, -27.36],
    ],
  })
  @IsArray()
  @ArrayMinSize(3)
  @EsAnilloGeografico()
  polygon!: number[][];

  @ApiPropertyOptional({
    enum: CoverageZoneSurchargeType,
    default: CoverageZoneSurchargeType.PERCENTAGE,
    description:
      'fixed = monto fijo en la moneda del pedido; percentage = % sobre el ' +
      'subtotal de los ítems (ya con promociones).',
  })
  // `null` no es "no vino": la columna no admite nulos, así que se valida.
  @ValidateIf((_, valor) => valor !== undefined)
  @IsEnum(CoverageZoneSurchargeType)
  surchargeType?: CoverageZoneSurchargeType;

  @ApiPropertyOptional({
    example: 10,
    default: 0,
    description:
      'Monto (fixed) o porcentaje 0-100 (percentage) del recargo de esta zona.',
  })
  @ValidateIf((_, valor) => valor !== undefined)
  @IsNumber()
  @EsRecargoValido()
  surchargeValue?: number;

  @ApiPropertyOptional({ example: 'Zona centro', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;

  @ApiPropertyOptional({
    example: '#FF7A00',
    description: 'Color hexadecimal (#RRGGBB) para pintar la zona en el mapa.',
  })
  @IsOptional()
  @Matches(COLOR_HEX, {
    message: 'color: tiene que ser un hexadecimal de 6 dígitos, ej. #FF7A00',
  })
  color?: string;

  @ApiPropertyOptional({
    default: 0,
    description:
      'Desempate entre zonas superpuestas: gana la de mayor prioridad (y, a ' +
      'igual prioridad, la de menor área).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Desde cuándo rige la zona. Sin valor: rige desde siempre.',
  })
  @IsOptional()
  @IsISO8601()
  validFrom?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Hasta cuándo rige la zona. Sin valor: no vence.',
  })
  @IsOptional()
  @IsISO8601()
  @EsPosteriorA('validFrom')
  validUntil?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
