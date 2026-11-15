import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  SubjectType,
} from '../domain/chat.enums';

/**
 * Una conversación (diseño §6.2). Siempre de una distribuidora, también la de
 * la plataforma (es *con* esa empresa). En CH1 hay dos canales: el chat con la
 * plataforma (`platform_chat`, uno abierto por empresa) y el hilo de cada
 * ticket (`platform_ticket`).
 *
 * `last_message_seq` es el contador de la conversación: el envío lo incrementa
 * con la fila bloqueada, así dos envíos simultáneos reciben números seguidos y
 * sin huecos (§7.4). Los tres `last_message_*` no se auditan (cambian con cada
 * mensaje, que ya tiene su propio asiento).
 *
 * Lo que crea `sql/mensajeria.ts` (TypeORM no lo modela; `synchronize: false`):
 * el único parcial del chat abierto por empresa y el trigger diferido que
 * controla las partes.
 */
@Entity('conversation')
@Unique('UQ_conversation_id_distribuidora', ['conversationId', 'distributorId'])
@Index('UQ_conversation_general_abierta', { synchronize: false })
@Index('IDX_conversation_bandeja', [
  'distributorId',
  'channel',
  'status',
  'lastMessageAt',
])
@Index('IDX_conversation_cola', ['distributorId', 'assignedToUserId'], {
  where: `"status" = 'open'`,
})
@Check(
  'CHK_conversation_canal',
  `"channel" IN ('platform_chat', 'platform_ticket')`,
)
@Check(
  'CHK_conversation_ambito',
  `("channel" = 'platform_ticket') = ("subject_type" = 'ticket') AND "subject_type" IN ('general', 'ticket')`,
)
@Check('CHK_conversation_estado', `"status" IN ('open', 'closed')`)
@Check(
  'CHK_conversation_cierre',
  `("status" = 'closed') = ("closed_at" IS NOT NULL AND "closed_reason" IS NOT NULL)`,
)
@Check(
  'CHK_conversation_motivo_de_cierre',
  `"closed_reason" IS NULL OR "closed_reason" IN ('manual', 'inactivity', 'ticket_closed')`,
)
@Check(
  'CHK_conversation_asunto',
  `("channel" = 'platform_ticket') = ("subject" IS NOT NULL) AND ("subject" IS NULL OR char_length(btrim("subject")) BETWEEN 5 AND 120)`,
)
@Check(
  'CHK_conversation_asignado',
  `"assigned_to_user_id" IS NULL OR "channel" = 'platform_chat'`,
)
@Check('CHK_conversation_secuencia', `"last_message_seq" >= 0`)
export class Conversation {
  @PrimaryGeneratedColumn('uuid', {
    name: 'conversation_id',
    primaryKeyConstraintName: 'PK_conversation',
  })
  conversationId!: string;

  // RESTRICT: la baja de una empresa es lógica; sus conversaciones quedan.
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_conversation_distributor',
  })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: Channel;

  @Column({ name: 'subject_type', type: 'varchar', length: 10 })
  subjectType!: SubjectType;

  @Column({ type: 'varchar', length: 10, default: ConversationStatus.OPEN })
  status!: ConversationStatus;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'assigned_to_user_id',
    foreignKeyConstraintName: 'FK_conversation_assigned_to',
  })
  assignedTo?: User | null;

  /** Quién de la plataforma está atendiendo el chat (sólo `platform_chat`). */
  @Column({ name: 'assigned_to_user_id', type: 'uuid', nullable: true })
  assignedToUserId!: string | null;

  /** Asunto del ticket, copiado en su hilo; nulo en el chat. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  subject!: string | null;

  @Column({
    name: 'last_message_seq',
    type: 'bigint',
    default: 0,
    transformer: columnNumericTransformer,
  })
  lastMessageSeq!: number;

  @Column({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt!: Date | null;

  /** Ya filtrada y nunca de una nota interna. */
  @Column({
    name: 'last_message_preview',
    type: 'varchar',
    length: 140,
    nullable: true,
  })
  lastMessagePreview!: string | null;

  /** Primer mensaje de la plataforma (métrica de espera). */
  @Column({ name: 'first_response_at', type: 'timestamptz', nullable: true })
  firstResponseAt!: Date | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'closed_by_user_id',
    foreignKeyConstraintName: 'FK_conversation_closed_by',
  })
  closedBy?: User | null;

  @Column({ name: 'closed_by_user_id', type: 'uuid', nullable: true })
  closedByUserId!: string | null;

  @Column({
    name: 'closed_reason',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  closedReason!: ConversationClosedReason | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'FK_conversation_created_by',
  })
  createdBy?: User | null;

  /** Nulo: la abrió el sistema. */
  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  /** Baja lógica: sólo por retención o moderación (§10). */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
