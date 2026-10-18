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
import { CustomerAccountEntry } from './customer-account-entry.entity';
import { CustomerAccount } from './customer-account.entity';

/**
 * Imputación FIFO de un pago o nota de crédito a un cargo. Alimenta la
 * antigüedad de la deuda y la lista de comprobantes impagos.
 */
@Entity('customer_account_allocation')
@Check('CHK_customer_account_allocation_importe', '"amount" > 0')
export class CustomerAccountAllocation {
  @PrimaryGeneratedColumn('uuid', { name: 'allocation_id' })
  allocationId!: string;

  @Index('IDX_customer_account_allocation_cuenta')
  @ManyToOne(() => CustomerAccount, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'account_id' })
  account?: CustomerAccount;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Index('IDX_customer_account_allocation_debito')
  @ManyToOne(() => CustomerAccountEntry, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'debit_entry_id' })
  debitEntry?: CustomerAccountEntry;

  @Column({ name: 'debit_entry_id', type: 'uuid' })
  debitEntryId!: string;

  @Index('IDX_customer_account_allocation_credito')
  @ManyToOne(() => CustomerAccountEntry, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'credit_entry_id' })
  creditEntry?: CustomerAccountEntry;

  @Column({ name: 'credit_entry_id', type: 'uuid' })
  creditEntryId!: string;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;
}
