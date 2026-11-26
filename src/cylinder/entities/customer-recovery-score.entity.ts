import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { RecoveryRiskBand } from '../recovery/domain/riesgo-de-recupero';

/**
 * Puntaje de riesgo de recupero (M5): por cliente y distribuidora, los casos
 * demorados históricos sobre los pedidos entregados, suavizado hacia un valor
 * neutro, y su banda. Lo reescribe la corrida diaria del recupero. Un cliente
 * sin casos no tiene fila: rige el puntaje neutro (banda media). El puntaje
 * cambia cuándo se avisa, nunca los importes.
 */
@Check(
  'CHK_customer_recovery_score_cantidades',
  `"delayed_cases" >= 0 AND "orders_total" >= 0`,
)
@Check('CHK_customer_recovery_score_puntaje', `"score" BETWEEN 0 AND 1`)
@Index(
  'UQ_customer_recovery_score_cliente',
  ['distributorId', 'customerUserId'],
  { unique: true },
)
@Entity('customer_recovery_score')
export class CustomerRecoveryScore {
  @PrimaryGeneratedColumn('uuid', { name: 'score_id' })
  scoreId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_user_id' })
  customer?: User;

  @Column({ name: 'customer_user_id', type: 'uuid' })
  customerUserId!: string;

  /** Casos de recupero que el cliente tuvo en la distribuidora (todos pasaron la tolerancia). */
  @Column({ name: 'delayed_cases', type: 'integer', nullable: false })
  delayedCases!: number;

  /** Pedidos entregados al cliente en la distribuidora. */
  @Column({ name: 'orders_total', type: 'integer', nullable: false })
  ordersTotal!: number;

  @Column({
    name: 'score',
    type: 'decimal',
    precision: 5,
    scale: 4,
    transformer: columnNumericTransformer,
    nullable: false,
  })
  score!: number;

  @Column({
    name: 'band',
    type: 'enum',
    enum: RecoveryRiskBand,
    enumName: 'recovery_risk_band_enum',
    nullable: false,
  })
  band!: RecoveryRiskBand;

  @Column({ name: 'updated_at', type: 'timestamptz', nullable: false })
  updatedAt!: Date;
}
