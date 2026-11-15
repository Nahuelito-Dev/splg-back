import { Check, Column, Entity, ForeignKey, PrimaryColumn } from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Party } from '../domain/chat.enums';
import { Conversation } from './conversation.entity';

/**
 * Una fila por **parte** de la conversación (diseño §6.3), no por persona: en
 * C1 los dos equipos (`platform` y `company`), sin usuario. `last_read_seq` es
 * el máximo leído por la parte (lo que la otra punta ve como «leído») y sube
 * con `GREATEST` cuando cualquier persona de la parte lee; no se audita
 * (cambia con cada lectura).
 */
@Entity('conversation_party')
@ForeignKey(
  () => Conversation,
  ['conversation_id', 'distributor_id'],
  ['conversation_id', 'distributor_id'],
  {
    name: 'FK_conversation_party_conversation_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Check('CHK_conversation_party_parte', `"party" IN ('platform', 'company')`)
@Check('CHK_conversation_party_equipo_sin_usuario', `"user_id" IS NULL`)
@Check(
  'CHK_conversation_party_lecturas',
  `"last_read_seq" >= 0 AND "last_delivered_seq" >= 0`,
)
export class ConversationParty {
  @PrimaryColumn({
    name: 'conversation_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_conversation_party',
  })
  conversationId!: string;

  @PrimaryColumn({
    type: 'varchar',
    length: 10,
    primaryKeyConstraintName: 'PK_conversation_party',
  })
  party!: Party.PLATFORM | Party.COMPANY;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** La persona, en las partes de una sola persona (chofer, cliente: CH3+). */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({
    name: 'last_read_seq',
    type: 'bigint',
    default: 0,
    transformer: columnNumericTransformer,
  })
  lastReadSeq!: number;

  @Column({
    name: 'last_delivered_seq',
    type: 'bigint',
    default: 0,
    transformer: columnNumericTransformer,
  })
  lastDeliveredSeq!: number;

  /** Silenciar los avisos (no oculta). */
  @Column({ name: 'muted_until', type: 'timestamptz', nullable: true })
  mutedUntil!: Date | null;

  /** La parte no puede escribir (moderación, CH8). */
  @Column({ name: 'restricted_at', type: 'timestamptz', nullable: true })
  restrictedAt!: Date | null;
}
