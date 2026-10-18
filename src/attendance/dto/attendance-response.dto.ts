import { ApiProperty } from '@nestjs/swagger';
import { AttendanceSource } from '../entities/employee-attendance.entity';

export class AttendanceResponseDto {
  @ApiProperty({ format: 'uuid' }) attendanceId!: string;
  @ApiProperty({ format: 'uuid' }) employeeId!: string;
  @ApiProperty({ example: 'Ana Pérez' }) employeeName!: string;
  @ApiProperty({ example: '0042' }) employeeFileNumber!: string;
  @ApiProperty({ example: '2026-03-02', format: 'date' }) workDate!: string;
  @ApiProperty({ type: String, format: 'date-time' }) checkInAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  checkOutAt!: Date | null;
  @ApiProperty({ description: 'Jornada sin cerrar' }) isOpen!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Minutos trabajados; null mientras está abierta',
  })
  durationMinutes!: number | null;
  @ApiProperty({ enum: AttendanceSource }) source!: AttendanceSource;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  recordedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
}

export class AttendancePageDto {
  @ApiProperty({ type: AttendanceResponseDto, isArray: true })
  data!: AttendanceResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty({
    description:
      'Empleados presentes hoy de la distribuidora: jornada abierta del día de hoy (no depende de los filtros)',
  })
  presentToday!: number;
  @ApiProperty({
    description:
      'Jornadas de días anteriores que quedaron sin cerrar y esperan su corrección (no depende de los filtros)',
  })
  staleOpen!: number;
}
