import { ApiProperty } from '@nestjs/swagger';

/** `GET /delivery/:id/vehicle` (y `/delivery/me/vehicle`): el vehículo en uso del chofer. */
export class VehicleInUseResponseDto {
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'AB123CD' })
  carPatent!: string | null;
  @ApiProperty({ type: String, nullable: true }) carBrand!: string | null;
  @ApiProperty({ type: String, nullable: true }) carModel!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Moto' })
  carTypeCar!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Foto del vehículo: URL firmada de corta vigencia, o null',
  })
  photoUrl!: string | null;
  @ApiProperty({
    description:
      'Si el vehículo está inhabilitado por documentación vencida (CU-136/137)',
  })
  isLocked!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) assignedAt!: Date;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

/** Un renglón de `GET /delivery/:id/vehicle-history` o `GET /car/:id/assignments`. */
export class VehicleAssignmentHistoryResponseDto {
  @ApiProperty({ format: 'uuid' }) assignmentId!: string;
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true }) carPatent!: string | null;
  @ApiProperty({ type: String, nullable: true }) carBrand!: string | null;
  @ApiProperty({ type: String, nullable: true }) carModel!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Foto del vehículo: URL firmada de corta vigencia, o null',
  })
  photoUrl!: string | null;
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({ type: String, nullable: true }) driverName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) assignedAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  releasedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}
