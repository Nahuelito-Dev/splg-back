import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

@Check('CHK_customer_container_account_owned', '"owned" >= 0')
@Unique('UQ_customer_container_account_cliente_tipo', [
  'distributorId',
  'customerUserId',
  'gasCylinderId',
])
@Unique('UQ_customer_container_account_id_distribuidora', [
  'accountId',
  'distributorId',
])
@Index('IDX_customer_container_account_cliente', [
  'distributorId',
  'customerUserId',
])
@ForeignKey(
  () => GasCylinder,
  ['gas_cylinder_id', 'distributor_id'],
  ['gas_cylinder_id', 'distributor_id'],
  {
    name: 'FK_customer_container_account_gas_cylinder_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(() => Distributor, ['distributor_id'], ['distributor_id'], {
  name: 'FK_customer_container_account_distributor',
  onDelete: 'RESTRICT',
})
@ForeignKey(() => User, ['customer_user_id'], ['user_id'], {
  name: 'FK_customer_container_account_cliente',
  onDelete: 'RESTRICT',
})
@Entity('customer_container_account')
export class CustomerContainerAccount {
  @PrimaryGeneratedColumn('uuid', { name: 'account_id' })
  accountId!: string;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'customer_user_id', type: 'uuid' })
  customerUserId!: string;

  @Column({ name: 'gas_cylinder_id', type: 'uuid' })
  gasCylinderId!: string;

  @Column({ type: 'int', default: 0 })
  owned!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
