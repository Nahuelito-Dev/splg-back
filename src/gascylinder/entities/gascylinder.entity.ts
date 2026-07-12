// gas-cylinder/entities/gas-cylinder.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

@Entity('gas_cylinder')
export class GasCylinder {
  @PrimaryGeneratedColumn('uuid', { name: 'gas_cylinder_id' })
  gas_cylinder_id: string;

  /** Tenant dueño de este producto. Nullable hasta backfill del seed. */
  @Index()
  @ManyToOne(() => Distributor, { nullable: true })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'uuid', nullable: true })
  distributor_id?: string;

  @Column({ type: 'varchar', length: 50 })
  type: string; // '10kg', '15kg', '45kg'

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  weight: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ type: 'int', default: 0 })
  stock: number;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'jsonb', nullable: true })
  promotions: { quantity: number; discountPercentage: number }[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
