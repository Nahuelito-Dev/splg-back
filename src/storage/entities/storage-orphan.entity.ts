import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Por qué la key está anotada. */
export enum StorageOrphanKind {
  /** La referencia ya se borró o reemplazó: hay que borrar el objeto. */
  REMOVE = 'remove',
  /** Se reservó antes de subir; si nadie la confirmó, la subida quedó a medias. */
  UPLOAD = 'upload',
}

export enum StorageOrphanStatus {
  PENDING = 'pending',
  /** Se agotaron los intentos: hay que mirarla a mano. */
  FAILED = 'failed',
}

/**
 * Intención de borrar un objeto del storage, registrada ANTES de la operación
 * que puede dejarlo sin dueño (ver `StorageCleanupService`). El cron la sigue
 * reintentando con backoff hasta que el borrado sale.
 */
@Entity('storage_orphan')
export class StorageOrphan {
  @PrimaryGeneratedColumn('uuid', { name: 'orphan_id' })
  orphanId!: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 512, unique: true })
  storageKey!: string;

  @Column({ type: 'varchar', length: 10, default: StorageOrphanKind.REMOVE })
  kind!: StorageOrphanKind;

  @Column({
    type: 'varchar',
    length: 10,
    default: StorageOrphanStatus.PENDING,
  })
  status!: StorageOrphanStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  /** Desde cuándo el cron puede (re)intentar el borrado. */
  @Column({
    name: 'next_attempt_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  nextAttemptAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
