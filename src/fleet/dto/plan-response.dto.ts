import { ApiProperty } from '@nestjs/swagger';
import { JobPositionCategory } from '../../employee/entities/job-position.entity';
import {
  MaintenanceDocumentKind,
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
  @ApiProperty({
    enum: MaintenanceDocumentKind,
    nullable: true,
    description:
      'Qué formulario muestra el panel y qué forma de `details` valida el back',
  })
  documentKind!: MaintenanceDocumentKind | null;
  @ApiProperty({
    enum: JobPositionCategory,
    isArray: true,
    nullable: true,
    description: 'Categorías de puesto a las que aplica (null = todas)',
  })
  appliesToCategories!: JobPositionCategory[] | null;
  @ApiProperty() isActive!: boolean;
}
