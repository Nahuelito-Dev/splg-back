import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
} from 'typeorm';
import { Cylinder } from './cylinder.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

export enum CylinderInspectionResult {
  APPROVED = 'approved',
  CONDITIONAL = 'conditional',
  REJECTED = 'rejected',
}

/**
 * Revisión de envase
 * Una fila por revisión técnica del envase.
 * Casos: CU-132 a CU-135
 */
@Check(
  'CHK_cylinder_inspection_vencimiento',
  `"next_due_at" IS NULL OR "next_due_at" > "inspected_at"`,
)
@Check(
  'CHK_cylinder_inspection_proxima',
  `"result" = 'rejected' OR "next_due_at" IS NOT NULL`,
)
@Entity('cylinder_inspection')
export class CylinderInspection {
  @PrimaryGeneratedColumn('uuid', { name: 'inspection_id' })
  inspectionId!: string;

  @Index()
  @ManyToOne(() => Cylinder, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cylinder_id' })
  cylinder!: Cylinder;

  @Column({ name: 'cylinder_id', type: 'uuid' })
  cylinderId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({
    name: 'inspected_at',
    type: 'timestamptz',
    nullable: false,
    default: () => 'now()',
  })
  inspectedAt!: Date;

  @Column({
    name: 'result',
    type: 'enum',
    enum: CylinderInspectionResult,

    nullable: false,
  })
  result!: CylinderInspectionResult;

  @Column({ name: 'next_due_at', type: 'timestamptz', nullable: true })
  nextDueAt!: Date | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;
}
