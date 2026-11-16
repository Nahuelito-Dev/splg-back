import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  EXPRESS_ESTIMATED_MAX_MINUTES,
  EXPRESS_ESTIMATED_MIN_MINUTES,
  EXPRESS_OFFER_TTL_MAX_SECONDS,
  EXPRESS_OFFER_TTL_MIN_SECONDS,
  EXPRESS_RADIUS_MAX_KM,
  EXPRESS_RADIUS_MIN_KM,
  EXPRESS_SURCHARGE_MAX,
  HORA_FORMATO,
  STANDARD_ESTIMATED_MAX_MINUTES,
  STANDARD_ESTIMATED_MIN_MINUTES,
} from '../express-settings';

/**
 * Cuerpo de `PUT /module-config/express_dispatch`. Lo que no se manda se guarda
 * con su valor por omisión (la configuración se reemplaza entera).
 */
export class ExpressConfigDto {
  @ApiPropertyOptional({
    description: 'Ofrecer la modalidad express (apagada por omisión)',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: `Recargo express fijo en pesos (0 a ${EXPRESS_SURCHARGE_MAX})`,
    example: 1500,
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(EXPRESS_SURCHARGE_MAX)
  surchargeAmount?: number;

  @ApiPropertyOptional({
    description: `Radio máximo, en km, en que se busca un chofer en moto (${EXPRESS_RADIUS_MIN_KM} a ${EXPRESS_RADIUS_MAX_KM}); no se amplía`,
    example: 5,
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(EXPRESS_RADIUS_MIN_KM)
  @Max(EXPRESS_RADIUS_MAX_KM)
  maxRadiusKm?: number;

  @ApiPropertyOptional({
    description: `Ventana de aceptación de cada oferta express, en segundos (${EXPRESS_OFFER_TTL_MIN_SECONDS} a ${EXPRESS_OFFER_TTL_MAX_SECONDS})`,
    example: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(EXPRESS_OFFER_TTL_MIN_SECONDS)
  @Max(EXPRESS_OFFER_TTL_MAX_SECONDS)
  offerTtlSeconds?: number;

  @ApiPropertyOptional({
    description: 'Inicio del horario express (HH:mm, hora argentina)',
    example: '08:00',
  })
  @IsOptional()
  @Matches(HORA_FORMATO, { message: 'serviceFrom debe ser HH:mm' })
  serviceFrom?: string;

  @ApiPropertyOptional({
    description:
      'Fin del horario express (HH:mm, hora argentina, exclusivo); posterior al inicio',
    example: '20:00',
  })
  @IsOptional()
  @Matches(HORA_FORMATO, { message: 'serviceTo debe ser HH:mm' })
  serviceTo?: string;

  @ApiPropertyOptional({
    description: `Tiempo estimado de la entrega express, en minutos (${EXPRESS_ESTIMATED_MIN_MINUTES} a ${EXPRESS_ESTIMATED_MAX_MINUTES})`,
    example: 45,
  })
  @IsOptional()
  @IsInt()
  @Min(EXPRESS_ESTIMATED_MIN_MINUTES)
  @Max(EXPRESS_ESTIMATED_MAX_MINUTES)
  estimatedMinutes?: number;

  @ApiPropertyOptional({
    description: `Tiempo estimado del reparto común, en minutos (${STANDARD_ESTIMATED_MIN_MINUTES} a ${STANDARD_ESTIMATED_MAX_MINUTES})`,
    example: 180,
  })
  @IsOptional()
  @IsInt()
  @Min(STANDARD_ESTIMATED_MIN_MINUTES)
  @Max(STANDARD_ESTIMATED_MAX_MINUTES)
  standardEstimatedMinutes?: number;
}

/** Respuesta de `GET`/`PUT /module-config/express_dispatch`. */
export class ExpressConfigResponseDto {
  @ApiProperty({ example: false })
  enabled!: boolean;

  @ApiProperty({ example: 1500 })
  surchargeAmount!: number;

  @ApiProperty({ example: 5 })
  maxRadiusKm!: number;

  @ApiProperty({ example: 20 })
  offerTtlSeconds!: number;

  @ApiProperty({ example: '08:00' })
  serviceFrom!: string;

  @ApiProperty({ example: '20:00' })
  serviceTo!: string;

  @ApiProperty({ example: 45 })
  estimatedMinutes!: number;

  @ApiProperty({ example: 180 })
  standardEstimatedMinutes!: number;

  @ApiProperty({
    description:
      'true si rigen los valores por omisión (no configuró nada o todo coincide con ellos)',
    example: true,
  })
  isDefault!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt!: Date | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  updatedByUserId!: string | null;
}
