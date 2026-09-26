import { ApiProperty } from '@nestjs/swagger';

export class TimeSlotResponseDto {
  @ApiProperty({ format: 'uuid' }) time_slot_id!: string;
  @ApiProperty({ format: 'uuid' }) distributor_id!: string;
  @ApiProperty({ example: 'Mañana' }) name!: string;
  @ApiProperty({ example: '09:00' }) startTime!: string;
  @ApiProperty({ example: '13:00' }) endTime!: string;
  @ApiProperty({ example: 50, description: 'Pedidos por día' })
  capacity!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}

/** Disponibilidad de una franja para una fecha: capacidad, reservados, libres. */
export class SlotAvailabilityDto {
  @ApiProperty({ format: 'uuid' }) timeSlotId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() startTime!: string;
  @ApiProperty() endTime!: string;
  @ApiProperty() capacity!: number;
  @ApiProperty() booked!: number;
  @ApiProperty() remaining!: number;
}
