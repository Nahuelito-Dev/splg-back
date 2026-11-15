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
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Message } from './message.entity';

/**
 * Historial de las ediciones de un mensaje (D-C22): cada vez que el autor
 * cambia el texto, el que tenía queda acá. Lo ve quien supervise (CH8) y lo
 * alcanza la retención como al mensaje (§10.4). En la auditoría por triggers
 * el texto va `[oculto]` (D-C11): queda quién editó, cuándo y qué mensaje.
 */
@Entity('message_edit')
@ForeignKey(
  () => Message,
  ['message_id', 'distributor_id'],
  ['message_id', 'distributor_id'],
  { name: 'FK_message_edit_message_distribuidora', onDelete: 'NO ACTION' },
)
@Index('IDX_message_edit_mensaje', ['messageId', 'editedAt'])
@Check(
  'CHK_message_edit_texto',
  `"previous_body" IS NULL OR char_length(btrim("previous_body")) BETWEEN 1 AND 2000`,
)
export class MessageEdit {
  @PrimaryGeneratedColumn('uuid', {
    name: 'edit_id',
    primaryKeyConstraintName: 'PK_message_edit',
  })
  editId!: string;

  @Column({ name: 'message_id', type: 'uuid' })
  messageId!: string;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** El texto antes de esta edición; nulo si la retención lo redactó. */
  @Column({ name: 'previous_body', type: 'text', nullable: true })
  previousBody!: string | null;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'edited_by_user_id',
    foreignKeyConstraintName: 'FK_message_edit_edited_by',
  })
  editedBy?: User;

  @Column({ name: 'edited_by_user_id', type: 'uuid' })
  editedByUserId!: string;

  @CreateDateColumn({ name: 'edited_at', type: 'timestamptz' })
  editedAt!: Date;
}
