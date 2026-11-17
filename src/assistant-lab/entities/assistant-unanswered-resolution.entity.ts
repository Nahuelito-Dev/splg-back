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
  UpdateDateColumn,
} from 'typeorm';
import { AssistantFaq } from '../../assistant/entities/assistant-faq.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

export type EstadoDelGrupo = 'resolved' | 'dismissed';

/**
 * Lo que se hizo con un grupo de «preguntas sin respuesta» del asistente: se
 * creó una pregunta frecuente en borrador (`resolved`) o se descartó
 * (`dismissed`). Los grupos no se guardan: salen de las trazas y de los
 * mensajes (así el texto del cliente sigue la retención del mensaje); acá
 * queda sólo su id (32 hexadecimales de la pregunta normalizada) y desde
 * cuándo no se muestra. Lo que llegue después vuelve a aparecer.
 *
 * `distributor_id`: la empresa, para lo que preguntaron sus clientes (C3);
 * nulo, el soporte de la plataforma (C1). Una por grupo y dueño
 * (`UQ_assistant_unanswered_resolution_grupo`, de la migración). La pregunta
 * creada es de la misma base (`FK_assistant_unanswered_resolution_faq_distribuidora`).
 */
@Entity('assistant_unanswered_resolution')
@ForeignKey(
  () => AssistantFaq,
  ['faq_id', 'distributor_id'],
  ['faq_id', 'distributor_id'],
  {
    name: 'FK_assistant_unanswered_resolution_faq_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Index('UQ_assistant_unanswered_resolution_grupo', { synchronize: false })
@Check(
  'CHK_assistant_unanswered_resolution_canal',
  `"channel" IN ('platform_chat', 'staff_customer') AND ("channel" = 'staff_customer') = ("distributor_id" IS NOT NULL)`,
)
@Check(
  'CHK_assistant_unanswered_resolution_estado',
  `"status" IN ('resolved', 'dismissed') AND ("status" = 'resolved') = ("faq_id" IS NOT NULL)`,
)
@Check(
  'CHK_assistant_unanswered_resolution_grupo',
  `"question_key" ~ '^[0-9a-f]{32}$'`,
)
export class AssistantUnansweredResolution {
  @PrimaryGeneratedColumn('uuid', {
    name: 'resolution_id',
    primaryKeyConstraintName: 'PK_assistant_unanswered_resolution',
  })
  resolutionId!: string;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_assistant_unanswered_resolution_distributor',
  })
  distributor?: Distributor | null;

  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  channel!: string;

  @Column({ name: 'question_key', type: 'varchar', length: 32 })
  questionKey!: string;

  @Column({ type: 'varchar', length: 10 })
  status!: EstadoDelGrupo;

  @ManyToOne(() => AssistantFaq, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'faq_id',
    foreignKeyConstraintName: 'FK_assistant_unanswered_resolution_faq',
  })
  faq?: AssistantFaq | null;

  /** La pregunta en borrador que se creó; nula si se descartó. */
  @Column({ name: 'faq_id', type: 'uuid', nullable: true })
  faqId!: string | null;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy!: string | null;

  /** Desde cuándo no se muestra lo anterior del grupo. */
  @Column({ name: 'resolved_at', type: 'timestamptz' })
  resolvedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
