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

export class CreateCoverageZoneDto {
  @IsString()
  @MaxLength(120)
  name: string;

  /**
   * Anillo del polígono como lista de puntos `[lng, lat]` (orden GeoJSON:
   * longitud primero). Mínimo 3 vértices; el service cierra el anillo si hace
   * falta. Ej: [[-55.90,-27.36],[-55.88,-27.36],[-55.88,-27.38],[-55.90,-27.36]]
   */
  @IsArray()
  @ArrayMinSize(3)
  polygon: number[][];

  /** Recargo de reparto para esta zona (0 = sin recargo). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  surcharge?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
