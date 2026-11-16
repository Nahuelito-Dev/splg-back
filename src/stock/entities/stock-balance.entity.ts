import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ForeignKey,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { StockCondition } from '../domain/stock.enums';
import { StockLocation } from './stock-location.entity';

/**
 * Saldo materializado: cuántas garrafas de un tipo y condición hay en una
 * ubicación. Es la suma de sus movimientos, y la actualiza SÓLO el
 * `StockLedgerService` en la misma transacción que inserta el movimiento.
 * Nunca negativo, ni siquiera en un camión.
 */
@ForeignKey(
  () => StockLocation,
  ['location_id', 'distributor_id'],
  ['location_id', 'distributor_id'],
  { name: 'FK_stock_balance_location_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => GasCylinder,
  ['gas_cylinder_id', 'distributor_id'],
  ['gas_cylinder_id', 'distributor_id'],
  {
    name: 'FK_stock_balance_gas_cylinder_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Entity('stock_balance')
@Index(
  'UQ_stock_balance_ubicacion_garrafa_condicion',
  ['locationId', 'gasCylinderId', 'condition'],
  { unique: true },
)
@Check('CHK_stock_balance_no_negativo', '"quantity" >= 0')
export class StockBalance {
  @PrimaryGeneratedColumn('uuid', { name: 'balance_id' })
  balanceId!: string;

  @Index('IDX_stock_balance_distributor')
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => StockLocation, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'location_id' })
  location?: StockLocation;

  @Column({ name: 'location_id', type: 'uuid' })
  locationId!: string;

  @Index('IDX_stock_balance_gas_cylinder')
  @ManyToOne(() => GasCylinder, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder;

  @Column({ name: 'gas_cylinder_id', type: 'uuid' })
  gasCylinderId!: string;

  @Column({
    type: 'enum',
    enum: StockCondition,
    enumName: 'stock_condition_enum',
  })
  condition!: StockCondition;

  @Column({ type: 'int', default: 0 })
  quantity!: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
