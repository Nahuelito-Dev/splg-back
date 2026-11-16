import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { TipoDeDocumento } from '../../document-reader/tipos-de-documento';
import { DocumentReading } from './document-reading.entity';

@ForeignKey(
  () => DocumentReading,
  ['source_reading_id', 'distributor_id'],
  ['reading_id', 'distributor_id'],
  {
    name: 'FK_document_reading_example_source_reading_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_document_reading_example_source_field', [
  'sourceReadingId',
  'field',
])
@Index('IDX_document_reading_example_tipo', [
  'distributorId',
  'documentType',
  'createdAt',
])
/**
 * Una corrección del administrador sobre una lectura (módulo M6): el lector la
 * recibe como ejemplo en las lecturas siguientes del mismo tipo de documento.
 */
@Entity('document_reading_example')
export class DocumentReadingExample {
  @PrimaryGeneratedColumn('uuid', { name: 'example_id' }) exampleId!: string;
  @ManyToOne(() => Distributor, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' }) distributorId!: string;
  @Column({
    name: 'document_type',
    type: 'enum',
    enum: TipoDeDocumento,
    enumName: 'document_reading_type_enum',
  })
  documentType!: TipoDeDocumento;
  @Column({ type: 'varchar', length: 60 }) field!: string;
  @Column({ name: 'read_value', type: 'text', nullable: true }) readValue!:
    | string
    | null;
  @Column({ name: 'correct_value', type: 'text' }) correctValue!: string;
  @Column({ name: 'source_reading_id', type: 'uuid' }) sourceReadingId!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
