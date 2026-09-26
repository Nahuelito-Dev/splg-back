import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EsAnilloGeografico } from '../../common/validators/es-anillo-geografico.validator';

export class CreateCoverageZoneDto {
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

  /** Recargo de reparto para esta zona (0 = sin recargo). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  surcharge?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
