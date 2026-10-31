import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Unique,
  Check,
  Index,
} from 'typeorm';
import { RouteBatch } from './route-batch.entity';
import { Order } from './order.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

/**
 * Parada del lote
 * Cada pedido del lote, en su orden de entrega.
 * Casos: CU-107 (M4)
 */
@Check('CHK_route_batch_stop_secuencia', `"sequence" >= 1`)
@Check('CHK_route_batch_stop_tramo', `"leg_distance_km" >= 0`)
@Index('UQ_route_batch_stop_secuencia', ['batchId', 'sequence'], {
  unique: true,
})
@Index('UQ_route_batch_stop_pedido_activo', ['orderId'], {
  unique: true,
  where: '"active"',
})
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

  /**
   * La parada sigue en un lote vivo. Pasa a `false` cuando el lote se deshace o
   * se completa, o cuando el pedido sale del lote; el índice único parcial
   * garantiza que un pedido esté en un solo lote vivo a la vez.
   */
  @Column({ name: 'active', type: 'boolean', nullable: false, default: true })
  active!: boolean;

  /** Llegada estimada a la parada (velocidad media y tiempo de servicio fijos). */
  @Column({ name: 'eta_at', type: 'timestamptz', nullable: true })
  etaAt!: Date | null;

  /** Kilómetros desde la parada anterior (la primera, desde el punto de partida: 0). */
  @Column({
    name: 'leg_distance_km',
    type: 'decimal',
    precision: 8,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: false,
    default: 0,
  })
  legDistanceKm!: number;
}
