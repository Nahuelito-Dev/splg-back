import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsNumber,
  Max,
  Min,
} from 'class-validator';
import { EsEstrictamenteCreciente } from '../../common/validators/es-estrictamente-creciente.validator';
import {
  DISPATCH_FINISHING_RADIUS_MAX_METERS,
  DISPATCH_FINISHING_RADIUS_MIN_METERS,
  DISPATCH_OFFER_TTL_MAX_SECONDS,
  DISPATCH_OFFER_TTL_MIN_SECONDS,
  DISPATCH_RADIUS_MAX_KM,
  DISPATCH_RADIUS_MAX_STEPS,
  DISPATCH_RADIUS_MIN_KM,
  DISPATCH_RADIUS_MIN_STEPS,
} from '../dispatch-settings';

/**
 * Cuerpo de `PUT /module-config/dispatch` (CU-171). Lo que no se manda no se
 * guarda y se lee con su valor por omisión.
 */
export class DispatchConfigDto {
  @ApiPropertyOptional({
    description: `Pasos de radio (km) con que se amplía la búsqueda de choferes: de ${DISPATCH_RADIUS_MIN_STEPS} a ${DISPATCH_RADIUS_MAX_STEPS} pasos, cada uno entre ${DISPATCH_RADIUS_MIN_KM} y ${DISPATCH_RADIUS_MAX_KM} km y estrictamente mayor que el anterior`,
    type: [Number],
    example: [5, 10, 15, 20],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(DISPATCH_RADIUS_MIN_STEPS)
  @ArrayMaxSize(DISPATCH_RADIUS_MAX_STEPS)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  @Min(DISPATCH_RADIUS_MIN_KM, { each: true })
  @Max(DISPATCH_RADIUS_MAX_KM, { each: true })
  @EsEstrictamenteCreciente()
  radiusStepsKm?: number[];

  @ApiPropertyOptional({
    description: `Ventana de aceptación de cada oferta, en segundos (${DISPATCH_OFFER_TTL_MIN_SECONDS} a ${DISPATCH_OFFER_TTL_MAX_SECONDS}). Las ofertas ya enviadas conservan su vencimiento`,
    example: 30,
    minimum: DISPATCH_OFFER_TTL_MIN_SECONDS,
    maximum: DISPATCH_OFFER_TTL_MAX_SECONDS,
  })
  @IsOptional()
  @IsInt()
  @Min(DISPATCH_OFFER_TTL_MIN_SECONDS)
  @Max(DISPATCH_OFFER_TTL_MAX_SECONDS)
  offerTtlSeconds?: number;

  @ApiPropertyOptional({
    description: `Radio en metros al punto de entrega dentro del cual un chofer con un solo pedido en camino cuenta como «por terminar» y puede recibir otra oferta (${DISPATCH_FINISHING_RADIUS_MIN_METERS} a ${DISPATCH_FINISHING_RADIUS_MAX_METERS}). 0 lo apaga: sólo se ofrece a choferes sin pedido en curso`,
    example: 300,
    minimum: DISPATCH_FINISHING_RADIUS_MIN_METERS,
    maximum: DISPATCH_FINISHING_RADIUS_MAX_METERS,
  })
  @IsOptional()
  @IsInt()
  @Min(DISPATCH_FINISHING_RADIUS_MIN_METERS)
  @Max(DISPATCH_FINISHING_RADIUS_MAX_METERS)
  finishingRadiusMeters?: number;
}

/** Respuesta de `GET`/`PUT /module-config/dispatch`. */
export class DispatchConfigResponseDto {
  @ApiProperty({ type: [Number], example: [5, 10, 15, 20] })
  radiusStepsKm!: number[];

  @ApiProperty({ example: 30 })
  offerTtlSeconds!: number;

  @ApiProperty({ example: 300 })
  finishingRadiusMeters!: number;

  @ApiProperty({
    description:
      'true si rigen los valores por omisión (no configuró nada o todo coincide con ellos)',
    example: true,
  })
  isDefault!: boolean;

  @ApiProperty({
    description: 'Cuándo se modificó por última vez (null si nunca)',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  updatedAt!: Date | null;

  @ApiProperty({
    description: 'Usuario que la modificó por última vez (null si nunca)',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  updatedByUserId!: string | null;
}
