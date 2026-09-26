import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { RouteBatch } from './route-batch.entity';
import { Order } from './order.entity';

/**
 * Parada del lote
 * Cada pedido del lote, en su orden de entrega.
 * Casos: CU-107 (M3)
 */
@Entity('route_batch_stop')
@Unique('UQ_route_batch_stop_batch_order', ['batchId', 'orderId'])
export class RouteBatchStop {
  @PrimaryGeneratedColumn('uuid', { name: 'stop_id' })
  stopId!: string;

  @ManyToOne(() => RouteBatch, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batch_id' })
  batch!: RouteBatch;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @ManyToOne(() => Order, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'sequence', type: 'integer', nullable: false })
  sequence!: number;
}
