import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { Order } from '../../order/entities/order.entity';
import { User } from '../../users/entities/user.entity';
import { CommissionEntryType } from '../domain/commission.enums';
import { CommissionRule } from './commission-rule.entity';
import { DriverLiquidation } from './driver-liquidation.entity';

/** Qué renglón del pedido se pagó con qué regla (copia al devengar). */
export interface ReglaAplicada {
  ruleId: string;
  basis: string;
  value: number;
  gasCylinderId: string | null;
  quantity: number;
  subtotal: number;
  amount: number;
}

/**
 * Libro de comisiones del chofer. Importe CON SIGNO: la comisión por entrega
 * suma y las deducciones (faltante de rendición, multas) restan. Es de solo
 * agregar; lo único que cambia es `liquidation_id` al liquidarse, y un
 * disparador de la base rechaza cualquier otro `UPDATE` y todo `DELETE`.
 */
@Entity('commission_entry')
@Index('IDX_commission_entry_empleado', ['employeeId', 'occurredAt'])
@Index('IDX_commission_entry_liquidacion', ['liquidationId'])
@Index('UQ_commission_entry_pedido', ['orderId'], {
  unique: true,
  where: `"type" = 'delivery_commission'`,
})
@Index('UQ_commission_entry_faltante', ['referenceId'], {
  unique: true,
  where: `"type" = 'settlement_shortage'`,
})
export class CommissionEntry {
  @PrimaryGeneratedColumn('uuid', { name: 'entry_id' })
  entryId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Index('IDX_commission_entry_distributor')
  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => Employee, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'employee_id' })
  employee?: Employee;

  @Column({ name: 'employee_id', type: 'uuid' })
  employeeId!: string;

  @ManyToOne(() => Delivery, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'delivery_id' })
  delivery?: Delivery | null;

  @Column({ name: 'delivery_id', type: 'uuid', nullable: true })
  deliveryId!: string | null;

  @Column({ type: 'enum', enum: CommissionEntryType })
  type!: CommissionEntryType;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;

  @ManyToOne(() => Order, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order?: Order | null;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId!: string | null;

  /** La regla con que se calculó, por si después se edita. */
  @ManyToOne(() => CommissionRule, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'rule_id' })
  rule?: CommissionRule | null;

  @Column({ name: 'rule_id', type: 'uuid', nullable: true })
  ruleId!: string | null;

  @Column({ name: 'rule_snapshot', type: 'jsonb', nullable: true })
  ruleSnapshot!: ReglaAplicada[] | null;

  @ManyToOne(() => DriverLiquidation, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'liquidation_id' })
  liquidation?: DriverLiquidation | null;

  @Column({ name: 'liquidation_id', type: 'uuid', nullable: true })
  liquidationId!: string | null;

  /**
   * Documento que originó la deducción (la rendición, la multa). Sin clave
   * foránea a propósito: apunta a tablas de distintos módulos según `type`.
   */
  @Column({ name: 'reference_id', type: 'uuid', nullable: true })
  referenceId!: string | null;

  @Column({ type: 'varchar', length: 255 })
  description!: string;

  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'now()' })
  occurredAt!: Date;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
