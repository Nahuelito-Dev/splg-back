import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('delivery')
export class Delivery {
  @PrimaryGeneratedColumn('uuid', { name: 'delivery_id' })
  delivery_id: string;

  @OneToOne(() => User, (user) => user.delivery, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

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

  @Column({ type: 'text', nullable: true })
  isTraveling?: string;

  @Column({ type: 'double precision', default: 0 })
  balance: number;

  @CreateDateColumn({ type: 'timestamptz', nullable: true })
  createdAt?: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
