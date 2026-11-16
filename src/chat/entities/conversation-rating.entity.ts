import {
  Check,
  Column,
  Entity,
  ForeignKey,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Conversation } from './conversation.entity';
import { Message } from './message.entity';

/**
 * La encuesta de satisfacción de un cierre de una conversación con un cliente
 * (4b): una por cierre (la pide el mensaje de sistema `csat_request`, único
 * por fila), respuesta única y hasta `expires_at` (48 h). `served_by` dice
 * quién la atendió (el equipo, el asistente con IA o nadie) para comparar el
 * CSAT del asistente con el del equipo (B4). Misma empresa que la
 * conversación y el mensaje (FK compuestas). El id lo genera el back (va en
 * el `payload` del mensaje antes de insertar la fila). Si la conversación se
 * reabre antes de que la respondan, se anula (`cancelled_at`).
 */
@Entity('conversation_rating')
@ForeignKey(
  () => Conversation,
  ['conversation_id', 'distributor_id'],
  ['conversation_id', 'distributor_id'],
  {
    name: 'FK_conversation_rating_conversation_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Message,
  ['request_message_id', 'distributor_id'],
  ['message_id', 'distributor_id'],
  {
    name: 'FK_conversation_rating_request_message_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_conversation_rating_pedido', ['requestMessageId'])
@Index('IDX_conversation_rating_conversacion', [
  'conversationId',
  'requestedAt',
])
@Index('IDX_conversation_rating_empresa', ['distributorId', 'requestedAt'])
@Check(
  'CHK_conversation_rating_puntaje',
  `"score" IS NULL OR "score" BETWEEN 1 AND 5`,
)
@Check(
  'CHK_conversation_rating_respuesta',
  `("score" IS NULL) = ("answered_at" IS NULL) AND ("comment" IS NULL OR "score" IS NOT NULL)`,
)
@Check(
  'CHK_conversation_rating_comentario',
  `"comment" IS NULL OR char_length(btrim("comment")) BETWEEN 1 AND 280`,
)
@Check(
  'CHK_conversation_rating_plazo',
  `"expires_at" > "requested_at" AND ("answered_at" IS NULL OR "answered_at" <= "expires_at")`,
)
@Check(
  'CHK_conversation_rating_anulada',
  `"cancelled_at" IS NULL OR ("answered_at" IS NULL AND "cancelled_at" >= "requested_at")`,
)
@Check(
  'CHK_conversation_rating_atendio',
  `"served_by" IN ('assistant', 'team', 'none')`,
)
export class ConversationRating {
  @PrimaryColumn({
    name: 'rating_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_conversation_rating',
  })
  ratingId!: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'request_message_id', type: 'uuid' })
  requestMessageId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'customer_user_id',
    foreignKeyConstraintName: 'FK_conversation_rating_customer',
  })
  customer?: User;

  /** El cliente de la conversación: el único que la responde. */
  @Column({ name: 'customer_user_id', type: 'uuid' })
  customerUserId!: string;

  @Column({ name: 'served_by', type: 'varchar', length: 10 })
  servedBy!: 'assistant' | 'team' | 'none';

  @Column({ type: 'smallint', nullable: true })
  score!: number | null;

  @Column({ type: 'varchar', length: 280, nullable: true })
  comment!: string | null;

  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'answered_at', type: 'timestamptz', nullable: true })
  answeredAt!: Date | null;

  /**
   * Se anuló porque la conversación se reabrió antes de que la respondieran:
   * ese cierre ya no se califica ni cuenta como vencida.
   */
  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;
}
