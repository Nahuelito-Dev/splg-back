import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  Check,
  ForeignKey,
} from 'typeorm';
import { Order } from './order.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Estado de una oferta de pedido a UN chofer.
 *  - OFFERED  : ofrecido, esperando respuesta (vence en `expiresAt`).
 *  - ACCEPTED : el chofer la tomó (el pedido pasa a ACCEPTED).
 *  - REJECTED : el chofer la rechazó → se ofrece al siguiente.
 *  - EXPIRED  : venció sin respuesta → se ofrece al siguiente.
 *  - SUPERSEDED: se retiró porque el pedido se editó, o porque se resolvió por
 *    otra vía (asignación manual del admin, otro chofer lo tomó del pool); no
 *    cuenta como intento del chofer (ni vencida ni bloqueo): puede recibir la
 *    oferta nueva.
 */
export enum DispatchOfferStatus {
  OFFERED = 'offered',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
  SUPERSEDED = 'superseded',
}

/** De dónde salió el tiempo estimado que se guardó en la oferta. */
export enum OfferEstimateSource {
  OSRM = 'osrm',
  HAVERSINE = 'haversine',
}

/**
 * Oferta secuencial de un pedido a un chofer (una fila por intento). Es el
 * registro DURABLE del despacho: quién recibió la oferta, cuándo y hasta cuándo.
 * Permite (1) ofrecer al más cercano con timeout de 30s, (2) al vencer/rechazar
 * pasar al siguiente sin re-ofrecer a los ya contactados, y (3) auditar el
 * proceso para disputas/analytics. Reemplaza el broadcast a todos sin estado.
 */
@Check('CHK_order_dispatch_offer_vencimiento', `"expiresAt" > "offeredAt"`)
@Check(
  'CHK_order_dispatch_offer_estimacion',
  `("estimated_minutes" IS NULL) = ("estimate_source" IS NULL) AND ("estimated_minutes" IS NULL OR "estimated_minutes" >= 0)`,
)
@Index('UQ_order_dispatch_offer_viva', { synchronize: false })
@Index('UQ_order_dispatch_offer_aceptada', { synchronize: false })
@ForeignKey(
  () => Order,
  ['order_id', 'distributor_id'],
  ['order_id', 'distributor_id'],
  {
    name: 'FK_order_dispatch_offer_order_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Entity('order_dispatch_offer')
// Composites para las queries del despacho:
//  - hasActiveOffer/closeActiveOffer (por pedido + estado)
@Index('idx_offer_order_status', ['orderId', 'status'])
//  - findExpired del cron (estado OFFERED vencido)
@Index('idx_offer_status_expires', ['status', 'expiresAt'])
export class DispatchOffer {
  @PrimaryGeneratedColumn('uuid', { name: 'offer_id' })
  offerId!: string;

  /** Tenant dueño del despacho (denormalizado desde la orden). */
  @Index()
  @Column({
    name: 'distributor_id',
    type: 'uuid',
    nullable: false,
  })
  distributorId?: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Index()
  @Column({
    name: 'order_id',
    type: 'uuid',
  })
  orderId!: string;

  /** ID del chofer al que se ofreció = `user_id` (el mismo que usa el GEO/WS). */
  @Column({
    name: 'driver_id',
    type: 'uuid',
  })
  driverId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'driver_id' })
  driver?: User;

  @Index()
  @Column({
    type: 'enum',
    enum: DispatchOfferStatus,
    default: DispatchOfferStatus.OFFERED,
  })
  status!: DispatchOfferStatus;

  /**
   * Momento hasta el cual la oferta es válida (offered_at + TTL). timestamptz
   * (UTC) para que la comparación `expiresAt < now()` del cron sea correcta sin
   * importar la TZ del servidor — con `timestamp` naive el timeout se rompe.
   */
  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  offeredAt!: Date;

  /**
   * Cuándo respondió el chofer (aceptó o rechazó). Nula mientras no responde,
   * en las vencidas y retiradas (no hay respuesta) y en lo anterior a la
   * columna, que no se puede reconstruir.
   */
  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  /**
   * Minutos que se estimó que el chofer tardaba en llegar al cliente cuando se
   * le ofreció (null: sin posición reciente, o anterior a la columna).
   */
  @Column({
    name: 'estimated_minutes',
    type: 'numeric',
    precision: 7,
    scale: 1,
    nullable: true,
    transformer: {
      to: (v: number | null | undefined) => v ?? null,
      from: (v: string | null) => (v === null ? null : Number(v)),
    },
  })
  estimatedMinutes!: number | null;

  /** Con qué se estimó: `osrm` por calles, `haversine` en línea recta de respaldo. */
  @Column({
    name: 'estimate_source',
    type: 'enum',
    enum: OfferEstimateSource,
    enumName: 'offer_estimate_source_enum',
    nullable: true,
  })
  estimateSource!: OfferEstimateSource | null;
}
