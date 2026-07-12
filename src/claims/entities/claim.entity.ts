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
  @PrimaryGeneratedColumn('uuid')
  claim_id: string;

  /** Tenant dueño del reclamo (denormalizado desde la orden). */
  @Index()
  @ManyToOne(() => Distributor, { nullable: true })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'uuid', nullable: true })
  distributor_id?: string;

  // Relación con la Orden
  @ManyToOne(() => Order)
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column()
  order_id: string;

  // Relación con el Cliente (Quien reclama)
  @ManyToOne(() => User)
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column()
  customer_id: string;

  @Column()
  reason: string; // Ej: "Fuga de gas", "Mala atención"

  @Column('text')
  description: string;

  @Column({ nullable: true })
  photoUrl: string;

  @Column({
    type: 'enum',
    enum: ClaimStatus,
    default: ClaimStatus.PENDING,
  })
  status: ClaimStatus;

  @Column({ type: 'text', nullable: true })
  resolutionNote: string;

  @CreateDateColumn()
  createdAt: Date;
}
