import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { StockCondition } from '../domain/stock.enums';
import { StockAdjustment } from './stock-adjustment.entity';

/**
 * Renglón de un ajuste: cuánto cambia el saldo de un tipo y condición. En una
 * rotura el renglón es `full` con variación negativa: las llenas pasan a
 * defectuosas en la misma ubicación.
 */
@Entity('stock_adjustment_item')
@Index(
  'UQ_stock_adjustment_item_garrafa_condicion',
  ['adjustmentId', 'gasCylinderId', 'condition'],
  { unique: true },
)
@Check('CHK_stock_adjustment_item_variacion', '"quantity_delta" <> 0')
export class StockAdjustmentItem {
  @PrimaryGeneratedColumn('uuid', { name: 'item_id' })
  itemId!: string;

  @ManyToOne(() => StockAdjustment, (a) => a.items, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'adjustment_id' })
  adjustment?: StockAdjustment;

  @Column({ name: 'adjustment_id', type: 'uuid' })
  adjustmentId!: string;

  @ManyToOne(() => GasCylinder, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder;

  @Column({ name: 'gas_cylinder_id', type: 'uuid' })
  gasCylinderId!: string;

  @Column({
    type: 'enum',
    enum: StockCondition,
    enumName: 'stock_condition_enum',
  })
  condition!: StockCondition;

  @Column({ name: 'quantity_delta', type: 'int' })
  quantityDelta!: number;
}
