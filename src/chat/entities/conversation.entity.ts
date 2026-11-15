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
import { Claim } from '../../claims/entities/claim.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Order } from '../../order/entities/order.entity';
import { User } from '../../users/entities/user.entity';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  SubjectType,
} from '../domain/chat.enums';

/**
 * Una conversación (diseño §6.2). Siempre de una distribuidora, también la de
 * la plataforma (es *con* esa empresa). Canales: el chat con la plataforma
 * (`platform_chat`, uno abierto por empresa), el hilo de cada ticket
 * (`platform_ticket`) y la bandeja de la empresa (CH3): con un cliente
 * (`staff_customer`, C3) o con un chofer (`staff_driver`, C2), general (una
 * abierta por persona) o por pedido (una abierta por pedido, canal y chofer:
 * si el pedido pasa a otro chofer, el nuevo tiene la suya y la del anterior se
 * cierra con `driver_changed`).
 *
 * `last_message_seq` es el contador de la conversación: el envío lo incrementa
 * con la fila bloqueada, así dos envíos simultáneos reciben números seguidos y
 * sin huecos (§7.4). Los tres `last_message_*` no se auditan (cambian con cada
 * mensaje, que ya tiene su propio asiento).
 *
 * Lo que crean `sql/mensajeria.ts` y `sql/bandeja-de-la-empresa.ts` (TypeORM
 * no lo modela; `synchronize: false`): los únicos parciales de la general
 * abierta y de la del pedido, el trigger diferido que controla las partes y el
 * que controla que el chofer, el cliente y quien atiende sean de la empresa.
 */
@Entity('conversation')
@Unique('UQ_conversation_id_distribuidora', ['conversationId', 'distributorId'])
@ForeignKey(
  () => Order,
  ['order_id', 'distributor_id'],
  ['order_id', 'distributor_id'],
  { name: 'FK_conversation_order_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => Claim,
  ['linked_claim_id', 'distributor_id'],
  ['claim_id', 'distributor_id'],
  {
    name: 'FK_conversation_linked_claim_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Index('UQ_conversation_general_abierta', { synchronize: false })
@Index('UQ_conversation_pedido_abierta', { synchronize: false })
@Index('IDX_conversation_bandeja', [
  'distributorId',
  'channel',
  'status',
  'lastMessageAt',
])
@Index('IDX_conversation_cola', ['distributorId', 'assignedToUserId'], {
  where: `"status" = 'open'`,
})
@Index('IDX_conversation_del_cliente', [
  'customerUserId',
  'distributorId',
  'lastMessageAt',
])
@Index('IDX_conversation_del_chofer', [
  'driverUserId',
  'distributorId',
  'lastMessageAt',
])
@Check(
  'CHK_conversation_canal',
  `"channel" IN ('platform_chat', 'platform_ticket', 'staff_customer', 'staff_driver')`,
)
@Check(
  'CHK_conversation_ambito',
  `("channel" = 'platform_ticket') = ("subject_type" = 'ticket') AND "subject_type" IN ('general', 'ticket', 'order') AND ("subject_type" <> 'order' OR "channel" IN ('staff_customer', 'staff_driver'))`,
)
@Check(
  'CHK_conversation_pedido',
  `("subject_type" = 'order') = ("order_id" IS NOT NULL)`,
)
@Check(
  'CHK_conversation_personas',
  `("channel" = 'staff_customer') = ("customer_user_id" IS NOT NULL) AND ("channel" = 'staff_driver') = ("driver_user_id" IS NOT NULL)`,
)
@Check(
  'CHK_conversation_reclamo',
  `"linked_claim_id" IS NULL OR "channel" = 'staff_customer'`,
)
@Check('CHK_conversation_estado', `"status" IN ('open', 'closed')`)
@Check(
  'CHK_conversation_cierre',
  `("status" = 'closed') = ("closed_at" IS NOT NULL AND "closed_reason" IS NOT NULL)`,
)
@Check(
  'CHK_conversation_motivo_de_cierre',
  `"closed_reason" IS NULL OR "closed_reason" IN ('manual', 'inactivity', 'ticket_closed', 'driver_changed')`,
)
@Check(
  'CHK_conversation_asunto',
  `("channel" = 'platform_ticket') = ("subject" IS NOT NULL) AND ("subject" IS NULL OR char_length(btrim("subject")) BETWEEN 5 AND 120)`,
)
@Check(
  'CHK_conversation_asignado',
  `"assigned_to_user_id" IS NULL OR "channel" IN ('platform_chat', 'staff_customer', 'staff_driver')`,
)
@Check('CHK_conversation_secuencia', `"last_message_seq" >= 0`)
@Check(
  'CHK_conversation_esperando_persona',
  `"awaiting_human_since" IS NULL OR "channel" IN ('platform_chat', 'staff_customer')`,
)
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

  /**
   * Quién atiende: en el chat con la plataforma, alguien de la plataforma; en
   * la bandeja, alguien del personal de ESA empresa con el permiso del canal
   * (trigger `TRG_conversation_personas`). Nulo: en la cola, sin asignar.
   */
  @Column({ name: 'assigned_to_user_id', type: 'uuid', nullable: true })
  assignedToUserId!: string | null;

  /** El pedido de una conversación por pedido (misma empresa: FK compuesta). */
  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'customer_user_id',
    foreignKeyConstraintName: 'FK_conversation_customer',
  })
  customerUser?: User | null;

  /** El cliente (sólo C3). */
  @Column({ name: 'customer_user_id', type: 'uuid', nullable: true })
  customerUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'driver_user_id',
    foreignKeyConstraintName: 'FK_conversation_driver',
  })
  driverUser?: User | null;

  /** El chofer (sólo C2). */
  @Column({ name: 'driver_user_id', type: 'uuid', nullable: true })
  driverUserId!: string | null;

  /** El reclamo creado desde el hilo (sólo C3; misma empresa: FK compuesta). */
  @Column({ name: 'linked_claim_id', type: 'uuid', nullable: true })
  linkedClaimId!: string | null;

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

  /**
   * Primera respuesta de quien atiende: en el chat con la plataforma, el primer
   * mensaje de la plataforma; en la bandeja, el primero de la empresa después
   * del primero del cliente o del chofer (métrica de espera, §16).
   */
  @Column({ name: 'first_response_at', type: 'timestamptz', nullable: true })
  firstResponseAt!: Date | null;

  /**
   * El asistente con IA la pasó a una persona (DISENO-CH-BOT §4.1.4): desde
   * cuándo espera que alguien del equipo la tome. Mientras tanto el asistente
   * no vuelve a contestar. Se limpia cuando alguien la toma. Sólo C3 y C1.
   */
  @Column({ name: 'awaiting_human_since', type: 'timestamptz', nullable: true })
  awaitingHumanSince!: Date | null;

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
