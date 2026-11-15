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
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { CLAVE_EN_LA_BASE, sinHtmlEnLaBase as sinHtml } from '../texto-plano';
import { AssistantKnowledgeBase } from './assistant-knowledge-base.entity';

/**
 * Pregunta frecuente de la base de conocimiento del asistente del chat
 * (DISENO-CH-BOT §4.3). Las de una distribuidora llevan su `distributor_id`
 * y contestan a sus clientes; las de la plataforma (OrixTech) lo tienen nulo
 * y contestan a las distribuidoras en el soporte. Son dos bases ajenas
 * (D-B6): nada de la de OrixTech llega a una distribuidora. Las preguntas de
 * ejemplo que copia cada distribuidora son otro catálogo
 * (`AssistantFaqTemplate`, D-B7).
 *
 * `key`: en la plataforma, la clave de la pregunta (obligatoria, no cambia);
 * en una distribuidora, la de la pregunta de ejemplo de la que salió (nula si
 * la escribió la empresa). Por esa clave la copia de ejemplos no duplica.
 *
 * Únicos parciales entre las vigentes (de la migración): una clave y una
 * pregunta (sin mayúsculas ni espacios de los bordes) por base. Texto plano:
 * sin etiquetas ni entidades HTML (§5), también en la base.
 *
 * `position`: el orden en la base (la lista y el contexto del asistente salen
 * ordenados por ella). Una pregunta nueva va al final; las preguntas de
 * ejemplo copiadas conservan el orden que tienen en el catálogo.
 */
@Entity('assistant_faq')
@ForeignKey(
  () => AssistantKnowledgeBase,
  ['knowledge_base_id', 'distributor_id'],
  ['knowledge_base_id', 'distributor_id'],
  {
    name: 'FK_assistant_faq_knowledge_base_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Index('UQ_assistant_faq_clave_vigente', { synchronize: false })
@Index('UQ_assistant_faq_pregunta_vigente', { synchronize: false })
@Index('IDX_assistant_faq_distribuidora', ['distributorId', 'position'])
@Check(
  'CHK_assistant_faq_pregunta',
  `char_length(btrim("question")) BETWEEN 5 AND 200`,
)
@Check(
  'CHK_assistant_faq_respuesta',
  `char_length(btrim("answer")) BETWEEN 1 AND 1500`,
)
@Check(
  'CHK_assistant_faq_sin_html',
  `${sinHtml('question')} AND ${sinHtml('answer')}`,
)
@Check('CHK_assistant_faq_posicion', `"position" >= 1`)
@Check(
  'CHK_assistant_faq_clave',
  `"key" IS NULL OR "key" ~ '${CLAVE_EN_LA_BASE}'`,
)
@Check(
  'CHK_assistant_faq_clave_de_plataforma',
  `"distributor_id" IS NOT NULL OR "key" IS NOT NULL`,
)
export class AssistantFaq {
  @PrimaryGeneratedColumn('uuid', {
    name: 'faq_id',
    primaryKeyConstraintName: 'PK_assistant_faq',
  })
  faqId!: string;

  @ManyToOne(() => AssistantKnowledgeBase, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'knowledge_base_id',
    foreignKeyConstraintName: 'FK_assistant_faq_knowledge_base',
  })
  knowledgeBase?: AssistantKnowledgeBase;

  @Column({ name: 'knowledge_base_id', type: 'uuid' })
  knowledgeBaseId!: string;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_assistant_faq_distributor',
  })
  distributor?: Distributor | null;

  /** Nulo: de la plataforma (OrixTech). */
  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  key!: string | null;

  @Column({ type: 'varchar', length: 200 })
  question!: string;

  @Column({ type: 'varchar', length: 1500 })
  answer!: string;

  /** Orden dentro de la base (1 es la primera). */
  @Column({ type: 'integer' })
  position!: number;

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
