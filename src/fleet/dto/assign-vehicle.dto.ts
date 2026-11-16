import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

/** `PUT /delivery/:id/vehicle`: pone un vehículo en uso para el chofer. */
export class AssignVehicleDto {
  @ApiProperty({ format: 'uuid', description: 'Vehículo a poner en uso' })
  @IsUUID()
  carId!: string;

  @ApiPropertyOptional({ description: 'Motivo u observación de la asignación' })
  @IsOptional()
  @IsString()
  note?: string;
}
