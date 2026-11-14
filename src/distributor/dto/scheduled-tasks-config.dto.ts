import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { EsMultiploDe } from '../../common/validators/es-multiplo-de.validator';
import {
  INTERVALO_MAXIMO_SEGUNDOS,
  REINTENTO_DESPACHO_MAXIMO_SEGUNDOS,
  TIC_SEGUNDOS,
} from '../scheduled-tasks-settings';

/**
 * Cuerpo de `PUT /module-config/scheduled_tasks` (CU-173). Lo que no se
 * manda no se guarda y se lee con su valor por omisión. Cada intervalo es un múltiplo entero del ciclo de
 * base de su tarea y no pasa de 24 horas.
 */
export class ScheduledTasksConfigDto {
  @ApiPropertyOptional({
    description: `Reintentos del despacho (ofertas vencidas y pedidos sin oferta), en segundos. Múltiplo de ${TIC_SEGUNDOS.dispatchRetrySeconds}, hasta ${REINTENTO_DESPACHO_MAXIMO_SEGUNDOS} s (5 min)`,
    example: 15,
  })
  @IsOptional()
  @IsInt()
  @EsMultiploDe(TIC_SEGUNDOS.dispatchRetrySeconds)
  @Max(REINTENTO_DESPACHO_MAXIMO_SEGUNDOS)
  dispatchRetrySeconds?: number;

  @ApiPropertyOptional({
    description: `Activación de reservas con la seña paga, en segundos. Múltiplo de ${TIC_SEGUNDOS.reservationActivationSeconds}, hasta 24 h`,
    example: 300,
  })
  @IsOptional()
  @IsInt()
  @EsMultiploDe(TIC_SEGUNDOS.reservationActivationSeconds)
  @Max(INTERVALO_MAXIMO_SEGUNDOS)
  reservationActivationSeconds?: number;

  @ApiPropertyOptional({
    description: `Vencimiento de reservas sin seña, en segundos. Múltiplo de ${TIC_SEGUNDOS.unpaidReservationExpirySeconds}, hasta 24 h`,
    example: 3600,
  })
  @IsOptional()
  @IsInt()
  @EsMultiploDe(TIC_SEGUNDOS.unpaidReservationExpirySeconds)
  @Max(INTERVALO_MAXIMO_SEGUNDOS)
  unpaidReservationExpirySeconds?: number;

  @ApiPropertyOptional({
    description: `Vencimiento de pedidos de MercadoPago sin pagar, en segundos. Múltiplo de ${TIC_SEGUNDOS.unpaidMercadoPagoExpirySeconds}, hasta 24 h`,
    example: 1800,
  })
  @IsOptional()
  @IsInt()
  @EsMultiploDe(TIC_SEGUNDOS.unpaidMercadoPagoExpirySeconds)
  @Max(INTERVALO_MAXIMO_SEGUNDOS)
  unpaidMercadoPagoExpirySeconds?: number;

  @ApiPropertyOptional({
    description:
      'Hora del día (0 a 23, hora de Argentina) del aviso de vencimientos de flota',
    example: 8,
    minimum: 0,
    maximum: 23,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  fleetAlertHour?: number;
}

/** Cuerpo de `PUT /v2/module-config/scheduled_tasks`: sólo la hora de empresa. */
export class EmpresaScheduledTasksDto extends PickType(
  ScheduledTasksConfigDto,
  ['fleetAlertHour'] as const,
) {}

/** Respuesta de `GET`/`PUT /module-config/scheduled_tasks`. */
export class ScheduledTasksConfigResponseDto {
  @ApiProperty({ example: 15 })
  dispatchRetrySeconds!: number;

  @ApiProperty({ example: 300 })
  reservationActivationSeconds!: number;

  @ApiProperty({ example: 3600 })
  unpaidReservationExpirySeconds!: number;

  @ApiProperty({ example: 1800 })
  unpaidMercadoPagoExpirySeconds!: number;

  @ApiProperty({ example: 8 })
  fleetAlertHour!: number;

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
