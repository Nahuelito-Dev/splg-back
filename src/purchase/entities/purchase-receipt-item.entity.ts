import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { PurchaseReceipt } from './purchase-receipt.entity';

/** Renglón de un remito: llenas que entraron y vacías que se llevó la planta. */
@Entity('purchase_receipt_item')
@Index('UQ_purchase_receipt_item_garrafa', ['receiptId', 'gasCylinderId'], {
  unique: true,
})
@Check(
  'CHK_purchase_receipt_item_cantidades',
  '"quantity_full" >= 0 AND "quantity_empty_out" >= 0 AND ("quantity_full" + "quantity_empty_out") > 0',
)
@Check('CHK_purchase_receipt_item_costo', '"unit_cost" >= 0')
export class PurchaseReceiptItem {
  @PrimaryGeneratedColumn('uuid', { name: 'item_id' })
  itemId!: string;

  @ManyToOne(() => PurchaseReceipt, (r) => r.items, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'receipt_id' })
  receipt?: PurchaseReceipt;

  @Column({ name: 'receipt_id', type: 'uuid' })
  receiptId!: string;

  @Index('IDX_purchase_receipt_item_garrafa')
  @ManyToOne(() => GasCylinder, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder;

  @Column({ name: 'gas_cylinder_id', type: 'uuid' })
  gasCylinderId!: string;

  @Column({ name: 'quantity_full', type: 'int' })
  quantityFull!: number;

  @Column({ name: 'quantity_empty_out', type: 'int', default: 0 })
  quantityEmptyOut!: number;

  /** Costo promedio de la garrafa justo antes de esta recepción (para deshacerlo al anular). */
  @Column({
    name: 'previous_average_cost',
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: columnNumericTransformer,
  })
  previousAverageCost!: number | null;

  /** Llenas en depósitos y camiones justo antes de esta recepción. */
  @Column({ name: 'previous_on_hand', type: 'int', nullable: true })
  previousOnHand!: number | null;

  @Column({
    name: 'unit_cost',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  unitCost!: number;
}
