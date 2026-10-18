import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CashCategory } from '../../cash/entities/cash-category.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { DriverSettlement } from './driver-settlement.entity';

/** Gasto que el chofer pagó con la cobranza y declara al presentar la rendición. */
@Entity('driver_settlement_expense')
@Check('CHK_driver_settlement_expense_importe', '"amount" > 0')
export class DriverSettlementExpense {
  @PrimaryGeneratedColumn('uuid', { name: 'expense_id' })
  expenseId!: string;

  @Index('IDX_driver_settlement_expense_rendicion')
  @ManyToOne(() => DriverSettlement, (s) => s.expenses, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'settlement_id' })
  settlement?: DriverSettlement;

  @Column({ name: 'settlement_id', type: 'uuid' })
  settlementId!: string;

  @ManyToOne(() => CashCategory, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category?: CashCategory;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId!: string;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;
}
