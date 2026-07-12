import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Order } from './order.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

/**
 * Estado de una oferta de pedido a UN chofer.
 *  - OFFERED  : ofrecido, esperando respuesta (vence en `expiresAt`).
 *  - ACCEPTED : el chofer la tomó (el pedido pasa a ACCEPTED).
 *  - REJECTED : el chofer la rechazó → se ofrece al siguiente.
 *  - EXPIRED  : venció sin respuesta → se ofrece al siguiente.
 */
export enum DispatchOfferStatus {
  OFFERED = 'offered',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

/**
 * Oferta secuencial de un pedido a un chofer (una fila por intento). Es el
 * registro DURABLE del despacho: quién recibió la oferta, cuándo y hasta cuándo.
 * Permite (1) ofrecer al más cercano con timeout de 30s, (2) al vencer/rechazar
 * pasar al siguiente sin re-ofrecer a los ya contactados, y (3) auditar el
 * proceso para disputas/analytics. Reemplaza el broadcast a todos sin estado.
 */
@Entity('order_dispatch_offer')
export class DispatchOffer {
  @PrimaryGeneratedColumn('uuid', { name: 'offer_id' })
  offer_id: string;

  /** Tenant dueño del despacho (denormalizado desde la orden). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  distributor_id?: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Index()
  @Column({ type: 'uuid' })
  order_id: string;

  /** ID del chofer al que se ofreció = `user_id` (el mismo que usa el GEO/WS). */
  @Column({ type: 'uuid' })
  driver_id: string;

  @Index()
  @Column({
    type: 'enum',
    enum: DispatchOfferStatus,
    default: DispatchOfferStatus.OFFERED,
  })
  status: DispatchOfferStatus;

  /**
   * Momento hasta el cual la oferta es válida (offered_at + TTL). timestamptz
   * (UTC) para que la comparación `expiresAt < now()` del cron sea correcta sin
   * importar la TZ del servidor — con `timestamp` naive el timeout se rompe.
   */
  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  offeredAt: Date;
}
