import { PartialType } from '@nestjs/swagger';
import { CreateCoverageZoneDto } from './create-coverage-zone.dto';

/**
 * Todos los campos de `CreateCoverageZoneDto`, opcionales. La validación
 * cruzada que depende del estado ACTUAL de la zona (p. ej.: mandar sólo
 * `surchargeValue` cuando la zona ya es `percentage`, o sólo `validUntil`
 * cuando ya tiene `validFrom`) la hace el servicio con la entidad fusionada,
 * porque acá no se conoce lo que no vino en el body.
 */
export class UpdateCoverageZoneDto extends PartialType(CreateCoverageZoneDto) {}
