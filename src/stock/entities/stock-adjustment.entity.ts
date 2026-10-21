import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Check,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { StockAdjustmentReason } from '../domain/stock.enums';
import { StockAdjustmentItem } from './stock-adjustment-item.entity';
import { StockLocation } from './stock-location.entity';

/**
 * Cabecera de un ajuste de stock (corrección de conteo, merma, fuga, rotura,
 * pérdida, hallazgo o conteo inicial). La nota es obligatoria y el número es
 * correlativo por distribuidora (`document_sequence`). No se edita: un error
 * se corrige con otro ajuste.
 */
@Check('CHK_stock_adjustment_notas', `btrim("notes") <> ''`)
@Entity('stock_adjustment')
@Index('UQ_stock_adjustment_numero', ['distributorId', 'number'], {
  unique: true,
})
@Index('IDX_stock_adjustment_fecha', ['distributorId', 'createdAt'])
export class StockAdjustment {
  @PrimaryGeneratedColumn('uuid', { name: 'adjustment_id' })
  adjustmentId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'int' })
  number!: number;

  @Index('IDX_stock_adjustment_ubicacion')
  @ManyToOne(() => StockLocation, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'location_id' })
  location?: StockLocation;

  @Column({ name: 'location_id', type: 'uuid' })
  locationId!: string;

  @Column({ type: 'enum', enum: StockAdjustmentReason })
  reason!: StockAdjustmentReason;

  @Column({ type: 'text' })
  notes!: string;

  /** El lote del libro de movimientos que generó este ajuste. */
  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  @OneToMany(() => StockAdjustmentItem, (item) => item.adjustment)
  items?: StockAdjustmentItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
