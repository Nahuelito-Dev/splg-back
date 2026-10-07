import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

/** La categoría manda las reglas del puesto (rol de acceso, documentación); el nombre es libre. */
export enum JobPositionCategory {
  DRIVER = 'driver',
  HELPER = 'helper',
  WAREHOUSE = 'warehouse',
  ADMINISTRATION = 'administration',
  SALES = 'sales',
  MANAGEMENT = 'management',
  OTHER = 'other',
}

/**
 * Puesto de trabajo de una distribuidora (CU-176). Único por nombre, sin
 * distinguir mayúsculas, entre los vigentes: índice funcional creado en la
 * migración `CrearPersonal` (TypeORM no modela expresiones; `synchronize: false`
 * evita que `migration:generate` quiera borrarlo, igual que `IDX_user_email_lower`).
 */
// `category` usa el nombre de enum por defecto (`job_position_category_enum`): no
// se declara `enumName` (ver la nota en `employee.entity.ts`).
@Index('UQ_job_position_name_vigente', { synchronize: false })
@Entity('job_position')
export class JobPosition {
  @PrimaryGeneratedColumn('uuid', { name: 'position_id' })
  positionId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'name', type: 'varchar', length: 80 })
  name!: string;

  @Column({
    name: 'category',
    type: 'enum',
    enum: JobPositionCategory,
  })
  category!: JobPositionCategory;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
