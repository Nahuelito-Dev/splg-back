// order/entities/order-item.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Check,
  Index,
} from 'typeorm';
import { Order } from './order.entity';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

@Check('CHK_order_item_cantidad', `"quantity" > 0`)
@Check('CHK_order_item_importes', `"unitPrice" >= 0 AND "subtotal" >= 0`)
@Check(
  'CHK_order_item_envases_cobrados',
  `"containers_charged" >= 0 AND "containers_charged" <= "quantity" AND ("containers_charged" = 0 OR "container_unit_price" > 0)`,
)
@Index('UQ_order_item_pedido_producto', ['orderId', 'gasCylinderId'], {
  unique: true,
})
@Entity('order_item')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid', { name: 'order_item_id' })
  orderItemId!: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({
    name: 'order_id',
    type: 'uuid',
  })
  orderId!: string;

  @ManyToOne(() => GasCylinder)
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder!: GasCylinder;

  @Column({
    name: 'gas_cylinder_id',
    type: 'uuid',
  })
  gasCylinderId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  unitPrice!: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  subtotal!: number;

  @Column({ name: 'containers_charged', type: 'int', default: 0 })
  containersCharged!: number;

  @Column({
    name: 'container_unit_price',
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: columnNumericTransformer,
  })
  containerUnitPrice!: number | null;
}
