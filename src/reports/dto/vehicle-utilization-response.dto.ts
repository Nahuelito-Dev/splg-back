import { ApiProperty } from '@nestjs/swagger';

export class VehicleUtilizationCostsDto {
  @ApiProperty() fuel!: number;
  @ApiProperty() maintenance!: number;
  @ApiProperty() insurance!: number;
  @ApiProperty({ description: 'Multas y siniestros netos del vehículo' })
  other!: number;
  @ApiProperty() total!: number;
}

export class VehicleUtilizationRowDto {
  @ApiProperty({ format: 'uuid' }) vehicleId!: string;
  @ApiProperty({ type: String, nullable: true }) plate!: string | null;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) model!: string | null;
  @ApiProperty({ type: String, nullable: true }) photo!: string | null;
  @ApiProperty() daysInUse!: number;
  @ApiProperty() km!: number;
  @ApiProperty() deliveries!: number;
  @ApiProperty() insuranceEstimated!: boolean;
  @ApiProperty({ type: VehicleUtilizationCostsDto })
  costs!: VehicleUtilizationCostsDto;
  @ApiProperty({ type: Number, nullable: true }) costPerDelivery!:
    | number
    | null;
  @ApiProperty({ type: Number, nullable: true }) costPerKm!: number | null;
}

export class VehicleUtilizationTotalsDto {
  @ApiProperty() vehicles!: number;
  @ApiProperty() daysInUse!: number;
  @ApiProperty() km!: number;
  @ApiProperty() deliveries!: number;
  @ApiProperty({
    description: 'Al menos un seguro se calculó con una vigencia estimada',
  })
  insuranceEstimated!: boolean;
  @ApiProperty({ type: VehicleUtilizationCostsDto })
  costs!: VehicleUtilizationCostsDto;
  @ApiProperty({ type: Number, nullable: true }) costPerDelivery!:
    | number
    | null;
  @ApiProperty({ type: Number, nullable: true }) costPerKm!: number | null;
}

export class VehicleUtilizationReportDto {
  @ApiProperty({ type: VehicleUtilizationRowDto, isArray: true })
  rows!: VehicleUtilizationRowDto[];
  @ApiProperty({ type: VehicleUtilizationTotalsDto })
  totals!: VehicleUtilizationTotalsDto;
}
