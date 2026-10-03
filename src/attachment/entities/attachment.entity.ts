import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

/** Qué módulo es dueño del adjunto. Cada valor lo valida el resolver de su módulo. */
export enum AttachmentOwnerType {
  EMPLOYEE = 'employee',
  FUEL_LOAD = 'fuel_load',
  TRAFFIC_FINE = 'traffic_fine',
  VEHICLE_ACCIDENT = 'vehicle_accident',
  PURCHASE_RECEIPT = 'purchase_receipt',
  STOCK_ADJUSTMENT = 'stock_adjustment',
  DRIVER_SETTLEMENT = 'driver_settlement',
  CASH_MOVEMENT = 'cash_movement',
  CUSTOMER_ACCOUNT_ENTRY = 'customer_account_entry',
}

/**
 * Adjunto genérico (legajo, combustible, multas, siniestros, remitos,
 * rendiciones...). El contenido vive en el `StoragePort`; acá la referencia y
 * la metadata. `ownerType` + `ownerId` apuntan al dueño sin FK, a propósito:
 * la tabla es polimórfica y no puede referenciar a la vez nueve tablas. La
 * existencia del dueño y su distribuidora los valida el
 * `AttachmentOwnerResolver` del módulo dueño al subir y al listar.
 */
@Entity('attachment')
@Index(['distributorId', 'ownerType', 'ownerId'])
export class Attachment {
  @PrimaryGeneratedColumn('uuid', { name: 'attachment_id' })
  attachmentId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({
    name: 'owner_type',
    type: 'enum',
    enum: AttachmentOwnerType,
  })
  ownerType!: AttachmentOwnerType;

  /** Sin FK (ver la nota de la clase). */
  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  /** Texto libre para distinguir adjuntos del mismo dueño: "DNI frente", "Póliza 2026". */
  @Column({ name: 'label', type: 'varchar', length: 80, nullable: true })
  label!: string | null;

  /** Clave dentro del `StoragePort` activo (disco local o S3). */
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
}
