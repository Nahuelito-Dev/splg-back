import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { MaintenanceCriticality } from './entities/maintenance-plan.entity';
import { MaintenanceTaskAttachment } from './entities/maintenance-task-attachment.entity';
import { FleetTaskResponseDto } from './dto/task-response.dto';
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
    dto.status = task.status;
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
}
