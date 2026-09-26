import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

export enum RouteBatchStatus {
  FORMING = 'forming',
  OFFERED = 'offered',
  ASSIGNED = 'assigned',
  DISSOLVED = 'dissolved',
  COMPLETED = 'completed',
}

/**
 * Lote de recorrido
 * Un grupo de pedidos que se entregan en un mismo viaje.
 * Casos: CU-107 (M3)
 */
@Entity('route_batch')
export class RouteBatch {
  @PrimaryGeneratedColumn('uuid', { name: 'batch_id' })
  batchId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: RouteBatchStatus,

    nullable: false,
    default: RouteBatchStatus.FORMING,
  })
  status!: RouteBatchStatus;

  @Column({
    name: 'total_weight_kg',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: false,
  })
  totalWeightKg!: number;

  @ManyToOne(() => Delivery, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'delivery_id' })
  delivery?: Delivery;

  @Column({ name: 'delivery_id', type: 'uuid', nullable: true })
  deliveryId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
