import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { MaintenanceCriticality } from './entities/maintenance-plan.entity';
import { MaintenanceTaskAttachment } from './entities/maintenance-task-attachment.entity';
import {
  FleetTaskResponseDto,
  FleetTaskV2ResponseDto,
} from './dto/task-response.dto';
import { esDeSeguro, MOTIVO_SEGURO } from './fleet-task.service';
import { FleetPlanMapper } from './fleet-plan.mapper';
import { FleetAttachmentMapper } from './fleet-attachment.mapper';
import {
  calcularEstadoDeVencimiento,
  diasHastaElVencimiento,
} from './domain/expiration-status';

const ESTADOS_CERRADOS = new Set<MaintenanceTaskStatus>([
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
]);

export class FleetTaskMapper {
  /**
   * Requiere `task.plan` cargado (relations: ['plan']): de ahí sale
   * `leadTimeDays` y `criticality` para calcular `expirationStatus`/`blocks`.
   */
  static toDto(
    task: MaintenanceTask,
    attachments?: MaintenanceTaskAttachment[],
  ): FleetTaskResponseDto {
    const dto = new FleetTaskResponseDto();
    dto.taskId = task.taskId;
    dto.planId = task.planId;
    if (task.plan) dto.plan = FleetPlanMapper.toDto(task.plan);
    dto.distributorId = task.distributorId;
    dto.carId = task.carId;
    dto.deliveryId = task.deliveryId;
    dto.employeeId = task.employeeId;
    dto.status = task.status;
    dto.validFrom = task.validFrom;
    dto.dueAt = task.dueAt;
    dto.dueKm = task.dueKm;
    dto.scheduledAt = task.scheduledAt;
    dto.performedAt = task.performedAt;
    dto.odometerKm = task.odometerKm;
    dto.cost = task.cost;
    dto.provider = task.provider;
    dto.referenceNumber = task.referenceNumber;
    dto.category = task.category;
    dto.notes = task.notes;
    dto.details = task.details;

    const abierta = !ESTADOS_CERRADOS.has(task.status);
    dto.expirationStatus = abierta
      ? calcularEstadoDeVencimiento(task.dueAt, task.plan?.leadTimeDays ?? 0)
      : null;
    dto.daysUntilDue = abierta ? diasHastaElVencimiento(task.dueAt) : null;
    dto.blocks = task.plan?.criticality === MaintenanceCriticality.BLOCKING;

    if (attachments) {
      dto.attachments = attachments.map((a) => FleetAttachmentMapper.toDto(a));
    }

    return dto;
  }

  /** La tarea con su estado de pago (API v2). */
  static toV2Dto(
    task: MaintenanceTask,
    attachments?: MaintenanceTaskAttachment[],
  ): FleetTaskV2ResponseDto {
    const dto = Object.assign(
      new FleetTaskV2ResponseDto(),
      FleetTaskMapper.toDto(task, attachments),
    );
    dto.cashMovementId = task.cashMovementId;
    dto.paidAt = task.paidAt;
    dto.paidAmount = task.paidAmount;
    dto.isPaid = task.cashMovementId !== null;
    const seguro = esDeSeguro(task.plan);
    dto.notPayableReason = seguro ? MOTIVO_SEGURO : null;
    dto.assigneeEmployeeId = task.assigneeEmployeeId;
    dto.updatedAt = task.updatedAt;
    dto.payable =
      task.status === MaintenanceTaskStatus.DONE &&
      (task.cost ?? 0) > 0 &&
      !dto.isPaid &&
      !seguro;
    return dto;
  }
}
