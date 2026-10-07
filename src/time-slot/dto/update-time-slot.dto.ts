import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateTimeSlotDto } from './create-time-slot.dto';

/**
 * Edición parcial de una franja: los mismos campos del alta, más `isActive`
 * para reactivar (o desactivar) sin pasar por el DELETE.
 */
export class UpdateTimeSlotDto extends PartialType(CreateTimeSlotDto) {
  @ApiPropertyOptional({
    example: true,
    description: 'true reactiva la franja; false la desactiva (baja lógica)',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
