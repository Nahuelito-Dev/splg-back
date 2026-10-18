import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CashMovement } from '../../cash/entities/cash-movement.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Order } from '../../order/entities/order.entity';
import { User } from '../../users/entities/user.entity';
import { CustomerEntryType } from '../domain/customer-account.enums';
import { CustomerAccount } from './customer-account.entity';

/**
 * Libro de la cuenta corriente. De SOLO AGREGAR: un disparador de la base
 * rechaza todo `UPDATE` y `DELETE`; un error se corrige con una nota de crédito
 * o de débito. El importe es siempre positivo y el signo lo da el tipo.
 */
@Entity('customer_account_entry')
@Check('CHK_customer_account_entry_importe', '"amount" > 0')
@Index('IDX_customer_account_entry_cuenta_fecha', ['accountId', 'occurredAt'])
@Index('UQ_customer_account_entry_cargo_pedido', ['orderId'], {
  unique: true,
  where: `"type" = 'sale_charge'`,
})
export class CustomerAccountEntry {
  @PrimaryGeneratedColumn('uuid', { name: 'entry_id' })
  entryId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Index('IDX_customer_account_entry_distributor')
  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => CustomerAccount, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'account_id' })
  account?: CustomerAccount;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ type: 'enum', enum: CustomerEntryType })
  type!: CustomerEntryType;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;

  /** Pedido al que corresponde el cargo (único por pedido). */
  @ManyToOne(() => Order, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order?: Order | null;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId!: string | null;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate!: string | null;

  @Column({
    name: 'payment_method',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  paymentMethod!: string | null;

  /** Entrada a caja de un pago registrado por el administrador. */
  @ManyToOne(() => CashMovement, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cash_movement_id' })
  cashMovement?: CashMovement | null;

  @Column({ name: 'cash_movement_id', type: 'uuid', nullable: true })
  cashMovementId!: string | null;

  /** Chofer que cobró en la calle: el dinero entra por su rendición, no por la caja. */
  @ManyToOne(() => Delivery, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'collected_by_delivery_id' })
  collectedByDelivery?: Delivery | null;

  @Column({ name: 'collected_by_delivery_id', type: 'uuid', nullable: true })
  collectedByDeliveryId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'now()' })
  occurredAt!: Date;

  /** `null` en los cargos que asienta el sistema al entregar. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
