import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Check,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { CashSessionStatus } from '../domain/cash.enums';
import { CashBox } from './cash-box.entity';

/**
 * Apertura y cierre (arqueo) de una caja. A lo sumo una abierta por caja: el
 * único parcial lo garantiza aunque dos aperturas lleguen a la vez.
 */
@Check(
  'CHK_cash_session_montos',
  `"opening_amount" >= 0 AND ("counted_amount" IS NULL OR "counted_amount" >= 0)`,
)
@Check(
  'CHK_cash_session_cierre_fecha',
  `("status" = 'closed') = ("closed_at" IS NOT NULL)`,
)
@Check(
  'CHK_cash_session_cierre_completo',
  `"status" <> 'closed' OR ("closed_by_user_id" IS NOT NULL AND "counted_amount" IS NOT NULL AND "expected_amount" IS NOT NULL AND "difference" = "counted_amount" - "expected_amount")`,
)
@Check(
  'CHK_cash_session_periodo',
  `"closed_at" IS NULL OR "closed_at" >= "opened_at"`,
)
@Entity('cash_session')
@Index('UQ_cash_session_abierta', ['cashBoxId'], {
  unique: true,
  where: `"status" = 'open'`,
})
@Index('IDX_cash_session_caja_fecha', ['cashBoxId', 'openedAt'])
export class CashSession {
  @PrimaryGeneratedColumn('uuid', { name: 'session_id' })
  sessionId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Index('IDX_cash_session_distributor')
  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => CashBox, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cash_box_id' })
  cashBox?: CashBox;

  @Column({ name: 'cash_box_id', type: 'uuid' })
  cashBoxId!: string;

  @Column({
    type: 'enum',
    enum: CashSessionStatus,
    default: CashSessionStatus.OPEN,
  })
  status!: CashSessionStatus;

  @Column({ name: 'opened_at', type: 'timestamptz', default: () => 'now()' })
  openedAt!: Date;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'opened_by_user_id' })
  openedBy?: User;

  @Column({ name: 'opened_by_user_id', type: 'uuid' })
  openedByUserId!: string;

  @Column({
    name: 'opening_amount',
    type: 'decimal',
    precision: 14,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  openingAmount!: number;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'closed_by_user_id' })
  closedBy?: User | null;

  @Column({ name: 'closed_by_user_id', type: 'uuid', nullable: true })
  closedByUserId!: string | null;

  @Column({
    name: 'expected_amount',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: columnNumericTransformer,
  })
  expectedAmount!: number | null;

  @Column({
    name: 'counted_amount',
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: columnNumericTransformer,
  })
  countedAmount!: number | null;

  /** Contado menos esperado: negativa es faltante, positiva sobrante. */
  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: columnNumericTransformer,
  })
  difference!: number | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;
}
