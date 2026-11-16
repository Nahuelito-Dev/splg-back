import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  ForeignKey,
  Unique,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import {
  CashDirection,
  CashMethod,
  CashReferenceType,
} from '../domain/cash.enums';
import { CashBox } from './cash-box.entity';
import { CashCategory } from './cash-category.entity';
import { CashSession } from './cash-session.entity';

/**
 * Libro de movimientos de caja. De SOLO AGREGAR: un disparador de la base
 * rechaza todo `UPDATE` y `DELETE`, y una corrección es otro movimiento
 * (`reversesMovementId`). El saldo de la caja es `Σ entradas − Σ salidas`.
 */
@ForeignKey(
  () => CashBox,
  ['cash_box_id', 'distributor_id'],
  ['cash_box_id', 'distributor_id'],
  { name: 'FK_cash_movement_cash_box_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => CashSession,
  ['session_id', 'distributor_id'],
  ['session_id', 'distributor_id'],
  { name: 'FK_cash_movement_session_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => CashCategory,
  ['category_id', 'distributor_id'],
  ['category_id', 'distributor_id'],
  { name: 'FK_cash_movement_category_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => CashMovement,
  ['reverses_movement_id', 'distributor_id'],
  ['movement_id', 'distributor_id'],
  {
    name: 'FK_cash_movement_reverses_movement_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_cash_movement_id_distribuidora', ['movementId', 'distributorId'])
@Entity('cash_movement')
@Check('CHK_cash_movement_importe', '"amount" > 0')
@Check(
  'CHK_cash_movement_autor',
  `"created_by_user_id" IS NOT NULL OR "reference_type" IN ('payment', 'payment_fee', 'payment_refund', 'payment_external_refund')`,
)
@Index('IDX_cash_movement_caja_fecha', ['cashBoxId', 'occurredAt'])
@Index('IDX_cash_movement_distribuidora_fecha', ['distributorId', 'occurredAt'])
@Index('IDX_cash_movement_referencia', ['referenceType', 'referenceId'])
@Index('IDX_cash_movement_sesion', ['sessionId'])
@Index('UQ_cash_movement_cobro_de_venta', ['referenceType', 'referenceId'], {
  unique: true,
  where: `"reference_type" IN ('payment', 'payment_fee', 'payment_refund', 'order_transfer', 'order_deposit')`,
})
@Index('UQ_cash_movement_anula', ['reversesMovementId'], {
  unique: true,
  where: '"reverses_movement_id" IS NOT NULL',
})
export class CashMovement {
  @PrimaryGeneratedColumn('uuid', { name: 'movement_id' })
  movementId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => CashBox, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cash_box_id' })
  cashBox?: CashBox;

  @Column({ name: 'cash_box_id', type: 'uuid' })
  cashBoxId!: string;

  /** Obligatoria si la caja exige sesión (lo valida el servicio). */
  @ManyToOne(() => CashSession, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'session_id' })
  session?: CashSession | null;

  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId!: string | null;

  @Column({ type: 'enum', enum: CashDirection })
  direction!: CashDirection;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;

  @ManyToOne(() => CashCategory, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category?: CashCategory;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId!: string;

  @Column({ type: 'enum', enum: CashMethod, default: CashMethod.CASH })
  method!: CashMethod;

  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'now()' })
  occurredAt!: Date;

  @Column({ type: 'varchar', length: 255 })
  description!: string;

  @Column({
    name: 'reference_type',
    type: 'enum',
    enum: CashReferenceType,
    default: CashReferenceType.MANUAL,
  })
  referenceType!: CashReferenceType;

  /**
   * Documento que originó el movimiento (rendición, liquidación, pago…).
   * Sin clave foránea a propósito: apunta a tablas de distintos módulos según
   * `referenceType`.
   */
  @Column({ name: 'reference_id', type: 'uuid', nullable: true })
  referenceId!: string | null;

  /** El movimiento que este anula; único: un movimiento se anula una sola vez. */
  @ManyToOne(() => CashMovement, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reverses_movement_id' })
  reverses?: CashMovement | null;

  @Column({ name: 'reverses_movement_id', type: 'uuid', nullable: true })
  reversesMovementId!: string | null;

  /** Quién lo registró; `null` sólo en los movimientos que se asientan solos (webhook, devolución). */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
