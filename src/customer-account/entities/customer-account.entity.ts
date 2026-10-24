import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import {
  CustomerAccountStatus,
  TaxCondition,
} from '../domain/customer-account.enums';

/**
 * Cuenta corriente de un cliente con UNA distribuidora. El cliente de SPLG es
 * una persona compartida entre distribuidoras, así que la deuda, el límite y el
 * plazo son de cada relación comercial y la cuenta vive acá y no en `customer`.
 * `balance` positivo es lo que el cliente debe; lo mueve el libro de asientos.
 */
@Check('CHK_customer_account_plazo_maximo', `"payment_terms_days" <= 365`)
@Check(
  'CHK_customer_account_cerrada_sin_saldo',
  `"status" <> 'closed' OR "balance" = 0`,
)
@Check(
  'CHK_customer_account_cuit',
  `"tax_id" IS NULL OR es_cuit_valido("tax_id")`,
)
@Unique('UQ_customer_account_id_distribuidora', ['accountId', 'distributorId'])
@Entity('customer_account')
@Index(
  'UQ_customer_account_cliente_vigente',
  ['distributorId', 'customerUserId'],
  {
    unique: true,
    where: '"deletedAt" IS NULL',
  },
)
@Check('CHK_customer_account_limite', '"credit_limit" >= 0')
@Check('CHK_customer_account_plazo', '"payment_terms_days" > 0')
export class CustomerAccount {
  @PrimaryGeneratedColumn('uuid', { name: 'account_id' })
  accountId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Index('IDX_customer_account_distributor')
  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_user_id' })
  customer?: User;

  @Column({ name: 'customer_user_id', type: 'uuid' })
  customerUserId!: string;

  @Column({ name: 'business_name', type: 'varchar', length: 120 })
  businessName!: string;

  /** CUIT: once dígitos, sin guiones. */
  @Column({ name: 'tax_id', type: 'varchar', length: 11, nullable: true })
  taxId!: string | null;

  @Column({ name: 'tax_condition', type: 'enum', enum: TaxCondition })
  taxCondition!: TaxCondition;

  @Column({
    name: 'credit_limit',
    type: 'decimal',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: columnNumericTransformer,
  })
  creditLimit!: number;

  @Column({ name: 'payment_terms_days', type: 'int', default: 30 })
  paymentTermsDays!: number;

  @Column({
    type: 'enum',
    enum: CustomerAccountStatus,
    default: CustomerAccountStatus.ACTIVE,
  })
  status!: CustomerAccountStatus;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: columnNumericTransformer,
  })
  balance!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;
}
