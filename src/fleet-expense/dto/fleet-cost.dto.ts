import { ApiProperty } from '@nestjs/swagger';
import type { FuenteDeKm } from '../domain/vehicle-cost';

const FUENTES: FuenteDeKm[] = ['usage_log', 'odometer', 'none'];

export class FleetCostSummaryDto {
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true }) carPatent!: string | null;
  @ApiProperty({ type: String, nullable: true }) carBrand!: string | null;
  @ApiProperty({ type: String, nullable: true }) carModel!: string | null;
  @ApiProperty({
    description: 'Tareas de mantenimiento hechas, sin los seguros',
  })
  maintenance!: number;
  @ApiProperty({ description: 'Primas prorrateadas por los días del período' })
  insurance!: number;
  @ApiProperty({ description: 'Cargas de combustible vigentes' })
  fuel!: number;
  @ApiProperty({ description: 'Multas pagadas que no se imputaron al chofer' })
  fines!: number;
  @ApiProperty({
    description: 'Siniestros cerrados: reparación menos reintegro del seguro',
  })
  accidents!: number;
  @ApiProperty() total!: number;
  @ApiProperty({
    description:
      'Alguna póliza no tenía inicio de vigencia y se prorrateó con un año hacia atrás',
  })
  insuranceEstimated!: boolean;
  @ApiProperty({ description: 'Kilómetros del período' }) km!: number;
  @ApiProperty({
    enum: FUENTES,
    description:
      'De dónde salen los km: el registro de uso diario, la diferencia de kilometraje entre cargas, o ninguno',
  })
  kmSource!: FuenteDeKm;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '`null` si no hubo km',
  })
  costPerKm!: number | null;
}

export class CostMonthDto {
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty() maintenance!: number;
  @ApiProperty() insurance!: number;
  @ApiProperty() fuel!: number;
  @ApiProperty() fines!: number;
  @ApiProperty() accidents!: number;
  @ApiProperty() total!: number;
}

export class CarCostDetailDto extends FleetCostSummaryDto {
  @ApiProperty({ example: '2026-10-01' }) from!: string;
  @ApiProperty({ example: '2026-10-31' }) to!: string;
  @ApiProperty({
    type: CostMonthDto,
    isArray: true,
    description: 'Evolución mensual del período',
  })
  monthly!: CostMonthDto[];
}

export class FleetCostTotalsDto {
  @ApiProperty({ example: 3, description: 'Vehículos del tablero' })
  vehicles!: number;
  @ApiProperty({ description: 'Mantenimiento de toda la flota' })
  maintenance!: number;
  @ApiProperty({ description: 'Seguros prorrateados de toda la flota' })
  insurance!: number;
  @ApiProperty({ description: 'Combustible de toda la flota' })
  fuel!: number;
  @ApiProperty({ description: 'Multas de toda la flota' })
  fines!: number;
  @ApiProperty({ description: 'Siniestros de toda la flota' })
  accidents!: number;
  @ApiProperty({
    description:
      'Costo total del período: suma de los vehículos, con o sin km. Excluye los vehículos dados de baja',
  })
  total!: number;
  @ApiProperty({
    description: 'Suma de los km de los vehículos que tienen km',
  })
  km!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Costo de los vehículos con km sobre sus km. `null` si ninguno tiene km',
  })
  costPerKm!: number | null;
  @ApiProperty({
    description: 'Vehículos sin km: no entran al costo por km',
  })
  withoutKm!: number;
}

export class FleetCostBoardDto {
  @ApiProperty({ example: '2026-10-01' }) from!: string;
  @ApiProperty({ example: '2026-10-31' }) to!: string;
  @ApiProperty({
    type: FleetCostTotalsDto,
    description:
      'Los totales de la flota en el período, calculados por el back',
  })
  summary!: FleetCostTotalsDto;
  @ApiProperty({
    type: FleetCostSummaryDto,
    isArray: true,
    description:
      'Un renglón por vehículo, de mayor a menor costo por km; sin km, al final',
  })
  vehicles!: FleetCostSummaryDto[];
}
