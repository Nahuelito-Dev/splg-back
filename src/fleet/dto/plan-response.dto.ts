import { ApiProperty } from '@nestjs/swagger';
import {
  MaintenanceCriticality,
  MaintenanceSubject,
  MaintenanceTrigger,
} from '../entities/maintenance-plan.entity';

export class FleetPlanResponseDto {
  @ApiProperty({ format: 'uuid' }) planId!: string;
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: MaintenanceSubject }) subject!: MaintenanceSubject;
  @ApiProperty({ enum: MaintenanceTrigger }) trigger!: MaintenanceTrigger;
  @ApiProperty({ type: Number, nullable: true }) intervalKm!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  intervalMonths!: number | null;
  @ApiProperty() leadTimeDays!: number;
  @ApiProperty({ enum: MaintenanceCriticality })
  criticality!: MaintenanceCriticality;
  @ApiProperty({ type: String, nullable: true }) carType!: string | null;
  @ApiProperty() isActive!: boolean;
}
