import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import {
  MOTIVOS_DE_DERIVACION,
  type MotivoDeDerivacion,
  ResultadoDelAsistente,
} from '../asistente-ia.dominio';

const enLista = (valores: readonly string[]): string =>
  valores.map((v) => `'${v}'`).join(', ');

/**
 * Lo que gastó el asistente con IA en las pruebas (probador y lote de
 * regresión): una fila por consulta al modelo, con sus tokens. No es una
 * conversación: no va en `assistant_trace` ni cuenta en las métricas, pero sí
 * suma para el tope mensual de tokens (el de la empresa en C3, el del soporte
 * en C1). Nunca el texto de la pregunta ni el de la respuesta.
 *
 * `distributor_id`: la empresa que probó (C3); nulo, el soporte de la
 * plataforma (C1).
 */
@Entity('assistant_test_usage')
@Index('IDX_assistant_test_usage_mes', [
  'channel',
  'distributorId',
  'createdAt',
])
@Check(
  'CHK_assistant_test_usage_canal',
  `"channel" IN ('platform_chat', 'staff_customer') AND ("channel" = 'staff_customer') = ("distributor_id" IS NOT NULL)`,
)
@Check('CHK_assistant_test_usage_tipo', `"kind" IN ('preview', 'regression')`)
@Check(
  'CHK_assistant_test_usage_resultado',
  `"outcome" IN ('${ResultadoDelAsistente.ANSWERED}', '${ResultadoDelAsistente.HANDED_OFF}') AND ("outcome" = '${ResultadoDelAsistente.ANSWERED}') = ("reason" IS NULL)`,
)
@Check(
  'CHK_assistant_test_usage_motivo',
  `"reason" IS NULL OR "reason" IN (${enLista(MOTIVOS_DE_DERIVACION)})`,
)
@Check(
  'CHK_assistant_test_usage_tokens',
  `"input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cache_creation_tokens" >= 0 AND "latency_ms" >= 0`,
)
@Check(
  'CHK_assistant_test_usage_herramientas',
  `jsonb_typeof("tools_used") = 'array'`,
)
export class AssistantTestUsage {
  @PrimaryGeneratedColumn('uuid', {
    name: 'usage_id',
    primaryKeyConstraintName: 'PK_assistant_test_usage',
  })
  usageId!: string;

  // RESTRICT: la baja de una empresa es lógica; su uso queda.
  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_assistant_test_usage_distributor',
  })
  distributor?: Distributor | null;

  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  channel!: string;

  /** `preview`: el probador; `regression`: un caso del lote de regresión. */
  @Column({ type: 'varchar', length: 12 })
  kind!: 'preview' | 'regression';

  @Column({ type: 'varchar', length: 60 })
  model!: string;

  @Column({ type: 'varchar', length: 12 })
  outcome!: ResultadoDelAsistente;

  @Column({ type: 'varchar', length: 20, nullable: true })
  reason!: MotivoDeDerivacion | null;

  @Column({ name: 'input_tokens', type: 'integer', default: 0 })
  inputTokens!: number;

  @Column({ name: 'output_tokens', type: 'integer', default: 0 })
  outputTokens!: number;

  @Column({ name: 'cache_read_tokens', type: 'integer', default: 0 })
  cacheReadTokens!: number;

  @Column({ name: 'cache_creation_tokens', type: 'integer', default: 0 })
  cacheCreationTokens!: number;

  @Column({ name: 'tools_used', type: 'jsonb', default: () => `'[]'` })
  toolsUsed!: string[];

  @Column({ name: 'latency_ms', type: 'integer' })
  latencyMs!: number;

  /** Quién la corrió; nulo si esa cuenta ya no existe. */
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
