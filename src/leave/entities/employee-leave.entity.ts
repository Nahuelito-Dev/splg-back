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
import { LeaveStatus } from '../domain/leave-state';

export enum LeaveType {
  VACATION = 'vacation',
  SICK = 'sick',
  WORK_ACCIDENT = 'work_accident',
  STUDY = 'study',
  MARRIAGE = 'marriage',
  BIRTH = 'birth',
  BEREAVEMENT = 'bereavement',
  UNPAID = 'unpaid',
  SUSPENSION = 'suspension',
  UNJUSTIFIED_ABSENCE = 'unjustified_absence',
  OTHER = 'other',
}

/**
 * Licencia o ausencia de un empleado (CU-191, CU-192, CU-316 a CU-319). Las
 * fechas son días calendario `YYYY-MM-DD`; `days` son días corridos con ambos
 * extremos. Dos licencias solicitadas o aprobadas del mismo empleado no se
 * pisan: lo garantiza el servicio bajo el lock del legajo y, en la base, el
 * trigger `employee_leave_no_overlap` (migración `DocumentacionAsistenciaYLicenciasDelPersonal`;
 * TypeORM no modela triggers).
 */
// Los enums llevan el nombre por defecto de TypeORM (`<tabla>_<columna>_enum`),
// sin `enumName`: ver la nota en `employee.entity.ts`.
@Entity('employee_leave')
@Index('IDX_employee_leave_employee', [
  'employeeId',
  'status',
  'startDate',
  'endDate',
])
@Index('IDX_employee_leave_distributor', ['distributorId', 'status'])
@Check('CHK_employee_leave_period', '"end_date" >= "start_date"')
export class EmployeeLeave {
  @PrimaryGeneratedColumn('uuid', { name: 'leave_id' })
  leaveId!: string;

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

  @Column({ name: 'type', type: 'enum', enum: LeaveType })
  type!: LeaveType;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate!: string;

  @Column({ name: 'days', type: 'int' })
  days!: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: LeaveStatus,
    default: LeaveStatus.REQUESTED,
  })
  status!: LeaveStatus;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason!: string | null;

  /** Por qué se rechazó (obligatorio al rechazar). */
  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'requested_by_user_id' })
  requestedBy?: User | null;

  @Column({ name: 'requested_by_user_id', type: 'uuid', nullable: true })
  requestedByUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'decided_by_user_id' })
  decidedBy?: User | null;

  @Column({ name: 'decided_by_user_id', type: 'uuid', nullable: true })
  decidedByUserId!: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
