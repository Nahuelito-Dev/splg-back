import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  Check,
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

/** Por qué se deshizo un lote (`route_batch.close_reason`). */
export enum RouteBatchCloseReason {
  /** Ningún chofer candidato lo tomó: los pedidos vuelven al despacho individual (M1). */
  EXHAUSTED = 'exhausted',
  /** Quedó con menos de dos pedidos disponibles (se cancelaron o se asignaron aparte). */
  ORDERS_UNAVAILABLE = 'orders_unavailable',
  /** El administrador lo deshizo desde el panel. */
  ADMIN = 'admin',
}

/**
 * Lote de recorrido
 * Un grupo de pedidos que se entregan en un mismo viaje.
 * Casos: CU-107 (M4)
 */
@Check('CHK_route_batch_peso', `"total_weight_kg" >= 0`)
@Check(
  'CHK_route_batch_chofer',
  `"status" NOT IN ('assigned', 'completed') OR "delivery_id" IS NOT NULL`,
)
@Check(
  'CHK_route_batch_cierre',
  `("status" IN ('dissolved', 'completed')) = ("closed_at" IS NOT NULL)`,
)
@Check(
  'CHK_route_batch_motivo',
  `("status" = 'dissolved') = ("close_reason" IS NOT NULL)`,
)
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

  /** Cuándo se deshizo o se completó. */
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({
    name: 'close_reason',
    type: 'enum',
    enum: RouteBatchCloseReason,
    nullable: true,
  })
  closeReason!: RouteBatchCloseReason | null;
}
