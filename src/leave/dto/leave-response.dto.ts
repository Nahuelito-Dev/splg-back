import { ApiProperty } from '@nestjs/swagger';
import { LeaveType } from '../entities/employee-leave.entity';
import { LeaveStatus } from '../domain/leave-state';

export class LeaveResponseDto {
  @ApiProperty({ format: 'uuid' }) leaveId!: string;
  @ApiProperty({ format: 'uuid' }) employeeId!: string;
  @ApiProperty({ example: 'Ana Pérez' }) employeeName!: string;
  @ApiProperty({ example: '0042' }) employeeFileNumber!: string;
  @ApiProperty({ enum: LeaveType }) type!: LeaveType;
  @ApiProperty({ example: '2026-12-01', format: 'date' }) startDate!: string;
  @ApiProperty({ example: '2026-12-14', format: 'date' }) endDate!: string;
  @ApiProperty({ description: 'Días corridos, ambos extremos incluidos' })
  days!: number;
  @ApiProperty({ enum: LeaveStatus }) status!: LeaveStatus;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, nullable: true })
  rejectionReason!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  requestedByUserId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  decidedByUserId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

export class LeavePageDto {
  @ApiProperty({ type: LeaveResponseDto, isArray: true })
  data!: LeaveResponseDto[];
  @ApiProperty() total!: number;
}

export class VacationBalanceDto {
  @ApiProperty({ format: 'uuid' }) employeeId!: string;
  @ApiProperty({ example: 2026 }) year!: number;
  @ApiProperty({
    description:
      'Días corridos que corresponden por la antigüedad al 31 de diciembre (14, 21, 28 o 35)',
  })
  entitledDays!: number;
  @ApiProperty({
    description:
      'Días de las licencias de vacaciones aprobadas que caen en el año',
  })
  takenDays!: number;
  @ApiProperty({ description: 'entitledDays - takenDays (puede ser negativo)' })
  balanceDays!: number;
}
