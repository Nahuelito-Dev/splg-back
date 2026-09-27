import { ApiProperty } from '@nestjs/swagger';
import { FleetTaskResponseDto } from './task-response.dto';

/** CU-136/137: documentación y estado de habilitación de un vehículo. */
export class FleetVehicleDocumentsResponseDto {
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({
    description: 'Tiene una habilitación bloqueante vencida: no puede salir',
  })
  isLocked!: boolean;
  @ApiProperty({ type: FleetTaskResponseDto, isArray: true })
  tasks!: FleetTaskResponseDto[];
}

/** CU-138: documentación y estado de habilitación de un chofer. */
export class FleetDriverDocumentsResponseDto {
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({
    description: 'Tiene una habilitación bloqueante vencida: no puede salir',
  })
  isLocked!: boolean;
  @ApiProperty({ type: FleetTaskResponseDto, isArray: true })
  tasks!: FleetTaskResponseDto[];
}
