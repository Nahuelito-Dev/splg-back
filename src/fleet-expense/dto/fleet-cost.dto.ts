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
