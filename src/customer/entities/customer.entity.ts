import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
  Point,
  ManyToOne,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

@Entity('customer')
export class Customer {
  @PrimaryGeneratedColumn('uuid', { name: 'customer_id' })
  customer_id!: string;

  @OneToOne(() => User, (user) => user.customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'text', nullable: true })
  notification_token!: string | null;

  /** Última ubicación conocida (antes texto "lat,lng" en lat_lang). */
  @Index({ spatial: true })
  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  location!: Point | null;

  /** Si la distribuidora aprobó al cliente. Era texto 'true'/'false'. */
  @Column({ type: 'boolean', default: false })
  validated!: boolean;

  @CreateDateColumn({ type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({
    name: 'avg_monthly_consumption_kg',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  avg_monthly_consumption_kg!: number | null;

  @Column({ name: 'declared_cylinder_type_id', type: 'uuid', nullable: true })
  declared_cylinder_type_id!: string | null;

  @ManyToOne(() => GasCylinder, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'declared_cylinder_type_id' })
  declaredCylinderType?: GasCylinder;

  @Column({
    name: 'repurchase_notice_days',
    type: 'integer',
    nullable: true,
    default: 3,
  })
  repurchase_notice_days!: number | null;

  @Column({
    name: 'next_repurchase_estimate_at',
    type: 'timestamptz',
    nullable: true,
  })
  next_repurchase_estimate_at!: Date | null;
}
