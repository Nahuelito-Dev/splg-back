import { IsLatitude, IsLongitude } from 'class-validator';
import { Type } from 'class-transformer';

/** Punto a chequear contra las zonas de una distribuidora. */
export class CheckCoverageDto {
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @Type(() => Number)
  @IsLongitude()
  lng: number;
}
