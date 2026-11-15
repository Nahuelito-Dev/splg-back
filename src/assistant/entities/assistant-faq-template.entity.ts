import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CLAVE_EN_LA_BASE, sinHtmlEnLaBase } from '../texto-plano';

/**
 * Pregunta de ejemplo para distribuidoras (DISENO-CH-BOT D-B7): el catálogo
 * que OrixTech carga en la plataforma (horarios, pagos, zonas, estado del
 * pedido) y que cada distribuidora copia a su base con `from-templates`.
 * Desde la copia, la pregunta es de la distribuidora: editarla o darla de
 * baja no toca el catálogo, ni al revés. No es la base de OrixTech (esa
 * contesta a las distribuidoras en el soporte y nunca se copia, D-B6).
 *
 * Mismas reglas de texto que `assistant_faq` (largos como los cuenta
 * Postgres, sin HTML), clave obligatoria con el mismo formato y, entre las
 * vigentes (únicos parciales de la migración), una sola por clave, por
 * pregunta (sin mayúsculas ni espacios de los bordes) y por posición: la
 * posición es el único orden del catálogo y el de la copia.
 *
 * `updated_by` no lleva clave foránea, igual que en la base de conocimiento:
 * es un dato de cortesía; quién hizo cada cambio lo asienta la auditoría.
 */
@Entity('assistant_faq_template')
@Index('UQ_assistant_faq_template_clave_vigente', { synchronize: false })
@Index('UQ_assistant_faq_template_pregunta_vigente', { synchronize: false })
@Index('UQ_assistant_faq_template_posicion_vigente', { synchronize: false })
@Check(
  'CHK_assistant_faq_template_pregunta',
  `char_length(btrim("question")) BETWEEN 5 AND 200`,
)
@Check(
  'CHK_assistant_faq_template_respuesta',
  `char_length(btrim("answer")) BETWEEN 1 AND 1500`,
)
@Check(
  'CHK_assistant_faq_template_sin_html',
  `${sinHtmlEnLaBase('question')} AND ${sinHtmlEnLaBase('answer')}`,
)
@Check('CHK_assistant_faq_template_posicion', `"position" >= 1`)
@Check('CHK_assistant_faq_template_clave', `"key" ~ '${CLAVE_EN_LA_BASE}'`)
export class AssistantFaqTemplate {
  @PrimaryGeneratedColumn('uuid', {
    name: 'template_id',
    primaryKeyConstraintName: 'PK_assistant_faq_template',
  })
  templateId!: string;

  /** No cambia: para cambiarla se da de baja y se crea otra. */
  @Column({ type: 'varchar', length: 60 })
  key!: string;

  @Column({ type: 'varchar', length: 200 })
  question!: string;

  @Column({ type: 'varchar', length: 1500 })
  answer!: string;

  /** Orden en el catálogo (1 es la primera). */
  @Column({ type: 'integer' })
  position!: number;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
