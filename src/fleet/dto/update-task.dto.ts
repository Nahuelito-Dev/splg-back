import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { CreateFleetTaskDto } from './create-task.dto';

/**
 * `planId`, `carId`, `deliveryId` y `employeeId` no se editan: si cambia a qué
 * apuntan, se cancela esta tarea y se crea otra.
 */
export class UpdateFleetTaskDto extends PartialType(
  OmitType(CreateFleetTaskDto, [
    'planId',
    'carId',
    'deliveryId',
    'employeeId',
    'scheduledAt',
  ] as const),
) {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo está agendado el turno/trámite. Si la tarea tiene un caso del planificador de taller (M2) confirmado ' +
      'cuya ventana no terminó, cambiar el turno mueve esa ventana (y con ella el bloqueo del despacho) en la misma ' +
      'operación: un `YYYY-MM-DD` (o medianoche argentina) la lleva a ese día argentino conservando su hora de inicio; ' +
      'un instante con hora la hace arrancar a esa hora; en ambos casos la duración se conserva y la ventana nueva ' +
      'tiene que ser a futuro (400 si no). `null` borra el turno y cancela el caso confirmado. Un turno igual al ' +
      'guardado no toca la tarea ni el caso.',
  })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string | null;
}

/**
 * Edición desde el tablero (API v2): lo de la v1, el responsable y la
 * precondición. El vehículo, el chofer, el empleado del legajo y el plan
 * siguen sin editarse (se cancela la tarea y se crea otra).
 */
export class UpdateFleetTaskV2Dto extends UpdateFleetTaskDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Responsable de la tarea: un empleado activo de la distribuidora (404 si no es de ella, 409 si está egresado). `null` lo quita',
  })
  @IsOptional()
  @IsUUID()
  assigneeEmployeeId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Precondición: el `updatedAt` que tiene el panel. Si la tarea cambió, 409 `FLEET_TASK_STALE`. También se acepta en el header `If-Match`',
  })
  @IsOptional()
  @IsDateString()
  expectedUpdatedAt?: string;
}
