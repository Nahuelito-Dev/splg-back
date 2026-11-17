import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MaintenanceTaskStatus } from '../entities/maintenance-task.entity';
import { FleetPlanResponseDto } from './plan-response.dto';
import { FleetTaskAttachmentResponseDto } from './attachment-response.dto';
import { ExpirationStatus } from '../domain/expiration-status';

export class FleetTaskResponseDto {
  @ApiProperty({ format: 'uuid' }) taskId!: string;
  @ApiProperty({ format: 'uuid' }) planId!: string;
  @ApiPropertyOptional({ type: FleetPlanResponseDto })
  plan?: FleetPlanResponseDto;
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  carId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  deliveryId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  employeeId!: string | null;
  @ApiProperty({ enum: MaintenanceTaskStatus }) status!: MaintenanceTaskStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  validFrom!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dueAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true }) dueKm!: number | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scheduledAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  performedAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true }) odometerKm!: number | null;
  @ApiProperty({ type: Number, nullable: true }) cost!: number | null;
  @ApiProperty({ type: String, nullable: true }) provider!: string | null;
  @ApiProperty({ type: String, nullable: true })
  referenceNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) category!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    nullable: true,
    description:
      'Datos propios del tipo de documento (según `plan.documentKind`)',
  })
  details!: Record<string, string> | null;

  @ApiProperty({
    enum: ExpirationStatus,
    nullable: true,
    description:
      'null si no tiene fecha límite (p. ej. un service todavía sin fecha estimada) o si ya está cerrada/cancelada',
  })
  expirationStatus!: ExpirationStatus | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Días hasta el vencimiento (negativo si ya venció)',
  })
  daysUntilDue!: number | null;

  @ApiProperty({
    description: 'Si esta tarea, vencida, inhabilita al vehículo/chofer',
  })
  blocks!: boolean;

  @ApiPropertyOptional({ type: FleetTaskAttachmentResponseDto, isArray: true })
  attachments?: FleetTaskAttachmentResponseDto[];
}

/** La tarea con su estado de pago (API v2). */
export class FleetTaskV2ResponseDto extends FleetTaskResponseDto {
  @ApiProperty({ description: 'Si la tarea ya salió de una caja' })
  isPaid!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  cashMovementId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true })
  paidAmount!: number | null;
  @ApiProperty({
    description:
      'Si se puede pagar desde una caja con `POST /fleet/tasks/:id/pay`: hecha, con costo, sin pagar y que no sea de seguro',
  })
  payable!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Por qué no se paga por acá, cuando es por la naturaleza de la tarea (el seguro se paga por sus cuotas)',
  })
  notPayableReason!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Responsable de la tarea en el tablero',
  })
  assigneeEmployeeId!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Última modificación: la precondición para editar o mover (`expectedUpdatedAt` / `If-Match`)',
  })
  updatedAt!: Date;
}

export class FleetTaskV2PageDto {
  @ApiProperty({ type: FleetTaskV2ResponseDto, isArray: true })
  data!: FleetTaskV2ResponseDto[];
  @ApiProperty() total!: number;
}
