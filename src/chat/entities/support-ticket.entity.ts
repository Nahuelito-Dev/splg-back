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
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import {
  Party,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '../domain/chat.enums';
import { Conversation } from './conversation.entity';

/**
 * Ticket de soporte entre la plataforma y una empresa (diseño §6.7). Tiene su
 * propio estado (máquina `support-ticket.machine.ts`, copiada en un trigger de
 * la base) y su propio hilo: una conversación `platform_ticket`. Puede haber
 * salido del chat (`origin_conversation_id` y el rango citado).
 *
 * `number` sale de la secuencia `support_ticket_number_seq` (global de la
 * plataforma) y se muestra `T-000123`. `status_changed_at` es el reloj del
 * cierre automático (7 días esperando a la empresa o resuelto).
 */
@Entity('support_ticket')
@ForeignKey(
  () => Conversation,
  ['conversation_id', 'distributor_id'],
  ['conversation_id', 'distributor_id'],
  {
    name: 'FK_support_ticket_conversation_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Conversation,
  ['origin_conversation_id', 'distributor_id'],
  ['conversation_id', 'distributor_id'],
  {
    name: 'FK_support_ticket_origin_conversation_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_support_ticket_id_distribuidora', ['ticketId', 'distributorId'])
@Unique('UQ_support_ticket_conversation', ['conversationId'])
@Unique('UQ_support_ticket_number', ['number'])
@Index('IDX_support_ticket_cola', ['status', 'priority', 'firstResponseDueAt'])
@Index('IDX_support_ticket_empresa', ['distributorId', 'status', 'updatedAt'])
@Index('IDX_support_ticket_origen', ['originConversationId'])
@Check(
  'CHK_support_ticket_asunto',
  `char_length(btrim("subject")) BETWEEN 5 AND 120`,
)
@Check(
  'CHK_support_ticket_categoria',
  `"category" IN ('billing', 'technical', 'module', 'data', 'account', 'other')`,
)
@Check(
  'CHK_support_ticket_prioridad',
  `"priority" IN ('low', 'normal', 'high', 'urgent')`,
)
@Check(
  'CHK_support_ticket_estado',
  `"status" IN ('new', 'open', 'waiting_company', 'resolved', 'closed')`,
)
@Check(
  'CHK_support_ticket_quien_abre',
  `"opened_by_party" IN ('company', 'platform')`,
)
@Check(
  'CHK_support_ticket_rango',
  `("origin_conversation_id" IS NULL AND "origin_from_seq" IS NULL AND "origin_to_seq" IS NULL) OR ("origin_conversation_id" IS NOT NULL AND "origin_from_seq" >= 1 AND "origin_from_seq" <= "origin_to_seq" AND "origin_to_seq" - "origin_from_seq" < 200)`,
)
@Check('CHK_support_ticket_numero', `"number" >= 1`)
@Check(
  'CHK_support_ticket_resuelto',
  `"status" <> 'resolved' OR "resolved_at" IS NOT NULL`,
)
@Check(
  'CHK_support_ticket_cerrado',
  `("status" = 'closed') = ("closed_at" IS NOT NULL)`,
)
@Check(
  'CHK_support_ticket_satisfaccion',
  `"satisfaction" IS NULL OR ("satisfaction" BETWEEN 1 AND 5 AND "status" IN ('resolved', 'closed'))`,
)
export class SupportTicket {
  @PrimaryGeneratedColumn('uuid', {
    name: 'ticket_id',
    primaryKeyConstraintName: 'PK_support_ticket',
  })
  ticketId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_support_ticket_distributor',
  })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** El hilo propio (`platform_ticket`). */
  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  /** El chat del que salió, si salió de uno. */
  @Column({ name: 'origin_conversation_id', type: 'uuid', nullable: true })
  originConversationId!: string | null;

  @Column({
    name: 'origin_from_seq',
    type: 'bigint',
    nullable: true,
    transformer: columnNumericTransformer,
  })
  originFromSeq!: number | null;

  @Column({
    name: 'origin_to_seq',
    type: 'bigint',
    nullable: true,
    transformer: columnNumericTransformer,
  })
  originToSeq!: number | null;

  @Column({ type: 'integer' })
  number!: number;

  @Column({ type: 'varchar', length: 120 })
  subject!: string;

  @Column({ type: 'varchar', length: 20 })
  category!: TicketCategory;

  @Column({ type: 'varchar', length: 10 })
  priority!: TicketPriority;

  @Column({ type: 'varchar', length: 20 })
  status!: TicketStatus;

  @Column({
    name: 'status_changed_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  statusChangedAt!: Date;

  @Column({ name: 'opened_by_party', type: 'varchar', length: 10 })
  openedByParty!: Party.COMPANY | Party.PLATFORM;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'opened_by_user_id',
    foreignKeyConstraintName: 'FK_support_ticket_opened_by',
  })
  openedBy?: User;

  @Column({ name: 'opened_by_user_id', type: 'uuid' })
  openedByUserId!: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'assigned_member_user_id',
    foreignKeyConstraintName: 'FK_support_ticket_assigned_member',
  })
  assignedMember?: User | null;

  /** Quién de la plataforma lo atiende (lo valida el back: la base no conoce roles). */
  @Column({ name: 'assigned_member_user_id', type: 'uuid', nullable: true })
  assignedMemberUserId!: string | null;

  @Column({
    name: 'first_response_due_at',
    type: 'timestamptz',
    nullable: true,
  })
  firstResponseDueAt!: Date | null;

  @Column({ name: 'first_response_at', type: 'timestamptz', nullable: true })
  firstResponseAt!: Date | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ type: 'smallint', nullable: true })
  satisfaction!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  /** Baja lógica: sólo por retención. */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
