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
  DeleteDateColumn,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { JobPosition } from './job-position.entity';

export enum EmployeeDocumentType {
  DNI = 'dni',
  PASSPORT = 'passport',
  OTHER = 'other',
}

export enum EmployeeTerminationReason {
  RESIGNATION = 'resignation',
  DISMISSAL = 'dismissal',
  END_OF_CONTRACT = 'end_of_contract',
  RETIREMENT = 'retirement',
  OTHER = 'other',
}

export enum EmploymentType {
  PERMANENT = 'permanent',
  FIXED_TERM = 'fixed_term',
  PART_TIME = 'part_time',
  CONTRACTOR = 'contractor',
}

export enum EmployeeStatus {
  ACTIVE = 'active',
  TERMINATED = 'terminated',
}

/**
 * Legajo de un empleado (CU-177 a CU-182). Un chofer ES un empleado con cuenta
 * y perfil `delivery`; ayudantes, depósito y vendedores son legajos sin cuenta
 * (D1). Las fechas de calendario (`date`) viajan como `YYYY-MM-DD`.
 *
 * Los índices únicos parciales son los "vigentes": no cuentan los legajos dados
 * de baja por alta errónea (`deletedAt`). La salida normal es el egreso.
 */
// Los enums `employee_document_type_enum`, `employee_termination_reason_enum` y
// `employee_status_enum` llevan el nombre por defecto de TypeORM
// (`<tabla>_<columna>_enum`): NO se declara `enumName`. Con un `enumName`
// explícito igual al de por defecto, el esquema de la base (que no lo guarda
// aparte) no coincide con la entidad y `schema:log` quiere recrear el tipo.
@Check(
  'CHK_employee_nacimiento',
  `"birth_date" IS NULL OR "birth_date" < "hire_date"`,
)
@Check('CHK_employee_cuil', `"cuil" IS NULL OR es_cuil_valido("cuil")`)
@Check(
  'CHK_employee_email',
  `"personal_email" IS NULL OR "personal_email" ~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'`,
)
@Check('CHK_employee_cbu', `"bank_cbu" IS NULL OR "bank_cbu" ~ '^[0-9]{22}$'`)
@Unique('UQ_employee_id_distribuidora', ['employeeId', 'distributorId'])
@Entity('employee')
@Index('UQ_employee_user_vigente', ['userId'], {
  unique: true,
  where: '"user_id" IS NOT NULL AND "deletedAt" IS NULL',
})
@Index('UQ_employee_file_number_vigente', ['distributorId', 'fileNumber'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
@Index('UQ_employee_document_vigente', ['distributorId', 'documentNumber'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
@Index('UQ_employee_cuil_vigente', ['distributorId', 'cuil'], {
  unique: true,
  where: '"cuil" IS NOT NULL AND "deletedAt" IS NULL',
})
@Index('IDX_employee_status', ['distributorId', 'status'])
@Index('IDX_employee_name', ['distributorId', 'lastName', 'firstName'])
@Check(
  'CHK_employee_termination_date',
  '"termination_date" IS NULL OR "termination_date" >= "hire_date"',
)
@Check(
  'CHK_employee_status_termination',
  '("status" = \'terminated\') = ("termination_date" IS NOT NULL)',
)
export class Employee {
  @PrimaryGeneratedColumn('uuid', { name: 'employee_id' })
  employeeId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** Cuenta de acceso. Sin ella el empleado no entra al sistema. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user?: User | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Index('IDX_employee_position')
  @ManyToOne(() => JobPosition, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'position_id' })
  position?: JobPosition;

  @Column({ name: 'position_id', type: 'uuid' })
  positionId!: string;

  @Column({ name: 'file_number', type: 'varchar', length: 20 })
  fileNumber!: string;

  @Column({ name: 'first_name', type: 'varchar', length: 80 })
  firstName!: string;

  @Column({ name: 'last_name', type: 'varchar', length: 80 })
  lastName!: string;

  @Column({
    name: 'document_type',
    type: 'enum',
    enum: EmployeeDocumentType,
  })
  documentType!: EmployeeDocumentType;

  @Column({ name: 'document_number', type: 'varchar', length: 20 })
  documentNumber!: string;

  @Column({ name: 'cuil', type: 'varchar', length: 11, nullable: true })
  cuil!: string | null;

  @Column({ name: 'birth_date', type: 'date', nullable: true })
  birthDate!: string | null;

  @Column({
    name: 'address_line',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  addressLine!: string | null;

  @Column({ name: 'city', type: 'varchar', length: 80, nullable: true })
  city!: string | null;

  @Column({ name: 'province', type: 'varchar', length: 80, nullable: true })
  province!: string | null;

  @Column({ name: 'postal_code', type: 'varchar', length: 10, nullable: true })
  postalCode!: string | null;

  @Column({ name: 'phone', type: 'varchar', length: 30, nullable: true })
  phone!: string | null;

  @Column({
    name: 'personal_email',
    type: 'varchar',
    length: 120,
    nullable: true,
  })
  personalEmail!: string | null;

  @Column({
    name: 'emergency_contact_name',
    type: 'varchar',
    length: 120,
    nullable: true,
  })
  emergencyContactName!: string | null;

  @Column({
    name: 'emergency_contact_phone',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  emergencyContactPhone!: string | null;

  @Column({
    name: 'emergency_contact_relationship',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  emergencyContactRelationship!: string | null;

  @Column({ name: 'hire_date', type: 'date' })
  hireDate!: string;

  @Column({ name: 'termination_date', type: 'date', nullable: true })
  terminationDate!: string | null;

  @Column({
    name: 'termination_reason',
    type: 'enum',
    enum: EmployeeTerminationReason,
    nullable: true,
  })
  terminationReason!: EmployeeTerminationReason | null;

  @Column({
    name: 'employment_type',
    type: 'enum',
    enum: EmploymentType,
    enumName: 'employment_type_enum',
  })
  employmentType!: EmploymentType;

  @Column({
    name: 'status',
    type: 'enum',
    enum: EmployeeStatus,
    default: EmployeeStatus.ACTIVE,
  })
  status!: EmployeeStatus;

  @Column({ name: 'bank_cbu', type: 'varchar', length: 22, nullable: true })
  bankCbu!: string | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  /**
   * Key de la foto del legajo en el bucket
   * (`employees/{distribuidora}/{legajo}/{uuid}.{ext}`). Sólo la usa un legajo
   * SIN cuenta: con cuenta, la foto es la del usuario.
   */
  @Column({ name: 'photo_key', type: 'varchar', length: 512, nullable: true })
  photoKey!: string | null;

  /** URL firmada; la completa `EmployeePhotoService.firmar`. No es una columna. */
  photoSignedUrl?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /** Sólo para altas erróneas; la salida normal es el egreso. */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
