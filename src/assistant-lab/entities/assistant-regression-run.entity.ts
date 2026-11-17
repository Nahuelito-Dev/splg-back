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
import type { ResultadoDeCasoGuardado } from '../assistant-lab.dominio';

export type EstadoDeLaCorrida = 'running' | 'finished' | 'failed';

/**
 * Una corrida del lote de regresión de una empresa: corre todos sus casos
 * vigentes con el probador (asíncrona: la respuesta del alta no la espera) y
 * va guardando el resultado de cada uno (y su latido, `updated_at`). Una en curso por empresa
 * (`UQ_assistant_regression_run_en_curso`, parcial); la última es la que ve
 * el panel. `results` guarda una foto de cada caso (la pregunta como estaba
 * al correrla), así se puede leer aunque después se edite o se dé de baja.
 */
@Entity('assistant_regression_run')
@Index('UQ_assistant_regression_run_en_curso', ['distributorId'], {
  unique: true,
  where: `"status" = 'running'`,
})
@Index('IDX_assistant_regression_run_distribuidora', [
  'distributorId',
  'startedAt',
])
@Check(
  'CHK_assistant_regression_run_estado',
  `"status" IN ('running', 'finished', 'failed') AND ("status" = 'running') = ("finished_at" IS NULL)`,
)
@Check(
  'CHK_assistant_regression_run_conteos',
  `"total" BETWEEN 0 AND 100 AND "passed" >= 0 AND "failed" >= 0 AND "errored" >= 0 AND "passed" + "failed" + "errored" <= "total"`,
)
@Check(
  'CHK_assistant_regression_run_resultados',
  `jsonb_typeof("results") = 'array'`,
)
export class AssistantRegressionRun {
  @PrimaryGeneratedColumn('uuid', {
    name: 'run_id',
    primaryKeyConstraintName: 'PK_assistant_regression_run',
  })
  runId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_assistant_regression_run_distributor',
  })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'varchar', length: 10 })
  status!: EstadoDeLaCorrida;

  @Column({ type: 'integer' })
  total!: number;

  @Column({ type: 'integer', default: 0 })
  passed!: number;

  @Column({ type: 'integer', default: 0 })
  failed!: number;

  @Column({ type: 'integer', default: 0 })
  errored!: number;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  results!: ResultadoDeCasoGuardado[];

  @Column({ name: 'started_by', type: 'uuid', nullable: true })
  startedBy!: string | null;

  @Column({
    name: 'started_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  /** Latido: cada avance lo actualiza (ver `SEGUNDOS_SIN_LATIDO`). */
  @Column({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  updatedAt!: Date;
}
