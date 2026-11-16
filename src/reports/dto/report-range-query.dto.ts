import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  Matches,
} from 'class-validator';

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
      'Desde (día en hora argentina), formato YYYY-MM-DD. Si no viene: igual a `to`, o hoy si tampoco viene `to`.',
    example: '2026-09-01',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from debe ser una fecha en formato YYYY-MM-DD',
  })
  @IsDateString({ strict: true }, { message: 'from no es una fecha válida' })
  from?: string;

  @ApiPropertyOptional({
    description:
      'Hasta (día en hora argentina, inclusive), formato YYYY-MM-DD. Si no viene: igual a `from`, o hoy.',
    example: '2026-09-30',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to debe ser una fecha en formato YYYY-MM-DD',
  })
  @IsDateString({ strict: true }, { message: 'to no es una fecha válida' })
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
  @IsEnum(Granularidad)
  granularity?: Granularidad;
}

/** Rango del resumen de ventas, con la opción de no calcular el período anterior. */
export class ReportSummaryQueryDto extends ReportRangeQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    default: true,
    description:
      'Si es `false` no se calcula el período anterior (`previous` y `previousRange` vienen en null)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  compare?: boolean;
}
