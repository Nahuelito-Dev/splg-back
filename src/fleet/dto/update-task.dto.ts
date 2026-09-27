import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateFleetTaskDto } from './create-task.dto';

/**
 * `planId`, `carId` y `deliveryId` no se editan: si cambia a qué apuntan, se
 * cancela esta tarea y se crea otra.
 */
export class UpdateFleetTaskDto extends PartialType(
  OmitType(CreateFleetTaskDto, ['planId', 'carId', 'deliveryId'] as const),
) {}
