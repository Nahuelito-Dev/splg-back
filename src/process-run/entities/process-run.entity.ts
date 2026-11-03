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
// El orden DESC no lo modela TypeORM: los índices reales se crean en la migración.
@Index('IDX_process_run_distribuidora_proceso', { synchronize: false })
@Index('IDX_process_run_ultima', { synchronize: false })
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
}
