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
  | { claimId: string }
  | { until: string }
  | Record<string, never>;

/**
 * Un mensaje (diseño §6.5). `seq` lo asigna el envío con la conversación
 * bloqueada: único por conversación y sin huecos. `client_message_id` hace el
 * envío idempotente: el mismo id del mismo autor en la misma conversación es
 * el mismo mensaje.
 *
 * Inmutable (trigger `message_inmutable` de `sql/bandeja-de-la-empresa.ts`):
 * sólo se puede redactar (texto a nulo, `redacted_at`), dar de baja
 * (`deleted_at`) y, en la bandeja de la empresa, editar el texto de un mensaje
 * propio (D-C22: `edited_at` y el original en `message_edit`). Nunca borrado
 * físico. El texto y la cita van `[oculto]` en la auditoría (D-C11: la
 * auditoría es inmutable y no se podría cumplir la retención).
 *
 * `reply_to_seq` (D-C25): responde a otro mensaje de la MISMA conversación (FK
 * compuesta `(conversation_id, reply_to_seq)` contra `(conversation_id, seq)`),
 * anterior a éste. Sólo en la bandeja (trigger `TRG_message_canal`).
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
@ForeignKey(
  () => Message,
  ['conversation_id', 'reply_to_seq'],
  ['conversation_id', 'seq'],
  { name: 'FK_message_respuesta', onDelete: 'NO ACTION' },
)
@Index('IDX_message_distribuidora_fecha', ['distributorId', 'createdAt'])
@Check(
  'CHK_message_respuesta',
  `"reply_to_seq" IS NULL OR ("reply_to_seq" >= 1 AND "reply_to_seq" < "seq")`,
)
@Check(
  'CHK_message_respuesta_vista',
  `"reply_to_preview" IS NULL OR "reply_to_seq" IS NOT NULL`,
)
@Check(
  'CHK_message_retirado',
  `("withdrawn_at" IS NULL) = ("withdrawn_by_user_id" IS NULL) AND ("withdrawn_at" IS NULL OR ("sender_party" = 'customer' AND "kind" = 'text' AND "withdrawn_by_user_id" = "sender_user_id"))`,
)
@Check(
  'CHK_message_editado',
  `"edited_at" IS NULL OR ("kind" = 'text' AND "sender_user_id" IS NOT NULL)`,
)
@Check('CHK_message_seq', `"seq" >= 1`)
@Check(
  'CHK_message_parte',
  `"sender_party" IN ('platform', 'company', 'customer', 'driver', 'system')`,
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

  /** El mensaje al que responde (D-C25), de la misma conversación. */
  @Column({
    name: 'reply_to_seq',
    type: 'bigint',
    nullable: true,
    transformer: columnNumericTransformer,
  })
  replyToSeq!: number | null;

  /**
   * La vista previa (140) del mensaje citado, congelada al citarlo: no cambia
   * si después se redacta. Nula si el citado no tenía texto visible.
   */
  @Column({
    name: 'reply_to_preview',
    type: 'varchar',
    length: 140,
    nullable: true,
  })
  replyToPreview!: string | null;

  /** Última edición del texto por su autor (D-C22); el original queda en `message_edit`. */
  @Column({ name: 'edited_at', type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  /**
   * Borrado por su autor (D-C23): sólo el cliente, en C3. Lógico: la fila y el
   * texto quedan (la limpieza física es de la retención, CH8), pero la API y
   * los eventos lo devuelven `deleted: true` y sin texto. No se usa
   * `deleted_at` (es la baja con la conversación, y TypeORM excluye esas filas
   * de las lecturas: el mensaje desaparecería del hilo y dejaría un hueco de
   * `seq`).
   */
  @Column({ name: 'withdrawn_at', type: 'timestamptz', nullable: true })
  withdrawnAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'withdrawn_by_user_id',
    foreignKeyConstraintName: 'FK_message_withdrawn_by',
  })
  withdrawnBy?: User | null;

  @Column({ name: 'withdrawn_by_user_id', type: 'uuid', nullable: true })
  withdrawnByUserId!: string | null;

  /** Hora del servidor; el orden real es `seq`. */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** Retención (§10.4): el texto pasa a nulo y la fila queda. */
  @Column({ name: 'redacted_at', type: 'timestamptz', nullable: true })
  redactedAt!: Date | null;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
