import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { ImportJobStatus, ImportResource } from '../domain/import.enums';
import {
  ErrorDeFila,
  FilaNormalizada,
  ResumenDeImportacion,
} from '../domain/import.types';

/**
 * Vista previa de una importación masiva: las filas ya validadas y normalizadas
 * esperan acá hasta que se confirman (o vencen, a las 24 h). No es negocio:
 * hasta confirmar no se escribió nada en el catálogo, el stock ni los proveedores.
 */
@Check(
  'CHK_import_job_confirmado',
  `("status" = 'confirmed') = ("confirmed_at" IS NOT NULL)`,
)
@Check(
  'CHK_import_job_cuentas',
  `"total" >= 0 AND "valid_rows" >= 0 AND "error_count" >= 0`,
)
@Index('IDX_import_job_distribuidora', ['distributorId', 'createdAt'])
@Entity('import_job')
export class ImportJob {
  @PrimaryGeneratedColumn('uuid', { name: 'import_id' })
  importId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  @Column({ type: 'enum', enum: ImportResource })
  resource!: ImportResource;

  @Column({ type: 'enum', enum: ImportJobStatus })
  status!: ImportJobStatus;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName!: string;

  @Column({ type: 'int' })
  total!: number;

  @Column({ name: 'valid_rows', type: 'int' })
  validRows!: number;

  @Column({ name: 'error_count', type: 'int' })
  errorCount!: number;

  /** Las filas válidas, normalizadas, listas para aplicar. */
  @Column({ type: 'jsonb' })
  rows!: FilaNormalizada[];

  @Column({ type: 'jsonb' })
  errors!: ErrorDeFila[];

  /** Lo que se aplicó al confirmar; `null` mientras no se confirmó. */
  @Column({ type: 'jsonb', nullable: true })
  summary!: ResumenDeImportacion | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
