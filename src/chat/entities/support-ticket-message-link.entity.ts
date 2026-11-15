import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Message } from './message.entity';
import { SupportTicket } from './support-ticket.entity';

/**
 * Qué mensajes del chat quedaron citados en qué ticket (diseño §6.7): la
 * etiqueta «→ T-000123» en el chat y el «Ver en el chat» del ticket. Las tres
 * claves foráneas son compuestas con la distribuidora: un mensaje de otra
 * empresa no se puede citar.
 */
@Entity('support_ticket_message_link')
@ForeignKey(
  () => SupportTicket,
  ['ticket_id', 'distributor_id'],
  ['ticket_id', 'distributor_id'],
  {
    name: 'FK_support_ticket_message_link_ticket_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Message,
  ['message_id', 'distributor_id'],
  ['message_id', 'distributor_id'],
  {
    name: 'FK_support_ticket_message_link_message_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Message,
  ['quoted_in_message_id', 'distributor_id'],
  ['message_id', 'distributor_id'],
  {
    name: 'FK_support_ticket_message_link_quoted_in_message_distribuidora',
    onDelete: 'NO ACTION',
  },
)
export class SupportTicketMessageLink {
  @PrimaryColumn({
    name: 'ticket_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_support_ticket_message_link',
  })
  ticketId!: string;

  @PrimaryColumn({
    name: 'message_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_support_ticket_message_link',
  })
  messageId!: string;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** La cita del hilo del ticket que copió el mensaje. */
  @Column({ name: 'quoted_in_message_id', type: 'uuid' })
  quotedInMessageId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'FK_support_ticket_message_link_created_by',
  })
  createdBy?: User | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;
}
