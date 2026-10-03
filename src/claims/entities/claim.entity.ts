import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  JoinColumn,
  Index,
} from 'typeorm';
import { Order } from '../../order/entities/order.entity';
import { User } from '../../users/entities/user.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

export enum ClaimStatus {
  PENDING = 'pending',
  IN_PROCESS = 'in_process',
  RESOLVED = 'resolved',
  REJECTED = 'rejected',
}

@Entity('claims')
export class Claim {
  @PrimaryGeneratedColumn('uuid', { name: 'claim_id' })
  claimId!: string;

  /** Tenant dueño del reclamo (denormalizado desde la orden). */
  @Index()
  @ManyToOne(() => Distributor, { nullable: false })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({
    name: 'distributor_id',
    type: 'uuid',
    nullable: false,
  })
  distributorId!: string;

  // Relación con la Orden
  @ManyToOne(() => Order)
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ name: 'order_id' })
  orderId!: string;

  // Relación con el Cliente (Quien reclama)
  @ManyToOne(() => User)
  @JoinColumn({ name: 'customer_id' })
  customer!: User;

  @Column({ name: 'customer_id' })
  customerId!: string;

  @Column()
  reason!: string; // Ej: "Fuga de gas", "Mala atención"

  @Column('text')
  description!: string;

  /** URL externa que mandaban las apps antes de que la foto se subiera al storage. */
  @Column({ type: 'varchar', nullable: true })
  photoUrl!: string | null;

  /** Key de la foto en el storage (`claims/{distribuidora}/{reclamo}/{uuid}.{ext}`). */
  @Column({ name: 'photo_key', type: 'varchar', length: 512, nullable: true })
  photoKey!: string | null;

  @Column({
    type: 'enum',
    enum: ClaimStatus,
    default: ClaimStatus.PENDING,
  })
  status!: ClaimStatus;

  @Column({ type: 'text', nullable: true })
  resolutionNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
