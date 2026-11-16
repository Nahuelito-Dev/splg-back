import { IsOptional, IsISO8601 } from 'class-validator';
import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { CreateCoverageZoneDto } from './create-coverage-zone.dto';
import { EsPosteriorA } from '../validators/es-posterior-a.validator';

/**
 * Todos los campos de `CreateCoverageZoneDto`, opcionales. La validación
 * cruzada que depende del estado ACTUAL de la zona (p. ej.: mandar sólo
 * `surchargeValue` cuando la zona ya es `percentage`, o sólo `validUntil`
 * cuando ya tiene `validFrom`) la hace el servicio con la entidad fusionada,
 * porque acá no se conoce lo que no vino en el body.
 *
 * `validFrom`/`validUntil` se excluyen de la base (`OmitType`) y se
 * redeclaran abajo (en vez de heredar el `string` de creación) porque en una
 * actualización tienen un tercer significado: mandar `null` explícito es la
 * forma de QUITAR la vigencia (deja de tener un "desde"/"hasta"). `@IsOptional`
 * ya deja pasar `null` sin validar; sólo hacía falta que el tipo lo admita, y
 * `PartialType` no puede ampliar a `| null` lo que la base declaró `string`.
 */
export class UpdateCoverageZoneDto extends PartialType(
  OmitType(CreateCoverageZoneDto, ['validFrom', 'validUntil']),
) {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Desde cuándo rige la zona. Un día `YYYY-MM-DD` rige desde las 00:00 de Argentina. `null` quita el límite (rige desde siempre).',
  })
  @IsOptional()
  @IsISO8601()
  validFrom?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Hasta cuándo rige la zona. Un día `YYYY-MM-DD` incluye ese día entero (vence a las 23:59:59.999 de Argentina). `null` quita el vencimiento.',
  })
  @IsOptional()
  @IsISO8601()
  @EsPosteriorA('validFrom')
  validUntil?: string | null;
}
