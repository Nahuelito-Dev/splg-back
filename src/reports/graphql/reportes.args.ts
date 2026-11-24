import { ArgsType, Field, registerEnumType } from '@nestjs/graphql';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { ReportRangeQueryDto } from '../dto/report-range-query.dto';

/**
 * Argumentos de las consultas de GraphQL de los informes. Extienden los DTOs
 * de la API REST: heredan sus validaciones (`class-validator`, las corre el
 * `ValidationPipe` global igual que en REST) y sólo agregan cómo se ven en el
 * esquema.
 */
const DESDE =
  'Desde (día en hora argentina), YYYY-MM-DD. Si no viene: igual a `to`, o hoy si tampoco viene `to`.';
const HASTA =
  'Hasta (día en hora argentina, inclusive), YYYY-MM-DD. Si no viene: igual a `from`, o hoy.';

@ArgsType()
export class RangoDelInformeArgs extends ReportRangeQueryDto {
  @Field(() => String, { nullable: true, description: DESDE })
  declare from?: string;

  @Field(() => String, { nullable: true, description: HASTA })
  declare to?: string;
}

@ArgsType()
export class ResumenDeVentasArgs extends RangoDelInformeArgs {
  @Field(() => Boolean, {
    nullable: true,
    defaultValue: true,
    description:
      'Si es false no se calcula el período anterior (`previous` y `previousRange` vienen en null)',
  })
  @IsOptional()
  @IsBoolean()
  compare?: boolean;
}

/**
 * Agrupamiento de la evolución de ventas en GraphQL. Mismos valores que
 * `Granularidad` de la API REST (`day`, `week`, `month`).
 */
export enum Granularity {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

registerEnumType(Granularity, {
  name: 'Granularity',
  description:
    'Cómo se agrupan las ventas: por día, por semana ISO (lunes a domingo) o por mes, en hora argentina',
});

@ArgsType()
export class EvolucionDeVentasArgs extends RangoDelInformeArgs {
  @Field(() => Granularity, {
    nullable: true,
    defaultValue: Granularity.DAY,
    description: 'Cómo se agrupan las ventas; por defecto, por día',
  })
  @IsOptional()
  @IsEnum(Granularity)
  granularity?: Granularity;
}
