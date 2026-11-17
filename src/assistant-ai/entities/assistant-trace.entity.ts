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
import { Conversation } from '../../chat/entities/conversation.entity';
import { Message } from '../../chat/entities/message.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import {
  CAUSAS_DE_DERIVACION,
  type CausaDeDerivacion,
  MOTIVOS_DE_LA_TRAZA,
  ResultadoDelAsistente,
  type MotivoDeDerivacion,
  type MotivoDeDescarte,
} from '../asistente-ia.dominio';

const enLista = (valores: readonly string[]): string =>
  valores.map((v) => `'${v}'`).join(', ');

/**
 * Traza de cada vez que actuó la capa inteligente del asistente
 * (DISENO-CH-BOT §4 y §6, B3): respondió o derivó, por qué, con qué modelo,
 * los tokens que cobró la API (entrada, salida y caché) y cuánto tardó. Nunca
 * el texto del cliente ni el de la respuesta (ése es el mensaje, con su propia
 * retención). B4 (métricas) se apoya en esta tabla, y el tope mensual de
 * tokens de cada empresa suma sus filas del mes.
 *
 * Una publicada por mensaje que la disparó (`UQ_assistant_trace_disparador`,
 * parcial: sin las descartadas): si dos trabajos atienden el mismo mensaje, el
 * segundo choca y su transacción (la respuesta incluida) vuelve atrás. La
 * respuesta o la derivación se escriben en la misma transacción que la traza.
 * Toda consulta al modelo deja traza con sus tokens aunque no se publique
 * (`discarded` con su motivo): cuenta para los topes.
 *
 * Sólo C3 (`staff_customer`) y C1 (`platform_chat`): la del soporte (C1) es
 * de la empresa que escribió, pero la paga la plataforma (su tope mensual
 * suma las de C1 de todas las empresas).
 */
@Entity('assistant_trace')
@ForeignKey(
  () => Conversation,
  ['conversation_id', 'distributor_id'],
  ['conversation_id', 'distributor_id'],
  {
    name: 'FK_assistant_trace_conversation_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Message,
  ['trigger_message_id', 'distributor_id'],
  ['message_id', 'distributor_id'],
  {
    name: 'FK_assistant_trace_trigger_message_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Message,
  ['reply_message_id', 'distributor_id'],
  ['message_id', 'distributor_id'],
  {
    name: 'FK_assistant_trace_reply_message_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Index('UQ_assistant_trace_disparador', ['triggerMessageId'], {
  unique: true,
  where: `"outcome" <> 'discarded'`,
})
@Index('IDX_assistant_trace_mes', ['channel', 'distributorId', 'createdAt'])
@Index('IDX_assistant_trace_conversacion', ['conversationId', 'outcome'])
@Check(
  'CHK_assistant_trace_canal',
  `"channel" IN ('platform_chat', 'staff_customer')`,
)
@Check(
  'CHK_assistant_trace_resultado',
  `"outcome" IN (${enLista(Object.values(ResultadoDelAsistente))}) AND ("outcome" = 'answered') = ("reason" IS NULL)`,
)
@Check(
  'CHK_assistant_trace_motivo',
  `"reason" IS NULL OR "reason" IN (${enLista(MOTIVOS_DE_LA_TRAZA)})`,
)
@Check(
  'CHK_assistant_trace_causa',
  `"handoff_cause" IS NULL OR ("reason" = 'requested' AND "handoff_cause" IN (${enLista(CAUSAS_DE_DERIVACION)}))`,
)
@Check(
  'CHK_assistant_trace_tokens',
  `"input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cache_creation_tokens" >= 0 AND "latency_ms" >= 0`,
)
@Check(
  'CHK_assistant_trace_herramientas',
  `jsonb_typeof("tools_used") = 'array'`,
)
export class AssistantTrace {
  @PrimaryGeneratedColumn('uuid', {
    name: 'trace_id',
    primaryKeyConstraintName: 'PK_assistant_trace',
  })
  traceId!: string;

  // RESTRICT: la baja de una empresa es lógica; sus trazas quedan.
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_assistant_trace_distributor',
  })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: string;

  /** El mensaje de la otra punta que atendió. */
  @Column({ name: 'trigger_message_id', type: 'uuid' })
  triggerMessageId!: string;

  /** Lo que publicó: la respuesta o el aviso de derivación; nulo si se descartó. */
  @Column({ name: 'reply_message_id', type: 'uuid', nullable: true })
  replyMessageId!: string | null;

  @Column({ type: 'varchar', length: 12 })
  outcome!: ResultadoDelAsistente;

  /** Por qué derivó o por qué se descartó; nulo si respondió. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  reason!: MotivoDeDerivacion | MotivoDeDescarte | null;

  /**
   * Con `requested`: la causa que dio el modelo al llamar `pasar_a_persona`
   * (no tenía la información, no estaba seguro, lo pidió la persona, reclamo
   * u otra). Nula en el resto. Las preguntas sin respuesta cuentan `no_info`
   * y `low_confidence`.
   */
  @Column({
    name: 'handoff_cause',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  handoffCause!: CausaDeDerivacion | null;

  /** El modelo que respondió (nulo si no se llegó a consultar: tope, sin clave). */
  @Column({ type: 'varchar', length: 60, nullable: true })
  model!: string | null;

  @Column({ name: 'input_tokens', type: 'integer', default: 0 })
  inputTokens!: number;

  @Column({ name: 'output_tokens', type: 'integer', default: 0 })
  outputTokens!: number;

  @Column({ name: 'cache_read_tokens', type: 'integer', default: 0 })
  cacheReadTokens!: number;

  @Column({ name: 'cache_creation_tokens', type: 'integer', default: 0 })
  cacheCreationTokens!: number;

  /** Las herramientas que usó, en orden (sólo los nombres). */
  @Column({ name: 'tools_used', type: 'jsonb', default: () => `'[]'` })
  toolsUsed!: string[];

  /** Desde que se empezó a atender el mensaje hasta publicar. */
  @Column({ name: 'latency_ms', type: 'integer' })
  latencyMs!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
