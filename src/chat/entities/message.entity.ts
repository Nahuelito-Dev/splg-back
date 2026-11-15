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
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { User } from '../../users/entities/user.entity';
import type { PayloadDeCita } from '../domain/cita';
import {
  MessageKind,
  MessageVisibility,
  Party,
  SystemCode,
} from '../domain/chat.enums';
import { Conversation } from './conversation.entity';

/** Lo que lleva `payload` según el tipo de mensaje. */
export type PayloadDelMensaje =
  | PayloadDeCita
  | { ticketId: string; number: string; subject: string }
  | { ticketId: string; number: string; from: string; to: string }
  | { userId: string | null }
  | Record<string, never>;

/**
 * Un mensaje (diseño §6.5). `seq` lo asigna el envío con la conversación
 * bloqueada: único por conversación y sin huecos. `client_message_id` hace el
 * envío idempotente: el mismo id del mismo autor en la misma conversación es
 * el mismo mensaje.
 *
 * Inmutable (trigger `message_inmutable` de `sql/mensajeria.ts`): sólo se
 * puede redactar (texto a nulo, `redacted_at`) y dar de baja (`deleted_at`).
 * No hay edición ni borrado físico. El texto y la cita van `[oculto]` en la
 * auditoría (D-C11: la auditoría es inmutable y no se podría cumplir la
 * retención).
 */
@Entity('message')
@ForeignKey(
  () => Conversation,
  ['conversation_id', 'distributor_id'],
  ['conversation_id', 'distributor_id'],
  { name: 'FK_message_conversation_distribuidora', onDelete: 'NO ACTION' },
)
@Unique('UQ_message_id_distribuidora', ['messageId', 'distributorId'])
@Unique('UQ_message_conversation_seq', ['conversationId', 'seq'])
@Unique('UQ_message_idempotencia', [
  'conversationId',
  'senderUserId',
  'clientMessageId',
])
@Index('IDX_message_distribuidora_fecha', ['distributorId', 'createdAt'])
@Check('CHK_message_seq', `"seq" >= 1`)
@Check(
  'CHK_message_parte',
  `"sender_party" IN ('platform', 'company', 'system')`,
)
@Check(
  'CHK_message_autor',
  `("sender_party" = 'system') = ("sender_user_id" IS NULL)`,
)
@Check(
  'CHK_message_tipo',
  `"kind" IN ('text', 'system', 'auto_reply', 'quoted_excerpt') AND ("kind" IN ('system', 'auto_reply')) = ("sender_party" = 'system')`,
)
@Check(
  'CHK_message_visibilidad',
  `"visibility" IN ('all', 'internal') AND ("visibility" = 'all' OR ("sender_party" = 'platform' AND "kind" = 'text'))`,
)
@Check(
  'CHK_message_texto',
  `"body" IS NULL OR char_length(btrim("body")) BETWEEN 1 AND 2000`,
)
@Check(
  'CHK_message_texto_obligatorio',
  `"kind" NOT IN ('text', 'auto_reply') OR "body" IS NOT NULL OR "redacted_at" IS NOT NULL`,
)
@Check(
  'CHK_message_sistema',
  `("kind" = 'system') = ("system_code" IS NOT NULL)`,
)
@Check(
  'CHK_message_cita',
  `"kind" <> 'quoted_excerpt' OR "redacted_at" IS NOT NULL OR (jsonb_typeof("payload" -> 'items') = 'array' AND "payload" ? 'sourceConversationId' AND "payload" ? 'fromSeq' AND "payload" ? 'toSeq')`,
)
@Check('CHK_message_payload_texto', `"kind" <> 'text' OR "payload" IS NULL`)
export class Message {
  @PrimaryGeneratedColumn('uuid', {
    name: 'message_id',
    primaryKeyConstraintName: 'PK_message',
  })
  messageId!: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'bigint', transformer: columnNumericTransformer })
  seq!: number;

  @Column({ name: 'client_message_id', type: 'uuid', nullable: true })
  clientMessageId!: string | null;

  @Column({ name: 'sender_party', type: 'varchar', length: 10 })
  senderParty!: Party;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'sender_user_id',
    foreignKeyConstraintName: 'FK_message_sender',
  })
  sender?: User | null;

  @Column({ name: 'sender_user_id', type: 'uuid', nullable: true })
  senderUserId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  kind!: MessageKind;

  @Column({ type: 'varchar', length: 10, default: MessageVisibility.ALL })
  visibility!: MessageVisibility;

  @Column({ type: 'jsonb', nullable: true })
  payload!: PayloadDelMensaje | null;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  /** El filtro de datos de contacto cambió el texto (C4, CH5). */
  @Column({ name: 'body_filtered', type: 'boolean', default: false })
  bodyFiltered!: boolean;

  @Column({
    name: 'template_key',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  templateKey!: string | null;

  @Column({
    name: 'system_code',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  systemCode!: SystemCode | null;

  /** Hora del servidor; el orden real es `seq`. */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** Retención (§10.4): el texto pasa a nulo y la fila queda. */
  @Column({ name: 'redacted_at', type: 'timestamptz', nullable: true })
  redactedAt!: Date | null;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
