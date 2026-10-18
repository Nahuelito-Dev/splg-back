import { OmitType, PartialType } from '@nestjs/swagger';
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
  ] as const),
) {}
