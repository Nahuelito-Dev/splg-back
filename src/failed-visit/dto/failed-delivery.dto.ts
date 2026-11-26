import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { FailedVisitReason } from '../domain/nueva-visita';

/** Un día (`AAAA-MM-DD`) y una franja horaria de la distribuidora. */
export class RevisitChoiceDto {
  @ApiProperty({ type: String, format: 'date', example: '2026-11-26' })
  @IsISO8601({ strict: true })
  @MaxLength(10)
  scheduledDate!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  timeSlotId!: string;
}

/**
 * Body de `POST /api/v3/orders/:id/failed-delivery`. El chofer manda el motivo
 * y su ubicación; si acordó con el cliente cuándo volver, el día y la franja.
 * Un admin lo informa sin ubicación.
 */
export class FailedDeliveryDto {
  @ApiProperty({
    enum: FailedVisitReason,
    example: FailedVisitReason.CUSTOMER_ABSENT,
    description:
      'customer_absent (no estaba), address_closed (domicilio cerrado), rejected (rechazó el pedido), other (otro: pide `note`)',
  })
  @IsEnum(FailedVisitReason)
  reason!: FailedVisitReason;

  @ApiPropertyOptional({
    type: String,
    maxLength: 300,
    example: 'Toqué timbre y nadie atendió',
    description: 'Obligatoria (3 caracteres o más) con `reason: other`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @ApiPropertyOptional({
    type: Number,
    example: -27.3671,
    minimum: -90,
    maximum: 90,
    description: 'Latitud del chofer al informar. Obligatoria para el chofer.',
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({
    type: Number,
    example: -55.8961,
    minimum: -180,
    maximum: 180,
    description: 'Longitud del chofer al informar. Obligatoria para el chofer.',
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({
    type: Number,
    example: 12.5,
    minimum: 0,
    maximum: 10000,
    description: 'Precisión del GPS en metros',
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10000)
  accuracyMeters?: number;

  @ApiPropertyOptional({
    type: RevisitChoiceDto,
    description:
      '«Acordé con el cliente»: el día y la franja en que se vuelve a pasar. Tiene que ser un día hábil con cupo en la franja',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => RevisitChoiceDto)
  agreed?: RevisitChoiceDto;
}
