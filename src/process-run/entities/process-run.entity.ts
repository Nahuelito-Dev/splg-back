import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import {
  ProcessName,
  ProcessRunStatus,
  RunTrigger,
} from '../domain/process-catalog';

/**
 * Una corrida de un proceso automático (F31). `distributorId` `null` es una
 * corrida global (un barrido de todas las distribuidoras). Es telemetría del
 * sistema: una fila al arrancar y se cierra al terminar; no entra en la
 * auditoría de datos (alto volumen, ver `TABLAS_EXCLUIDAS`).
 */
@Check(
  'CHK_process_run_fin',
  `"finished_at" IS NULL OR "finished_at" >= "started_at"`,
)
@Check(
  'CHK_process_run_estado_fin',
  `("status" = 'running') = ("finished_at" IS NULL)`,
)
@Check('CHK_process_run_contadores', `jsonb_typeof("counters") = 'object'`)
@Check(
  'CHK_process_run_empresas',
  `"companies" IS NULL OR jsonb_typeof("companies") = 'object'`,
)
@Check(
  'CHK_process_run_pedida_por',
  `("trigger_source" = 'manual') = ("requested_by" IS NOT NULL)`,
)
@Check(
  'CHK_process_run_huella',
  `"error_fingerprint" IS NULL OR "error_fingerprint" ~ '^[0-9a-f]{16}$'`,
)
// El orden DESC no lo modela TypeORM: los índices reales se crean en la migración.
@Index('IDX_process_run_distribuidora_proceso', { synchronize: false })
@Index('IDX_process_run_ultima', { synchronize: false })
@Index('IDX_process_run_traza', ['traceId'])
@Entity('process_run')
export class ProcessRun {
  @PrimaryGeneratedColumn('uuid', { name: 'run_id' })
  runId!: string;

  @Column({
    type: 'enum',
    enum: ProcessName,
  })
  process!: ProcessName;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor | null;

  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'now()' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({
    type: 'enum',
    enum: ProcessRunStatus,
    default: ProcessRunStatus.RUNNING,
  })
  status!: ProcessRunStatus;

  /** Lo que la corrida generó, con nombres claros: `{ processed: 3, errors: 0 }`. */
  @Column({ type: 'jsonb', default: () => `'{}'` })
  counters!: Record<string, number>;

  /** Mensaje de error sin datos sensibles (recortado y con credenciales tapadas). */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({
    name: 'trigger_source',
    type: 'enum',
    enum: RunTrigger,
    enumName: 'process_run_trigger_enum',
    default: RunTrigger.CRON,
  })
  trigger!: RunTrigger;

  /** `host:pid` de la instancia que la corrió (con varias instancias, cuál). */
  @Column({ type: 'varchar', length: 120 })
  instance!: string;

  /**
   * La traza a la que pertenece (DISENO-OBSERVABILIDAD §4.1): el request id del
   * webhook o del pedido manual que la disparó, o su propio `run_id` si nació
   * del cron. Une la corrida con la auditoría, los avisos y el log.
   */
  @Column({ name: 'trace_id', type: 'varchar', length: 64, nullable: true })
  traceId!: string | null;

  /** Quién la pidió: sólo en las corridas `manual`. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requested_by' })
  requester?: User | null;

  @Column({ name: 'requested_by', type: 'uuid', nullable: true })
  requestedBy!: string | null;

  /** Duración en ms; la calcula la base al cerrarla (`null` mientras corre). */
  @Column({
    name: 'duration_ms',
    type: 'integer',
    nullable: true,
    generatedType: 'STORED',
    asExpression: `(round((EXTRACT(epoch FROM ("finished_at" - "started_at")) * 1000)))::integer`,
    insert: false,
    update: false,
  })
  durationMs!: number | null;

  /** Huella del error (16 hexadecimales), la misma con que se agrupan los errores. */
  @Column({
    name: 'error_fingerprint',
    type: 'char',
    length: 16,
    nullable: true,
  })
  errorFingerprint!: string | null;

  /**
   * Cuántas empresas terminaron en cada estado si el proceso las recorre:
   * `{ ok, failed, timeout, locked, circuit_open, paused, skipped }`.
   */
  @Column({ type: 'jsonb', nullable: true })
  companies!: Record<string, number> | null;
}
