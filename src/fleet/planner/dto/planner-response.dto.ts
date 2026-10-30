import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PlanningCaseStatus,
  PlanningEscalationReason,
  PlanningWindowSource,
} from '../../entities/maintenance-planning-case.entity';
import { WindowProposalStatus } from '../../entities/maintenance-window-proposal.entity';
import { MaintenanceCriticality } from '../../entities/maintenance-plan.entity';

export class WindowProposalResponseDto {
  @ApiProperty({ format: 'uuid' }) proposalId!: string;
  @ApiProperty({ format: 'uuid' }) caseId!: string;
  @ApiProperty({ format: 'uuid' }) taskId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) windowStart!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) windowEnd!: Date;
  @ApiProperty({
    description: 'Orden en la lista de ventanas elegidas (1 es la mejor)',
  })
  rank!: number;
  @ApiProperty({ enum: WindowProposalStatus }) status!: WindowProposalStatus;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) rejectionReason!:
    | string
    | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  altWindowStart!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  altWindowEnd!: Date | null;
}

/** La propuesta como la ve el chofer: con la tarea y el vehículo a la vista. */
export class DriverProposalResponseDto extends WindowProposalResponseDto {
  @ApiProperty({ example: 'Service: aceite y filtros' }) taskName!: string;
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'AB123CD' })
  patent!: string | null;
}

export class DriverProposalPageDto {
  @ApiProperty({ type: [DriverProposalResponseDto] })
  data!: DriverProposalResponseDto[];
  @ApiProperty() total!: number;
}

export class EvaluatedWindowResponseDto {
  @ApiProperty({ type: String, format: 'date-time' }) start!: string;
  @ApiProperty({ type: String, format: 'date-time' }) end!: string;
  @ApiProperty({
    description: 'Pedidos esperados ese día en la zona del vehículo',
  })
  demand!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Vehículos que quedarían activos en la zona; null si el vehículo no tiene zona',
  })
  unitsLeft!: number | null;
  @ApiProperty({
    description:
      'Cae después del vencimiento proyectado: se ofrece lo antes posible',
  })
  urgent!: boolean;
  @ApiProperty({ description: 'Entre las que se le ofrecen al chofer' })
  offered!: boolean;
  @ApiProperty({ enum: ['coverage', 'not_selected'], nullable: true })
  discardReason!: 'coverage' | 'not_selected' | null;
}

export class PlanningCaseResponseDto {
  @ApiProperty({ format: 'uuid' }) caseId!: string;
  @ApiProperty({ enum: PlanningCaseStatus }) status!: PlanningCaseStatus;
  @ApiProperty({ format: 'uuid' }) taskId!: string;
  @ApiProperty({ example: 'Revisión técnica obligatoria (VTV)' })
  taskName!: string;
  @ApiProperty({ enum: MaintenanceCriticality })
  criticality!: MaintenanceCriticality;
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true }) patent!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) deliveryId!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) driverName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) projectedDueAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) openedAt!: Date;
  @ApiProperty({ enum: PlanningEscalationReason, nullable: true })
  escalationReason!: PlanningEscalationReason | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'El motivo del escalamiento, en castellano',
  })
  escalationText!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  escalatedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  chosenStart!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  chosenEnd!: Date | null;
  @ApiProperty({ enum: PlanningWindowSource, nullable: true })
  chosenSource!: PlanningWindowSource | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({
    type: WindowProposalResponseDto,
    nullable: true,
    description: 'La que espera respuesta del chofer',
  })
  currentProposal!: WindowProposalResponseDto | null;
  @ApiProperty({
    type: WindowProposalResponseDto,
    nullable: true,
    description: 'La última cerrada (aceptada, rechazada o vencida)',
  })
  lastProposal!: WindowProposalResponseDto | null;
  @ApiProperty({ description: 'Propuestas hechas al chofer hasta ahora' })
  proposalsCount!: number;
}

export class PlanningCaseDetailResponseDto extends PlanningCaseResponseDto {
  @ApiProperty({
    type: [WindowProposalResponseDto],
    description: 'Todas, en el orden en que se ofrecieron',
  })
  proposals!: WindowProposalResponseDto[];
  @ApiProperty({
    type: [EvaluatedWindowResponseDto],
    description:
      'El cuadro completo: ventanas evaluadas y por qué se descartó cada una',
  })
  windows!: EvaluatedWindowResponseDto[];
}

export class PlanningCasePageDto {
  @ApiProperty({ type: [PlanningCaseResponseDto] })
  data!: PlanningCaseResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'Cantidad de casos por estado, sin filtros',
  })
  counts!: Record<string, number>;
}

export class ForecastItemResponseDto {
  @ApiProperty({ format: 'uuid' }) taskId!: string;
  @ApiProperty() taskName!: string;
  @ApiProperty({ enum: MaintenanceCriticality })
  criticality!: MaintenanceCriticality;
  @ApiProperty({
    description: 'false para trámites que no pasan por un taller (el seguro)',
  })
  needsWorkshop!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dueAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true }) dueKm!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Kilómetros que faltan; negativo si ya se pasó',
  })
  kmRemaining!: number | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo llega al kilometraje, con el consumo estimado',
  })
  predictedByKmAt!: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'La primera de las dos fechas',
  })
  projectedDueAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true }) daysLeft!: number | null;
  @ApiProperty({ description: 'Entró en su anticipación' }) dueSoon!: boolean;
  @ApiProperty({
    description: 'Por kilometraje pero sin consumo con qué proyectarla',
  })
  underObservation!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scheduledAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) caseId!:
    | string
    | null;
  @ApiProperty({ enum: PlanningCaseStatus, nullable: true })
  caseStatus!: PlanningCaseStatus | null;
}

export class NextWindowResponseDto {
  @ApiProperty({ type: String, format: 'date-time' }) start!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) end!: Date;
  @ApiProperty({
    enum: PlanningCaseStatus,
    description:
      '`confirmed` programada; `awaiting_confirmation` acordada con el chofer; `negotiating` propuesta esperando respuesta',
  })
  status!: PlanningCaseStatus;
}

export class ForecastVehicleResponseDto {
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true }) patent!: string | null;
  @ApiProperty({ type: String, nullable: true }) typeCar!: string | null;
  @ApiProperty({ type: Number, nullable: true }) odometerKm!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Consumo diario estimado; null si no hay con qué estimarlo',
  })
  kmPerDay!: number | null;
  @ApiProperty({
    enum: ['own', 'fleet_average'],
    nullable: true,
    description:
      '`own`: su historial. `fleet_average`: promedio de los vehículos del mismo tipo',
  })
  usageSource!: 'own' | 'fleet_average' | null;
  @ApiProperty({
    description: 'Días con registro de uso que explican la estimación propia',
  })
  historyDays!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Último día con registro de uso (YYYY-MM-DD)',
  })
  lastUsageDay!: string | null;
  @ApiProperty({
    description:
      'El último registro es más viejo que `usageStaleDays`: no se proyecta con este consumo',
  })
  usageStale!: boolean;
  @ApiPropertyOptional({ type: NextWindowResponseDto, nullable: true })
  nextWindow!: NextWindowResponseDto | null;
  @ApiProperty({ type: [ForecastItemResponseDto] })
  items!: ForecastItemResponseDto[];
}

export class PlannerForecastResponseDto {
  @ApiProperty({ type: [ForecastVehicleResponseDto] })
  vehicles!: ForecastVehicleResponseDto[];
}

export class PlannerRunResponseDto {
  @ApiProperty() vehicles!: number;
  @ApiProperty() predictionsUpdated!: number;
  @ApiProperty() proposals!: number;
  @ApiProperty() escalated!: number;
  @ApiProperty({
    description: 'Casos escalados que se reiteraron en la bandeja',
  })
  reiterated!: number;
  @ApiProperty() groundedVehicles!: number;
  @ApiProperty({
    description: 'Tareas por kilometraje sin consumo con qué proyectarlas',
  })
  underObservation!: number;
}

export class DriverMaintenanceSettingsResponseDto {
  @ApiProperty({ example: 8 }) workshopStartHour!: number;
  @ApiProperty({ example: 13 }) workshopEndHour!: number;
  @ApiProperty({
    type: [Number],
    example: [1, 2, 3, 4, 5, 6],
    description:
      'Días de la semana en que atiende el taller (0 = domingo … 6 = sábado)',
  })
  workshopDays!: number[];
  @ApiProperty({
    type: [String],
    example: ['2026-11-23'],
    description:
      'Feriados nacionales desde hoy (YYYY-MM-DD): el taller no atiende',
  })
  holidays!: string[];
  @ApiProperty({
    description: 'Días de aviso mínimos entre la propuesta y la ventana',
  })
  minLeadDays!: number;
  @ApiProperty({
    description:
      'Hasta cuántos días hacia adelante se buscan ventanas (también para la alternativa del chofer)',
  })
  horizonDays!: number;
  @ApiProperty({ description: 'Horas de vigencia de una propuesta' })
  proposalTtlHours!: number;
}
