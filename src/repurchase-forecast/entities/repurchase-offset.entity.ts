import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Check,
  Index,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Cuántos días se corre la fecha estimada de recompra de un cliente en una
 * distribuidora (M3a): el error medio de sus invitaciones anteriores (cuándo
 * compró de verdad contra cuándo se predijo). Positivo = la garrafa le dura más
 * de lo estimado. Es un valor derivado: se recalcula cuando se le entrega un
 * pedido y está acotado (`CHK_repurchase_offset_tope`).
 */
@Check(
  'CHK_repurchase_offset_tope',
  `"offset_days" BETWEEN -15 AND 15 AND "sample_size" >= 0`,
)
@Entity('repurchase_offset')
export class RepurchaseOffset {
  @PrimaryColumn({
    name: 'user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_repurchase_offset',
  })
  userId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_repurchase_offset_user',
  })
  user?: User;

  @Index('IDX_repurchase_offset_distributor')
  @PrimaryColumn({
    name: 'distributor_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_repurchase_offset',
  })
  distributorId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_repurchase_offset_distributor',
  })
  distributor?: Distributor;

  /** Días que se suman (o restan) a la fecha estimada. */
  @Column({ name: 'offset_days', type: 'integer', default: 0 })
  offsetDays!: number;

  /** Con cuántas invitaciones medidas se calculó. */
  @Column({ name: 'sample_size', type: 'integer', default: 0 })
  sampleSize!: number;

  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt!: Date;
}
