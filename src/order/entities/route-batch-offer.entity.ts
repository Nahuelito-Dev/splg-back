import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Check,
  Index,
  Unique,
} from 'typeorm';
import { RouteBatch } from './route-batch.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';

/**
 * Oferta de lote
 * El lote ofrecido a un chofer, con vigencia.
 * Casos: CU-107 (M4)
 */
@Check(
  'CHK_route_batch_offer_respuesta',
  `("status" = 'pending') = ("responded_at" IS NULL)`,
)
@Index('UQ_route_batch_offer_viva', ['batchId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
@Unique('UQ_route_batch_offer_batch_delivery', ['batchId', 'deliveryId'])
@Entity('route_batch_offer')
export class RouteBatchOffer {
  @PrimaryGeneratedColumn('uuid', { name: 'offer_id' })
  offerId!: string;

  @ManyToOne(() => RouteBatch, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batch_id' })
  batch!: RouteBatch;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @ManyToOne(() => Delivery, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'delivery_id' })
  delivery!: Delivery;

  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ProposalStatus,
    enumName: 'proposal_status_enum',
    nullable: false,
    default: ProposalStatus.PENDING,
  })
  status!: ProposalStatus;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: false })
  expiresAt!: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;
}
