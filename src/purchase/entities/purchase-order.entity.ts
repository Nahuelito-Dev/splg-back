import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Check,
  ForeignKey,
  Unique,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Warehouse } from '../../stock/entities/warehouse.entity';
import { User } from '../../users/entities/user.entity';
import { PurchaseOrderStatus } from '../domain/purchase.enums';
import { PurchaseOrderItem } from './purchase-order-item.entity';
import { Supplier } from './supplier.entity';

/**
 * Orden de compra a un proveedor. El número es correlativo por distribuidora
 * (`document_sequence`). Sólo se edita en borrador; el estado lo mueve el
 * dominio (`purchase-rules`) y la recepción de mercadería.
 */
@Check(
  'CHK_purchase_order_cancelada',
  `"status" <> 'cancelled' OR "cancel_reason" IS NOT NULL`,
)
@Check(
  'CHK_purchase_order_cerrada_corta',
  `"status" <> 'closed_short' OR "close_reason" IS NOT NULL`,
)
@Check(
  'CHK_purchase_order_emitida',
  `"status" IN ('draft', 'cancelled') OR "issued_at" IS NOT NULL`,
)
@Check('CHK_purchase_order_total', `"total_amount" >= 0`)
@ForeignKey(
  () => Supplier,
  ['supplier_id', 'distributor_id'],
  ['supplier_id', 'distributor_id'],
  {
    name: 'FK_purchase_order_supplier_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Warehouse,
  ['destination_warehouse_id', 'distributor_id'],
  ['warehouse_id', 'distributor_id'],
  {
    name: 'FK_purchase_order_destination_warehouse_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_purchase_order_id_distribuidora', [
  'purchaseOrderId',
  'distributorId',
])
@Check(
  'CHK_purchase_order_fecha_esperada',
  `"expected_date" IS NULL OR "expected_date" >= ("createdAt" AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`,
)
@Entity('purchase_order')
@Index('UQ_purchase_order_numero', ['distributorId', 'number'], {
  unique: true,
})
@Index('IDX_purchase_order_estado', ['distributorId', 'status'])
export class PurchaseOrder {
  @PrimaryGeneratedColumn('uuid', { name: 'purchase_order_id' })
  purchaseOrderId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'int' })
  number!: number;

  @Index('IDX_purchase_order_proveedor')
  @ManyToOne(() => Supplier, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ name: 'supplier_id', type: 'uuid' })
  supplierId!: string;

  @ManyToOne(() => Warehouse, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'destination_warehouse_id' })
  destinationWarehouse?: Warehouse;

  @Column({ name: 'destination_warehouse_id', type: 'uuid' })
  destinationWarehouseId!: string;

  @Column({
    type: 'enum',
    enum: PurchaseOrderStatus,
    default: PurchaseOrderStatus.DRAFT,
  })
  status!: PurchaseOrderStatus;

  @Column({ name: 'issued_at', type: 'timestamptz', nullable: true })
  issuedAt!: Date | null;

  /** Fecha calendario `YYYY-MM-DD`. */
  @Column({ name: 'expected_date', type: 'date', nullable: true })
  expectedDate!: string | null;

  @Column({
    name: 'total_amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: columnNumericTransformer,
  })
  totalAmount!: number;

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason!: string | null;

  /** Motivo del cierre con faltante (`closed_short`). */
  @Column({ name: 'close_reason', type: 'text', nullable: true })
  closeReason!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  @OneToMany(() => PurchaseOrderItem, (i) => i.purchaseOrder)
  items?: PurchaseOrderItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
