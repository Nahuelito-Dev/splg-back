import {
  Column,
  Entity,
  ForeignKey,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { User } from '../../users/entities/user.entity';
import { Conversation } from './conversation.entity';

/**
 * Lectura **por persona** del personal y de la plataforma (diseño §6.4): lo que
 * lee un operador no queda leído para otro. No se audita (como la lectura de
 * los avisos): figura en las tablas excluidas.
 */
@Entity('conversation_read_state')
@ForeignKey(
  () => Conversation,
  ['conversation_id', 'distributor_id'],
  ['conversation_id', 'distributor_id'],
  {
    name: 'FK_conversation_read_state_conversation_distribuidora',
    onDelete: 'NO ACTION',
  },
)
export class ConversationReadState {
  @PrimaryColumn({
    name: 'conversation_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_conversation_read_state',
  })
  conversationId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_conversation_read_state_user',
  })
  user?: User;

  @PrimaryColumn({
    name: 'user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_conversation_read_state',
  })
  userId!: string;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({
    name: 'last_read_seq',
    type: 'bigint',
    default: 0,
    transformer: columnNumericTransformer,
  })
  lastReadSeq!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
