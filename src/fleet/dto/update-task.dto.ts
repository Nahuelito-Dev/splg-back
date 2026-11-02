import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
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
