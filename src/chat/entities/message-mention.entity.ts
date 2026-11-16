import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Conversation } from './conversation.entity';
import { Message } from './message.entity';

/**
 * Una mención con @ en una nota interna de la bandeja (4a): a quién se
 * mencionó, en qué nota y si ya la vio («Me mencionaron», con su marca de
 * leído). Siempre de la misma empresa que la nota y la conversación (FK
 * compuestas) y de alguien de su personal (trigger `TRG_message_mention`, que
 * además exige que la nota sea una nota interna del personal en la bandeja).
 * Que atienda el canal lo controla el servicio (el permiso es del rol y puede
 * cambiar después).
 */
@Entity('message_mention')
@ForeignKey(
  () => Message,
  ['message_id', 'distributor_id'],
  ['message_id', 'distributor_id'],
  { name: 'FK_message_mention_message_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => Conversation,
  ['conversation_id', 'distributor_id'],
  ['conversation_id', 'distributor_id'],
  {
    name: 'FK_message_mention_conversation_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_message_mention_persona', ['messageId', 'mentionedUserId'])
@Index('IDX_message_mention_de_la_persona', [
  'mentionedUserId',
  'distributorId',
  'readAt',
])
@Index('IDX_message_mention_conversacion', ['conversationId'])
@Check(
  'CHK_message_mention_lectura',
  `"read_at" IS NULL OR "read_at" >= "created_at"`,
)
export class MessageMention {
  @PrimaryGeneratedColumn('uuid', {
    name: 'mention_id',
    primaryKeyConstraintName: 'PK_message_mention',
  })
  mentionId!: string;

  @Column({ name: 'message_id', type: 'uuid' })
  messageId!: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'mentioned_user_id',
    foreignKeyConstraintName: 'FK_message_mention_mentioned',
  })
  mentioned?: User;

  @Column({ name: 'mentioned_user_id', type: 'uuid' })
  mentionedUserId!: string;

  /** Cuándo la vio quien fue mencionado; nulo: sin leer. */
  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
