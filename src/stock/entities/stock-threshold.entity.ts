import {
  Check,
  Column,
  CreateDateColumn,
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
import { Warehouse } from './warehouse.entity';

/**
 * Mínimo de garrafas llenas de un tipo en un depósito. El cron diario avisa a
 * los administradores cuando queda por debajo; `alertedAt` evita repetir el
 * aviso hasta que el depósito se recupera.
 */
@ForeignKey(
  () => Warehouse,
  ['warehouse_id', 'distributor_id'],
  ['warehouse_id', 'distributor_id'],
  {
    name: 'FK_stock_threshold_warehouse_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => GasCylinder,
  ['gas_cylinder_id', 'distributor_id'],
  ['gas_cylinder_id', 'distributor_id'],
  {
    name: 'FK_stock_threshold_gas_cylinder_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Entity('stock_threshold')
@Index(
  'UQ_stock_threshold_deposito_garrafa',
  ['warehouseId', 'gasCylinderId'],
  {
    unique: true,
  },
)
@Check('CHK_stock_threshold_minimo', '"min_full" >= 0')
export class StockThreshold {
  @PrimaryGeneratedColumn('uuid', { name: 'threshold_id' })
  thresholdId!: string;

  @Index('IDX_stock_threshold_distributor')
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => Warehouse, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'warehouse_id' })
  warehouse?: Warehouse;

  @Column({ name: 'warehouse_id', type: 'uuid' })
  warehouseId!: string;

  @ManyToOne(() => GasCylinder, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder;

  @Column({ name: 'gas_cylinder_id', type: 'uuid' })
  gasCylinderId!: string;

  @Column({ name: 'min_full', type: 'int' })
  minFull!: number;

  @Column({ name: 'alerted_at', type: 'timestamptz', nullable: true })
  alertedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
