import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { ConversationLabel } from './conversation-label.entity';

/**
 * Una etiqueta puesta en una conversación de la bandeja (tanda 7c). La
 * etiqueta y la conversación son de la misma empresa (FK compuestas con
 * `distributor_id`). Sacarla es baja lógica (queda quién y cuándo en la
 * auditoría). Una vigente por etiqueta y conversación, y hasta 5 vigentes por
 * conversación (trigger `TRG_conversation_label_link`, que además exige que la
 * etiqueta esté vigente y la conversación sea de la bandeja).
 */
@Entity('conversation_label_link')
@ForeignKey(
  () => Conversation,
  ['conversation_id', 'distributor_id'],
  ['conversation_id', 'distributor_id'],
  {
    name: 'FK_conversation_label_link_conversation_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => ConversationLabel,
  ['label_id', 'distributor_id'],
  ['label_id', 'distributor_id'],
  {
    name: 'FK_conversation_label_link_label_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Index('UQ_conversation_label_link_vigente', ['conversationId', 'labelId'], {
  unique: true,
  where: `"deleted_at" IS NULL`,
})
// El filtro de la bandeja y el corte por etiqueta de las métricas.
@Index('IDX_conversation_label_link_etiqueta', ['labelId', 'conversationId'], {
  where: `"deleted_at" IS NULL`,
})
export class ConversationLabelLink {
  @PrimaryGeneratedColumn('uuid', {
    name: 'link_id',
    primaryKeyConstraintName: 'PK_conversation_label_link',
  })
  linkId!: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  @Column({ name: 'label_id', type: 'uuid' })
  labelId!: string;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
