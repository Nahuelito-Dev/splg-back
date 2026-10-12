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
import { PurchaseOrder } from './purchase-order.entity';

/**
 * Renglón de una orden de compra: cuántas llenas se piden de un tipo, a qué
 * costo y cuántos vacíos se canjean con la planta. `received_quantity` lo
 * mueve sólo la recepción y nunca pasa de lo pedido.
 */
@Entity('purchase_order_item')
@Index('UQ_purchase_order_item_garrafa', ['purchaseOrderId', 'gasCylinderId'], {
  unique: true,
})
@Check('CHK_purchase_order_item_cantidad', '"quantity" > 0')
@Check('CHK_purchase_order_item_vacios', '"empties_to_exchange" >= 0')
@Check(
  'CHK_purchase_order_item_recibido',
  '"received_quantity" >= 0 AND "received_quantity" <= "quantity"',
)
@Check('CHK_purchase_order_item_costo', '"unit_cost" >= 0')
export class PurchaseOrderItem {
  @PrimaryGeneratedColumn('uuid', { name: 'item_id' })
  itemId!: string;

  @ManyToOne(() => PurchaseOrder, (o) => o.items, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder?: PurchaseOrder;

  @Column({ name: 'purchase_order_id', type: 'uuid' })
  purchaseOrderId!: string;

  @Index('IDX_purchase_order_item_garrafa')
  @ManyToOne(() => GasCylinder, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder;

  @Column({ name: 'gas_cylinder_id', type: 'uuid' })
  gasCylinderId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({
    name: 'unit_cost',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  unitCost!: number;

  /** Vacíos que se entregan a la planta a cambio de las llenas. */
  @Column({ name: 'empties_to_exchange', type: 'int', default: 0 })
  emptiesToExchange!: number;

  @Column({ name: 'received_quantity', type: 'int', default: 0 })
  receivedQuantity!: number;
}
