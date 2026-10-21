import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Check,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

/**
 * Último número emitido de cada tipo de documento de una distribuidora
 * (órdenes de compra, remitos internos, cargas, rendiciones, legajos…). Una
 * fila por `(distributor_id, doc_type)`: se crea con el primer número y desde
 * ahí sólo se incrementa.
 */
@Check(
  'CHK_document_sequence_valores',
  `"last_number" >= 0 AND "doc_type" ~ '^[a-z][a-z0-9_]{0,39}$'`,
)
@Entity('document_sequence')
export class DocumentSequence {
  @PrimaryColumn({
    name: 'distributor_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_document_sequence',
  })
  distributorId!: string;

  @ManyToOne(() => Distributor, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_document_sequence_distributor',
  })
  distributor?: Distributor;

  @PrimaryColumn({
    name: 'doc_type',
    type: 'varchar',
    length: 40,
    primaryKeyConstraintName: 'PK_document_sequence',
  })
  docType!: string;

  @Column({ name: 'last_number', type: 'int', default: 0 })
  lastNumber!: number;
}
