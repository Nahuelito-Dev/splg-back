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

/** Por qué una parada salió de su hoja (`route_batch_stop.removed_reason`). */
export enum RouteStopRemovedReason {
  CANCELLED = 'cancelled',
  MOVED = 'moved',
  REASSIGNED = 'reassigned',
  FAILED_DELIVERY = 'failed_delivery',
  ADMIN = 'admin',
  UNAVAILABLE = 'unavailable',
  /** Quedó pendiente cuando se cerró a mano la hoja en curso: espera al admin. */
  SHEET_CLOSED = 'sheet_closed',
  /** No se entregó en el segundo intento: el sistema lo reprogramó para el día hábil siguiente. */
  RESCHEDULED = 'rescheduled',
  /** Salió de la hoja en la calle y espera al admin (se liberó por fuera de la hoja, o no se pudo reprogramar). */
  NEEDS_RESCHEDULE = 'needs_reschedule',
}

/**
 * Parada del lote
 * Cada pedido del lote, en su orden de entrega.
 * Casos: CU-107 (M4)
 */
@Check('CHK_route_batch_stop_secuencia', `"sequence" >= 1`)
@Check('CHK_route_batch_stop_tramo', `"leg_distance_km" >= 0`)
@Check(
  'CHK_route_batch_stop_ventana',
  `("notified_window_start" IS NULL) = ("notified_window_end" IS NULL) AND ("notified_window_start" IS NULL OR "notified_window_start" < "notified_window_end")`,
)
@Check(
  'CHK_route_batch_stop_salida',
  `("removed_reason" IS NULL) = ("removed_at" IS NULL)`,
)
@Check(
  'CHK_route_batch_stop_tramo_min',
  `"leg_duration_min" IS NULL OR "leg_duration_min" >= 0`,
)
@Check(
  'CHK_route_batch_stop_intentos',
  `"failed_attempts" BETWEEN 0 AND 2 AND ("failed_attempts" = 0) = ("last_failed_at" IS NULL)`,
)
@Check(
  'CHK_route_batch_stop_nota',
  `"removed_note" IS NULL OR "removed_reason" IS NOT NULL`,
)
@Index('UQ_route_batch_stop_secuencia', ['batchId', 'sequence'], {
  unique: true,
  where: '"active"',
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

  /** ETA congelada al confirmar la hoja (lo prometido); `etaAt` es la vigente. */
  @Column({ name: 'planned_eta_at', type: 'timestamptz', nullable: true })
  plannedEtaAt!: Date | null;

  /** Minutos desde la parada anterior, según la matriz. */
  @Column({
    name: 'leg_duration_min',
    type: 'decimal',
    precision: 6,
    scale: 1,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  legDurationMin!: number | null;

  /** El administrador fijó la posición: el optimizador no la mueve. */
  @Column({
    name: 'sequence_locked',
    type: 'boolean',
    nullable: false,
    default: false,
  })
  sequenceLocked!: boolean;

  /** Franja estimada que se le avisó al cliente. */
  @Column({
    name: 'notified_window_start',
    type: 'timestamptz',
    nullable: true,
  })
  notifiedWindowStart!: Date | null;

  @Column({ name: 'notified_window_end', type: 'timestamptz', nullable: true })
  notifiedWindowEnd!: Date | null;

  @Column({ name: 'notified_at', type: 'timestamptz', nullable: true })
  notifiedAt!: Date | null;

  @Column({
    name: 'removed_reason',
    type: 'enum',
    enum: RouteStopRemovedReason,
    nullable: true,
  })
  removedReason!: RouteStopRemovedReason | null;

  @Column({ name: 'removed_at', type: 'timestamptz', nullable: true })
  removedAt!: Date | null;

  /** Lo que contó el chofer al no poder entregar (o quien sacó la parada). */
  @Column({
    name: 'removed_note',
    type: 'varchar',
    length: 300,
    nullable: true,
  })
  removedNote!: string | null;

  /** Cuándo avisó «Llegué» en la hoja en curso (se borra si la parada vuelve a la cola). */
  @Column({ name: 'arrived_at', type: 'timestamptz', nullable: true })
  arrivedAt!: Date | null;

  /** Ya se avisó que venció la espera en la puerta (`arrivalWaitMinutes`). */
  @Column({ name: 'wait_alerted_at', type: 'timestamptz', nullable: true })
  waitAlertedAt!: Date | null;

  /** Intentos de entrega fallidos (0 a 2): al primero vuelve al final de la cola; al segundo, al admin. */
  @Column({
    name: 'failed_attempts',
    type: 'smallint',
    nullable: false,
    default: 0,
  })
  failedAttempts!: number;

  @Column({ name: 'last_failed_at', type: 'timestamptz', nullable: true })
  lastFailedAt!: Date | null;

  /** Lo que contó el chofer en el último intento fallido. */
  @Column({
    name: 'last_failure_note',
    type: 'varchar',
    length: 300,
    nullable: true,
  })
  lastFailureNote!: string | null;
}
