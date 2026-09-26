// order/entities/order-item.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

@Entity('order_item')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid', { name: 'order_item_id' })
  order_item_id!: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'uuid' })
  order_id!: string;

  @ManyToOne(() => GasCylinder)
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder!: GasCylinder;

  @Column({ type: 'uuid' })
  gas_cylinder_id!: string;

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
}
