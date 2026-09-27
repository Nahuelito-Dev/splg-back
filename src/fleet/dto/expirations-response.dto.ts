import { ApiProperty } from '@nestjs/swagger';
import { MaintenanceCriticality } from '../entities/maintenance-plan.entity';
import { ExpirationStatus } from '../domain/expiration-status';

export class FleetExpirationEntryDto {
  @ApiProperty({ format: 'uuid' }) taskId!: string;
  @ApiProperty({ format: 'uuid' }) planId!: string;
  @ApiProperty({ example: 'VTV' }) planName!: string;
  @ApiProperty({ enum: MaintenanceCriticality })
  criticality!: MaintenanceCriticality;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dueAt!: Date | null;
  @ApiProperty({ enum: ExpirationStatus }) expirationStatus!: ExpirationStatus;
  @ApiProperty({ type: Number, nullable: true }) daysUntilDue!: number | null;
}

export class FleetVehicleExpirationsDto {
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'AB123CD' })
  carPatent!: string | null;
  @ApiProperty({ type: String, nullable: true }) carBrand!: string | null;
  @ApiProperty({ type: String, nullable: true }) carModel!: string | null;
  @ApiProperty({
    description: 'Tiene una habilitación bloqueante vencida (CU-136/137)',
  })
  isLocked!: boolean;
  @ApiProperty({ type: FleetExpirationEntryDto, isArray: true })
  items!: FleetExpirationEntryDto[];
}

export class FleetDriverExpirationsDto {
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, nullable: true }) fullName!: string | null;
  @ApiProperty({
    description: 'Tiene una habilitación bloqueante vencida (CU-138)',
  })
  isLocked!: boolean;
  @ApiProperty({ type: FleetExpirationEntryDto, isArray: true })
  items!: FleetExpirationEntryDto[];
}

export class FleetExpirationsResponseDto {
  @ApiProperty() withinDays!: number;
  @ApiProperty({ type: FleetVehicleExpirationsDto, isArray: true })
  vehicles!: FleetVehicleExpirationsDto[];
  @ApiProperty({ type: FleetDriverExpirationsDto, isArray: true })
  drivers!: FleetDriverExpirationsDto[];
}
