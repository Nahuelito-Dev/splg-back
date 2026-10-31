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
  Check,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

@Check(
  'CHK_customer_consumo',
  `"avg_monthly_consumption_kg" IS NULL OR "avg_monthly_consumption_kg" > 0`,
)
@Check(
  'CHK_customer_aviso_recompra',
  `"repurchase_notice_days" IS NULL OR "repurchase_notice_days" BETWEEN 1 AND 30`,
)
@Entity('customer')
export class Customer {
  @PrimaryGeneratedColumn('uuid', { name: 'customer_id' })
  customerId!: string;

  @OneToOne(() => User, (user) => user.customer, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    name: 'user_id',
    type: 'uuid',
  })
  userId!: string;

  @Column({
    name: 'notification_token',
    type: 'text',
    nullable: true,
  })
  notificationToken!: string | null;

  /** Última ubicación conocida (antes texto "lat,lng" en lat_lang). */
  @Index({ spatial: true })
  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  location!: Point | null;

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
  avgMonthlyConsumptionKg!: number | null;

  @Column({ name: 'declared_cylinder_type_id', type: 'uuid', nullable: true })
  declaredCylinderTypeId!: string | null;

  @ManyToOne(() => GasCylinder, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'declared_cylinder_type_id' })
  declaredCylinderType?: GasCylinder;

  /** Días de anticipación que eligió el cliente (1 a 30); `null`: rige el valor de la distribuidora (CU-145). */
  @Column({
    name: 'repurchase_notice_days',
    type: 'integer',
    nullable: true,
  })
  repurchaseNoticeDays!: number | null;

  /** El cliente pidió no recibir el aviso de recompra (CU-145). */
  @Column({
    name: 'repurchase_notice_enabled',
    type: 'boolean',
    default: true,
  })
  repurchaseNoticeEnabled!: boolean;

  @Column({
    name: 'next_repurchase_estimate_at',
    type: 'timestamptz',
    nullable: true,
  })
  nextRepurchaseEstimateAt!: Date | null;
}
