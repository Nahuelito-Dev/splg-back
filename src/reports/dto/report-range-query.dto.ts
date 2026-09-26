import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';

/** Cómo se agrupan los resultados en el tiempo. */
export enum Granularidad {
  DIA = 'day',
  SEMANA = 'week',
  MES = 'month',
}

/**
 * Rango de fechas de un informe.
 *
 * Los cuatro informes recibían `from` y `to` como strings sin validar. Una
 * fecha mal escrita no daba error: el servicio la interpretaba como inválida y
 * el informe salía vacío, sin que nadie supiera por qué.
 */
export class ReportRangeQueryDto {
  @ApiPropertyOptional({
    description:
      'Desde, en formato YYYY-MM-DD. Si no viene, el servicio elige un rango por defecto.',
    example: '2026-09-01',
  })
  @IsOptional()
  @IsDateString(
    { strict: false },
    { message: 'from debe ser una fecha en formato YYYY-MM-DD' },
  )
  from?: string;

  @ApiPropertyOptional({
    description: 'Hasta, en formato YYYY-MM-DD',
    example: '2026-09-30',
  })
  @IsOptional()
  @IsDateString(
    { strict: false },
    { message: 'to debe ser una fecha en formato YYYY-MM-DD' },
  )
  to?: string;
}

/** Rango con agrupamiento, para la evolución de ventas. */
export class ReportEvolutionQueryDto extends ReportRangeQueryDto {
  @ApiPropertyOptional({
    description: 'Cómo agrupar los resultados',
    enum: Granularidad,
    example: Granularidad.DIA,
  })
  @IsOptional()
  @IsEnum(Granularidad, {
    message: 'granularity debe ser day, week o month',
  })
  granularity?: Granularidad;
}
