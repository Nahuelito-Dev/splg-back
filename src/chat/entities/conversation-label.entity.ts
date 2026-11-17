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
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import type { ColorDeEtiqueta } from '../domain/etiquetas';

/**
 * Una etiqueta de la bandeja de una empresa (tanda 7c): nombre de hasta 30
 * caracteres, único entre las vigentes de la empresa sin distinguir
 * mayúsculas ni tildes (único parcial `UQ_conversation_label_nombre` sobre
 * `chat_label_key(name)`, que crea la migración), y un color de la paleta
 * fija. Baja lógica; hasta 50 vigentes por empresa (trigger
 * `TRG_conversation_label_tope`).
 */
@Entity('conversation_label')
@Unique('UQ_conversation_label_id_distribuidora', ['labelId', 'distributorId'])
@Index('UQ_conversation_label_nombre', { synchronize: false })
@Check(
  'CHK_conversation_label_nombre',
  `char_length("name") BETWEEN 1 AND 30 AND "name" = btrim("name") AND "name" !~ '[\\u0001-\\u001F\\u007F-\\u009F\\u2028\\u2029]'`,
)
@Check(
  'CHK_conversation_label_color',
  `"color" IN ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink')`,
)
export class ConversationLabel {
  @PrimaryGeneratedColumn('uuid', {
    name: 'label_id',
    primaryKeyConstraintName: 'PK_conversation_label',
  })
  labelId!: string;

  // RESTRICT: la baja de una empresa es lógica; sus etiquetas quedan.
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_conversation_label_distributor',
  })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'varchar', length: 30 })
  name!: string;

  @Column({ type: 'varchar', length: 10 })
  color!: ColorDeEtiqueta;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
