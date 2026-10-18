import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Order } from '../../order/entities/order.entity';
import { DriverSettlement } from './driver-settlement.entity';

/**
 * Pedido en efectivo que entró a una rendición. `order_id` es único: un pedido
 * se rinde una sola vez, aunque dos rendiciones lo vean pendiente.
 */
@Entity('driver_settlement_order')
@Index('UQ_driver_settlement_order_pedido', ['orderId'], { unique: true })
export class DriverSettlementOrder {
  @PrimaryGeneratedColumn('uuid', { name: 'settlement_order_id' })
  settlementOrderId!: string;

  @Index('IDX_driver_settlement_order_rendicion')
  @ManyToOne(() => DriverSettlement, (s) => s.orders, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'settlement_id' })
  settlement?: DriverSettlement;

  @Column({ name: 'settlement_id', type: 'uuid' })
  settlementId!: string;

  @ManyToOne(() => Order, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order?: Order;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  /** Lo que el chofer cobraba: el total menos la seña ya paga. */
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;

  /** Medio de pago del pedido al rendirlo (copia). */
  @Column({ name: 'payment_method', type: 'varchar', length: 20 })
  paymentMethod!: string;
}
