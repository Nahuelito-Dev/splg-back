import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { User } from '../../users/entities/user.entity';

export enum AttendanceSource {
  PANEL = 'panel',
  DRIVER_APP = 'driver_app',
}

/**
 * Jornada de un empleado (CU-189, CU-190, CU-313, CU-314, CU-315): un ingreso
 * y, si ya terminó, un egreso. Es un registro de presencia: no calcula horas
 * extra ni liquidación. `workDate` es el día argentino del ingreso.
 *
 * El índice único parcial `UQ_employee_attendance_abierta` deja a lo sumo una
 * jornada abierta por empleado.
 */
// `source` usa el nombre de enum por defecto (`employee_attendance_source_enum`):
// ver la nota de `employee.entity.ts`.
@Entity('employee_attendance')
@Index('UQ_employee_attendance_abierta', ['employeeId'], {
  unique: true,
  where: '"check_out_at" IS NULL',
})
@Index('IDX_employee_attendance_day', ['distributorId', 'workDate'])
@Index('IDX_employee_attendance_employee', ['employeeId', 'workDate'])
@Check(
  'CHK_employee_attendance_period',
  '"check_out_at" IS NULL OR "check_out_at" > "check_in_at"',
)
export class EmployeeAttendance {
  @PrimaryGeneratedColumn('uuid', { name: 'attendance_id' })
  attendanceId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => Employee, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'employee_id' })
  employee?: Employee;

  @Column({ name: 'employee_id', type: 'uuid' })
  employeeId!: string;

  @Column({ name: 'work_date', type: 'date' })
  workDate!: string;

  @Column({ name: 'check_in_at', type: 'timestamptz' })
  checkInAt!: Date;

  @Column({ name: 'check_out_at', type: 'timestamptz', nullable: true })
  checkOutAt!: Date | null;

  @Column({ name: 'source', type: 'enum', enum: AttendanceSource })
  source!: AttendanceSource;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'recorded_by_user_id' })
  recordedBy?: User | null;

  @Column({ name: 'recorded_by_user_id', type: 'uuid', nullable: true })
  recordedByUserId!: string | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
