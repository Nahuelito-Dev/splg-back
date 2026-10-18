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
  UpdateDateColumn,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { CashBoxKind } from '../domain/cash.enums';

/**
 * Caja ("cuenta de fondos") de una distribuidora: efectivo, banco o billetera.
 * `balance` es el saldo que el libro (`cash_movement`) le da: solo lo mueve
 * `CashLedgerService`. Una caja de efectivo no puede quedar en negativo.
 */
@Entity('cash_box')
@Index('UQ_cash_box_nombre_vigente', ['distributorId', 'name'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
@Check(
  'CHK_cash_box_efectivo_no_negativo',
  `"kind" <> 'cash' OR "balance" >= 0`,
)
export class CashBox {
  @PrimaryGeneratedColumn('uuid', { name: 'cash_box_id' })
  cashBoxId!: string;

  @Index('IDX_cash_box_distributor')
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'enum', enum: CashBoxKind })
  kind!: CashBoxKind;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: columnNumericTransformer,
  })
  balance!: number;

  /** Si exige una sesión abierta (con arqueo al cerrar) para mover dinero. */
  @Column({ name: 'requires_session', type: 'boolean', default: false })
  requiresSession!: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;
}
