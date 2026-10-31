import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { RouteBatchStatus } from '../../order/entities/route-batch.entity';

export class QueryRouteBatchesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: RouteBatchStatus })
  @IsOptional()
  @IsEnum(RouteBatchStatus)
  status?: RouteBatchStatus;
}

/** Parámetros de la agrupación a cambiar; lo que no viene queda como estaba. */
export class PatchRouteBatchSettingsDto {
  @ApiPropertyOptional({
    description: 'Pedidos máximos por lote (2 a 20)',
    example: 4,
  })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(20)
  maxBatchSize?: number;

  @ApiPropertyOptional({
    description:
      'Radio de agrupación en km: distancia máxima entre paradas del mismo lote (0,5 a 50)',
    example: 3,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(50)
  groupingRadiusKm?: number;

  @ApiPropertyOptional({
    description:
      'Tolerancia de franja en minutos: cuánto pueden diferir las franjas de un lote (0 a 480)',
    example: 60,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(480)
  slotToleranceMinutes?: number;

  @ApiPropertyOptional({
    description: 'Vigencia de la oferta del lote, en segundos (10 a 600)',
    example: 60,
  })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(600)
  offerTtlSeconds?: number;

  @ApiPropertyOptional({
    description: 'Cada cuántos minutos se arman lotes (1 a 1440)',
    example: 15,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  evaluationFrequencyMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Interruptor del módulo: 1 lo enciende, 0 lo apaga (viene apagado)',
    example: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1)
  enabled?: number;

  @ApiPropertyOptional({
    description:
      'Con el módulo encendido, minutos antes del inicio de la franja en que el despacho individual recién ofrece un pedido programado; hasta entonces es candidato a un lote (0 a 720; 0: no espera)',
    example: 60,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  batchingHoldMinutes?: number;
}
