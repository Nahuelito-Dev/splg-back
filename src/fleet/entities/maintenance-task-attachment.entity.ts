import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';
import { MaintenanceTask } from './maintenance-task.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Adjunto de una tarea de flota: la foto o el PDF de la póliza, la VTV o la
 * licencia. Una tarea puede tener uno o más (p. ej. el frente y el dorso de
 * la licencia). El contenido vive en S3;
 * acá sólo la referencia (`storageKey`) y la metadata.
 * Casos: CU-136 a CU-139.
 */
@Entity('maintenance_task_attachment')
export class MaintenanceTaskAttachment {
  @PrimaryGeneratedColumn('uuid', { name: 'attachment_id' })
  attachmentId!: string;

  @ManyToOne(() => MaintenanceTask, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task!: MaintenanceTask;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId!: string;

  /** Redundante con `task.distributor_id`: evita un JOIN para acotar por tenant. */
  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** Clave del objeto dentro del bucket de S3. */
  @Column({ name: 'storage_key', type: 'varchar', length: 255 })
  storageKey!: string;

  @Column({ name: 'original_name', type: 'varchar', length: 255 })
  originalName!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 100 })
  mimeType!: string;

  @Column({ name: 'size_bytes', type: 'integer' })
  sizeBytes!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'uploaded_by_user_id' })
  uploadedBy!: User;

  @Column({ name: 'uploaded_by_user_id', type: 'uuid' })
  uploadedByUserId!: string;

  @CreateDateColumn({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt!: Date;

  /**
   * Baja lógica: el registro queda para histórico y el archivo NO se borra del
   * storage (queda de respaldo). Los listados y descargas no lo muestran.
   */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
