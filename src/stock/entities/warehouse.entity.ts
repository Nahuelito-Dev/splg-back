import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Check,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { WarehouseKind } from '../domain/stock.enums';

/**
 * Depósito de una distribuidora (galpón, sucursal). Baja lógica: sólo se da de
 * baja sin saldo y si no es el predeterminado. Los índices únicos son los
 * "vigentes": un depósito dado de baja no bloquea reutilizar su código.
 */
@Check('CHK_warehouse_codigo', `"code" ~ '^[A-Z0-9_-]{1,12}$'`)
@Entity('warehouse')
@Index('UQ_warehouse_code_vigente', ['distributorId', 'code'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
@Index('UQ_warehouse_default_vigente', ['distributorId'], {
  unique: true,
  where: '"is_default" AND "deletedAt" IS NULL',
})
export class Warehouse {
  @PrimaryGeneratedColumn('uuid', { name: 'warehouse_id' })
  warehouseId!: string;

  @Index('IDX_warehouse_distributor')
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'varchar', length: 12 })
  code!: string;

  @Column({ type: 'enum', enum: WarehouseKind, default: WarehouseKind.DEPOT })
  kind!: WarehouseKind;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;
}
