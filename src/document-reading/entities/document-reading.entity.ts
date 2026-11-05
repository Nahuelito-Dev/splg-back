import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  ForeignKey,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { Attachment } from '../../attachment/entities/attachment.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { CampoLeido } from '../../document-reader/document-reader.port';
import { TipoDeDocumento } from '../../document-reader/tipos-de-documento';

export type DocumentProposalAction =
  | 'pay_installment'
  | 'pay_fine'
  | 'update_policy'
  | 'register_purchase_invoice'
  | 'update_employee_document'
  | 'review';
export interface DocumentProposalDifference {
  field: string;
  expected: string | null;
  read: string | null;
  message: string;
}
export interface DocumentProposal {
  action: DocumentProposalAction;
  ownerType: string;
  ownerId: string;
  expected: Record<string, string | null>;
  read: Record<string, string | null>;
  differences: DocumentProposalDifference[];
  summary: string;
}

/**
 * Estado de la lectura de un documento (módulo M6). Los últimos cuatro los usa
 * la conciliación y la confirmación del administrador.
 */
export enum DocumentReadingStatus {
  /** Espera lectura. */
  PENDING = 'pending',
  /** Leído: datos extraídos. */
  READ = 'read',
  /** El servicio respondió que el documento no se lee (borroso, cortado). */
  UNREADABLE = 'unreadable',
  /** Mismo archivo que otro ya leído: se copian sus datos sin volver a leer. */
  DUPLICATE = 'duplicate',
  /** La lectura falló (servicio caído, sin respuesta): se puede reintentar. */
  FAILED = 'failed',
  /** Conciliado: hay una propuesta esperando al administrador. */
  PROPOSED = 'proposed',
  /** El administrador confirmó la propuesta tal cual. */
  CONFIRMED = 'confirmed',
  /** El administrador corrigió algún dato y confirmó. */
  CORRECTED = 'corrected',
  /** El administrador rechazó la propuesta. */
  REJECTED = 'rejected',
}

/** Estados en los que el documento ya se leyó (tiene fecha de lectura). */
export const ESTADOS_LEIDOS: readonly DocumentReadingStatus[] = [
  DocumentReadingStatus.READ,
  DocumentReadingStatus.UNREADABLE,
  DocumentReadingStatus.DUPLICATE,
  DocumentReadingStatus.PROPOSED,
  DocumentReadingStatus.CONFIRMED,
  DocumentReadingStatus.CORRECTED,
  DocumentReadingStatus.REJECTED,
];

const LEIDOS_SQL = ESTADOS_LEIDOS.map((e) => `'${e}'`).join(', ');

/**
 * Lo que el sistema leyó de un documento (módulo M6). Uno por adjunto: el
 * archivo sigue en S3 (`attachment`) y acá queda lo extraído, su confianza, el
 * estado y lo que costó. `file_sha256` detecta el mismo archivo subido dos veces.
 */
// Tenant cruzado: el adjunto y el original de un duplicado son de la MISMA
// distribuidora (la FK simple sólo garantiza que existan).
@ForeignKey(
  () => Attachment,
  ['attachment_id', 'distributor_id'],
  ['attachment_id', 'distributor_id'],
  {
    name: 'FK_document_reading_attachment_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => DocumentReading,
  ['duplicate_of_id', 'distributor_id'],
  ['reading_id', 'distributor_id'],
  {
    name: 'FK_document_reading_duplicate_of_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_document_reading_id_distribuidora', ['readingId', 'distributorId'])
@Check(
  'CHK_document_reading_duplicado',
  `("status" = 'duplicate') = ("duplicate_of_id" IS NOT NULL)`,
)
@Check(
  'CHK_document_reading_propuesta',
  `("status" = 'proposed') = ("proposal" IS NOT NULL AND "proposal_expires_at" IS NOT NULL)`,
)
@Check(
  'CHK_document_reading_leido',
  `("status" IN (${LEIDOS_SQL})) = ("read_at" IS NOT NULL)`,
)
@Check('CHK_document_reading_campos', `jsonb_typeof("fields") = 'array'`)
@Check('CHK_document_reading_avisos', `jsonb_typeof("warnings") = 'array'`)
@Check(
  'CHK_document_reading_consumo',
  `"input_tokens" >= 0 AND "output_tokens" >= 0 AND "cost_usd" >= 0 AND "attempts" >= 0`,
)
@Check('CHK_document_reading_huella', `"file_sha256" ~ '^[0-9a-f]{64}$'`)
@Index('UQ_document_reading_adjunto', ['attachmentId'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
@Index('IDX_document_reading_cola', ['distributorId', 'status', 'createdAt'])
@Index('IDX_document_reading_huella', ['distributorId', 'fileSha256'])
@Entity('document_reading')
export class DocumentReading {
  @PrimaryGeneratedColumn('uuid', { name: 'reading_id' })
  readingId!: string;

  @ManyToOne(() => Distributor, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => Attachment, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'attachment_id' })
  attachment?: Attachment;

  @Column({ name: 'attachment_id', type: 'uuid' })
  attachmentId!: string;

  @Column({ name: 'file_sha256', type: 'char', length: 64 })
  fileSha256!: string;

  @Column({
    name: 'expected_type',
    type: 'enum',
    enum: TipoDeDocumento,
    enumName: 'document_reading_type_enum',
    nullable: true,
  })
  expectedType!: TipoDeDocumento | null;

  @Column({
    name: 'detected_type',
    type: 'enum',
    enum: TipoDeDocumento,
    enumName: 'document_reading_type_enum',
    nullable: true,
  })
  detectedType!: TipoDeDocumento | null;

  @Column({
    type: 'enum',
    enum: DocumentReadingStatus,
    default: DocumentReadingStatus.PENDING,
  })
  status!: DocumentReadingStatus;

  @Column({ type: 'boolean', nullable: true })
  legible!: boolean | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  fields!: CampoLeido[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  warnings!: string[];

  @ManyToOne(() => DocumentReading, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'duplicate_of_id' })
  duplicateOf?: DocumentReading | null;

  @Column({ name: 'duplicate_of_id', type: 'uuid', nullable: true })
  duplicateOfId!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  model!: string | null;

  @Column({ name: 'input_tokens', type: 'integer', default: 0 })
  inputTokens!: number;

  @Column({ name: 'output_tokens', type: 'integer', default: 0 })
  outputTokens!: number;

  @Column({
    name: 'cost_usd',
    type: 'numeric',
    precision: 10,
    scale: 6,
    default: 0,
    transformer: { to: (v: number) => v, from: (v: string) => Number(v) },
  })
  costUsd!: number;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  proposal!: DocumentProposal | null;

  @Column({ name: 'proposal_expires_at', type: 'timestamptz', nullable: true })
  proposalExpiresAt!: Date | null;

  @Column({ name: 'reminded_at', type: 'timestamptz', nullable: true })
  remindedAt!: Date | null;

  @Column({ name: 'escalated_at', type: 'timestamptz', nullable: true })
  escalatedAt!: Date | null;

  /** Momento en que se intentó cruzar la lectura con su dueño. */
  @Column({ name: 'reconciled_at', type: 'timestamptz', nullable: true })
  reconciledAt!: Date | null;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt!: Date | null;
}
