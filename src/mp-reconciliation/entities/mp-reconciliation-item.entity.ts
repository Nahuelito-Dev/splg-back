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
  Unique,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { CashDirection } from '../../cash/domain/cash.enums';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import {
  MpDifferenceKind,
  MpItemStatus,
} from '../domain/mp-reconciliation.enums';
import { MpReconciliation } from './mp-reconciliation.entity';

const importe = {
  type: 'decimal',
  precision: 14,
  scale: 2,
  nullable: true,
  transformer: columnNumericTransformer,
} as const;

/**
 * Una diferencia que encontró la conciliación entre una fila del reporte y el
 * libro de cajas. Nada se asienta solo: el administrador elige cuáles aplicar.
 * `rowKey` identifica la fila del reporte y el tipo de ajuste: una vez
 * aplicada, ninguna otra corrida (aunque el rango se pise) la vuelve a asentar.
 */
@ForeignKey(
  () => MpReconciliation,
  ['reconciliation_id', 'distributor_id'],
  ['reconciliation_id', 'distributor_id'],
  {
    name: 'FK_mp_reconciliation_item_reconciliation_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_mp_reconciliation_item_fila', ['reconciliationId', 'rowKey'])
@Index('UQ_mp_reconciliation_item_aplicada', ['distributorId', 'rowKey'], {
  unique: true,
  where: `"status" = 'applied'`,
})
@Index('UQ_mp_reconciliation_item_cuenta_aplicada', ['rowKey'], {
  unique: true,
  where: `"status" = 'applied' AND "account_level" = true`,
})
@Index('IDX_mp_reconciliation_item_corrida', ['reconciliationId', 'kind'])
@Check(
  'CHK_mp_reconciliation_item_aplicada',
  `"status" <> 'applied' OR ("applied_at" IS NOT NULL AND "applied_by_user_id" IS NOT NULL)`,
)
@Check(
  'CHK_mp_reconciliation_item_importes',
  `("mp_amount" IS NULL OR "mp_amount" >= 0) AND ("extra_amount" IS NULL OR "extra_amount" >= 0)`,
)
@Entity('mp_reconciliation_item')
export class MpReconciliationItem {
  @PrimaryGeneratedColumn('uuid', { name: 'item_id' })
  itemId!: string;

  @Column({ name: 'reconciliation_id', type: 'uuid' })
  reconciliationId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'row_key', type: 'uuid' })
  rowKey!: string;

  @Column({
    type: 'enum',
    enum: MpDifferenceKind,
  })
  kind!: MpDifferenceKind;

  /** Sólo lo ve y lo asienta el super admin. */
  @Column({ name: 'account_level', type: 'boolean', default: false })
  accountLevel!: boolean;

  /** Id del movimiento en Mercado Pago (`SOURCE_ID`). */
  @Column({ name: 'source_id', type: 'varchar', length: 100, nullable: true })
  sourceId!: string | null;

  @Column({ name: 'payment_id', type: 'uuid', nullable: true })
  paymentId!: string | null;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId!: string | null;

  @Column({ name: 'occurred_at', type: 'timestamptz', nullable: true })
  occurredAt!: Date | null;

  /** Tipo de movimiento que informa Mercado Pago (`DESCRIPTION`). */
  @Column({ name: 'mp_description', type: 'varchar', length: 120 })
  mpDescription!: string;

  /** El importe que informa Mercado Pago. */
  @Column({ name: 'mp_amount', ...importe })
  mpAmount!: number | null;

  /** El importe que tiene el libro de cajas. */
  @Column({ name: 'ledger_amount', ...importe })
  ledgerAmount!: number | null;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: columnNumericTransformer,
  })
  difference!: number | null;

  /** Lo que acompaña al importe: la comisión del cobro o del retiro. */
  @Column({ name: 'extra_amount', ...importe })
  extraAmount!: number | null;

  @Column({
    type: 'enum',
    enum: CashDirection,
    enumName: 'cash_movement_direction_enum',
    nullable: true,
  })
  direction!: CashDirection | null;

  @Column({ type: 'boolean', default: false })
  appliable!: boolean;

  @Column({ name: 'needs_cash_box', type: 'boolean', default: false })
  needsCashBox!: boolean;

  @Column({ type: 'varchar', length: 500 })
  note!: string;

  @Column({
    type: 'enum',
    enum: MpItemStatus,
    default: MpItemStatus.PENDING,
  })
  status!: MpItemStatus;

  @Column({ name: 'applied_at', type: 'timestamptz', nullable: true })
  appliedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'applied_by_user_id' })
  appliedBy?: User | null;

  @Column({ name: 'applied_by_user_id', type: 'uuid', nullable: true })
  appliedByUserId!: string | null;

  /** El movimiento de la caja que generó (en un retiro, la salida de la billetera). */
  @Column({ name: 'applied_movement_id', type: 'uuid', nullable: true })
  appliedMovementId!: string | null;

  /** Caja de destino elegida (retiros). */
  @Column({ name: 'target_cash_box_id', type: 'uuid', nullable: true })
  targetCashBoxId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
