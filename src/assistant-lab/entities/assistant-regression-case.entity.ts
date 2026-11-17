import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import type { Esperado } from '../assistant-lab.dominio';

/**
 * Un caso del lote de regresión del asistente de una empresa (DISENO-CH-BOT
 * §7): una pregunta, si se espera que responda o que pase a una persona y,
 * si responde, lo que tiene que mencionar. Baja lógica; hasta 100 vigentes
 * por empresa (lo controla el servicio con un cerrojo por empresa). Una
 * pregunta por empresa entre los vigentes, sin distinguir mayúsculas
 * (`UQ_assistant_regression_case_pregunta_vigente`, de la migración).
 */
@Entity('assistant_regression_case')
@Index('UQ_assistant_regression_case_pregunta_vigente', { synchronize: false })
@Index('IDX_assistant_regression_case_distribuidora', [
  'distributorId',
  'createdAt',
])
@Check(
  'CHK_assistant_regression_case_pregunta',
  `char_length(btrim("question")) BETWEEN 2 AND 500`,
)
@Check(
  'CHK_assistant_regression_case_esperado',
  `"expected" IN ('answer', 'handoff')`,
)
@Check(
  'CHK_assistant_regression_case_menciones',
  `jsonb_typeof("must_mention") = 'array' AND jsonb_array_length("must_mention") <= 10 AND ("expected" = 'answer' OR jsonb_array_length("must_mention") = 0)`,
)
export class AssistantRegressionCase {
  @PrimaryGeneratedColumn('uuid', {
    name: 'case_id',
    primaryKeyConstraintName: 'PK_assistant_regression_case',
  })
  caseId!: string;

  // RESTRICT: la baja de una empresa es lógica; sus casos quedan.
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_assistant_regression_case_distributor',
  })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'varchar', length: 500 })
  question!: string;

  @Column({ type: 'varchar', length: 8 })
  expected!: Esperado;

  /** Lo que tiene que mencionar la respuesta (sin distinguir mayúsculas ni tildes). */
  @Column({ name: 'must_mention', type: 'jsonb', default: () => `'[]'` })
  mustMention!: string[];

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
