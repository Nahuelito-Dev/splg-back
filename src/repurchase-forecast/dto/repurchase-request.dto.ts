import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { RepurchaseInvitationStatus } from '../entities/repurchase-invitation.entity';

export const VENTANA_MAXIMA_DIAS = 90;

/** CU-146: la ventana de días hacia adelante y la página. */
export class QueryRepurchaseForecastDto {
  @ApiPropertyOptional({
    default: 14,
    minimum: 1,
    maximum: VENTANA_MAXIMA_DIAS,
    description:
      'Ventana: clientes a los que se les acaba el gas dentro de estos días (incluye a los que ya se pasaron de la fecha y siguen proyectados)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VENTANA_MAXIMA_DIAS)
  days?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class QueryRepurchaseInvitationsDto {
  @ApiPropertyOptional({ enum: RepurchaseInvitationStatus })
  @IsOptional()
  @IsEnum(RepurchaseInvitationStatus)
  status?: RepurchaseInvitationStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sólo las de este cliente',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Emitidas desde este día (YYYY-MM-DD, hora argentina)',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description: 'Emitidas hasta este día inclusive',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class QueryRepurchaseStatsDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Desde este día (por omisión, 90 días atrás)',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description: 'Hasta este día inclusive (por omisión, hoy)',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class RunRepurchaseDto {
  @ApiPropertyOptional({
    description:
      'Con true sólo calcula a quién se invitaría: no escribe, no vence nada y no avisa a nadie. Por omisión, false',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/** CU-145: cómo quiere el cliente el aviso. Al menos un campo. */
export class UpdateRepurchaseNoticeDto {
  @ApiPropertyOptional({
    description: 'false desactiva el aviso; true lo reactiva',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 30,
    description:
      'Días de anticipación (1 a 30). `null` vuelve al valor de la distribuidora',
  })
  @IsOptional()
  @ValidateIf((o: UpdateRepurchaseNoticeDto) => o.days !== null)
  @IsInt()
  @Min(1)
  @Max(30)
  days?: number | null;
}
