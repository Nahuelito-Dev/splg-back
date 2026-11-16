import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

/**
 * Cabecera de la base de conocimiento del asistente del chat (DISENO-CH-BOT
 * §4.3): una por distribuidora y una de la plataforma (OrixTech,
 * `distributor_id` nulo, única por el índice parcial
 * `UQ_assistant_knowledge_base_plataforma` de la migración).
 *
 * - `version` sube con cada cambio de sus preguntas (alta, edición, baja,
 *   copia de plantillas) y nunca baja: el asistente (B3) la usa para saber si
 *   el contexto que tiene en caché sigue vigente.
 * - Es la fila que se bloquea (`FOR UPDATE`) en cada escritura: serializa las
 *   altas de una misma base, y con eso el tope de preguntas y la copia de
 *   plantillas no se pasan ni se duplican con dos pedidos a la vez.
 *
 * `updated_by` no lleva clave foránea, igual que en el tema por distribuidora:
 * es un dato de cortesía; quién hizo cada cambio lo asienta la auditoría.
 */
@Entity('assistant_knowledge_base')
@Unique('UQ_assistant_knowledge_base_id_distribuidora', [
  'knowledgeBaseId',
  'distributorId',
])
@Unique('UQ_assistant_knowledge_base_distribuidora', ['distributorId'])
@Index('UQ_assistant_knowledge_base_plataforma', { synchronize: false })
@Check('CHK_assistant_knowledge_base_version', `"version" >= 0`)
export class AssistantKnowledgeBase {
  @PrimaryGeneratedColumn('uuid', {
    name: 'knowledge_base_id',
    primaryKeyConstraintName: 'PK_assistant_knowledge_base',
  })
  knowledgeBaseId!: string;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_assistant_knowledge_base_distributor',
  })
  distributor?: Distributor | null;

  /** Nulo: la base de la plataforma (OrixTech). */
  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @Column({ type: 'integer', default: 0 })
  version!: number;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
