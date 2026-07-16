import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

@Entity('delivery')
export class Delivery {
  @PrimaryGeneratedColumn('uuid', { name: 'delivery_id' })
  delivery_id: string;

  /** Distribuidora para la que trabaja el chofer. Nullable hasta backfill. */
  @Index()
  @ManyToOne(() => Distributor, { nullable: false })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'uuid', nullable: false })
  distributor_id?: string;

  @OneToOne(() => User, (user) => user.delivery, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  // Indexado: el radar/dispatch y varios findOne buscan al chofer por user_id.
  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'double precision', nullable: true })
  calification?: number;

  @Column({ type: 'text', nullable: true })
  latLng?: string;

  @Column({ type: 'text', nullable: true })
  actual_location?: string;

  @Column({ type: 'real', nullable: true })
  cancelledCharge?: number;

  @Column({ type: 'boolean', default: false })
  validated: boolean;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  /** Token FCM del dispositivo del chofer, para push de ofertas/estado. */
  @Column({ type: 'text', nullable: true })
  notification_token?: string;

  @Column({ type: 'text', nullable: true })
  isTraveling?: string;

  @Column({ type: 'double precision', default: 0 })
  balance: number;

  @CreateDateColumn({ type: 'timestamptz', nullable: true })
  createdAt?: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
