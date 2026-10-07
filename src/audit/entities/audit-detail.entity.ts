import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Audit } from './audit.entity';

/**
 * DetalleAuditoria del modelo de la cátedra: un campo que cambió en una
 * auditoría, con su valor anterior y el nuevo (en texto). Los campos
 * sensibles se guardan como `[oculto]`.
 */
@Entity('audit_detail')
export class AuditDetail {
  @PrimaryGeneratedColumn('uuid', { name: 'audit_detail_id' })
  auditDetailId!: string;

  @Index('IDX_audit_detail_audit')
  @Column({ name: 'audit_id', type: 'uuid' })
  auditId!: string;

  @ManyToOne(() => Audit, (a) => a.details, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'audit_id' })
  audit?: Audit;

  @Column({ type: 'varchar', length: 80 })
  field!: string;

  @Column({ name: 'old_value', type: 'text', nullable: true })
  oldValue!: string | null;

  @Column({ name: 'new_value', type: 'text', nullable: true })
  newValue!: string | null;
}
