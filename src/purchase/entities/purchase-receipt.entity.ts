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
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Warehouse } from '../../stock/entities/warehouse.entity';
import { User } from '../../users/entities/user.entity';
import {
  PaymentStatus,
  PurchaseReceiptStatus,
  SupplierDocumentType,
} from '../domain/purchase.enums';
import { PurchaseOrder } from './purchase-order.entity';
import { PurchaseReceiptItem } from './purchase-receipt-item.entity';
import { Supplier } from './supplier.entity';
import { CashMovement } from '../../cash/entities/cash-movement.entity';

/**
 * Remito de ingreso: la mercadería que llegó del proveedor, con o sin orden de
 * compra. El número del documento del proveedor es único por proveedor. Al
 * confirmarse mueve el stock por el libro (`batch_id`); al anularse, un
 * contraasiento (`void_batch_id`).
 */
@Check('CHK_purchase_receipt_total', `"total_amount" >= 0`)
@Check(
  'CHK_purchase_receipt_anulada_fecha',
  `("status" = 'voided') = ("voided_at" IS NOT NULL)`,
)
@Check(
  'CHK_purchase_receipt_anulacion_datos',
  `"status" <> 'voided' OR ("void_reason" IS NOT NULL AND "voided_by_user_id" IS NOT NULL)`,
)
@ForeignKey(
  () => CashMovement,
  ['cash_movement_id', 'distributor_id'],
  ['movement_id', 'distributor_id'],
  {
    name: 'FK_purchase_receipt_cash_movement_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => PurchaseOrder,
  ['purchase_order_id', 'distributor_id'],
  ['purchase_order_id', 'distributor_id'],
  {
    name: 'FK_purchase_receipt_purchase_order_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Supplier,
  ['supplier_id', 'distributor_id'],
  ['supplier_id', 'distributor_id'],
  {
    name: 'FK_purchase_receipt_supplier_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Warehouse,
  ['warehouse_id', 'distributor_id'],
  ['warehouse_id', 'distributor_id'],
  {
    name: 'FK_purchase_receipt_warehouse_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Entity('purchase_receipt')
@Index('UQ_purchase_receipt_numero', ['distributorId', 'number'], {
  unique: true,
})
@Index(
  'UQ_purchase_receipt_documento_proveedor',
  [
    'distributorId',
    'supplierId',
    'supplierDocumentType',
    'supplierDocumentNumber',
  ],
  { unique: true },
)
@Index('IDX_purchase_receipt_fecha', ['distributorId', 'receivedAt'])
export class PurchaseReceipt {
  @PrimaryGeneratedColumn('uuid', { name: 'receipt_id' })
  receiptId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** Número interno correlativo por distribuidora. */
  @Column({ type: 'int' })
  number!: number;

  @Index('IDX_purchase_receipt_proveedor')
  @ManyToOne(() => Supplier, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplier_id' })
  supplier?: Supplier;

  @Column({ name: 'supplier_id', type: 'uuid' })
  supplierId!: string;

  /** `null`: compra sin orden. */
  @Index('IDX_purchase_receipt_orden')
  @ManyToOne(() => PurchaseOrder, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'purchase_order_id' })
  purchaseOrder?: PurchaseOrder | null;

  @Column({ name: 'purchase_order_id', type: 'uuid', nullable: true })
  purchaseOrderId!: string | null;

  @ManyToOne(() => Warehouse, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'warehouse_id' })
  warehouse?: Warehouse;

  @Column({ name: 'warehouse_id', type: 'uuid' })
  warehouseId!: string;

  @Column({
    name: 'supplier_document_type',
    type: 'enum',
    enum: SupplierDocumentType,
    enumName: 'supplier_document_type_enum',
  })
  supplierDocumentType!: SupplierDocumentType;

  @Column({ name: 'supplier_document_number', type: 'varchar', length: 30 })
  supplierDocumentNumber!: string;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'received_by_user_id' })
  receivedBy?: User;

  @Column({ name: 'received_by_user_id', type: 'uuid' })
  receivedByUserId!: string;

  @Column({
    name: 'total_amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: columnNumericTransformer,
  })
  totalAmount!: number;

  @Column({
    name: 'payment_status',
    type: 'enum',
    enum: PaymentStatus,
    enumName: 'purchase_payment_status_enum',
    default: PaymentStatus.UNPAID,
  })
  paymentStatus!: PaymentStatus;

  /** Lo completa la caja (M-D); sin clave foránea hasta que exista la tabla. */
  @ForeignKey('cash_movement', {
    name: 'FK_purchase_receipt_cash_movement',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'cash_movement_id', type: 'uuid', nullable: true })
  cashMovementId!: string | null;

  @Column({
    type: 'enum',
    enum: PurchaseReceiptStatus,
    default: PurchaseReceiptStatus.CONFIRMED,
  })
  status!: PurchaseReceiptStatus;

  @Column({ name: 'void_reason', type: 'text', nullable: true })
  voidReason!: string | null;

  @Column({ name: 'voided_at', type: 'timestamptz', nullable: true })
  voidedAt!: Date | null;

  @ForeignKey('user', {
    name: 'FK_purchase_receipt_voided_by',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'voided_by_user_id', type: 'uuid', nullable: true })
  voidedByUserId!: string | null;

  /** Lote del libro de movimientos que generó la recepción. */
  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  /** Lote del contraasiento, si se anuló. */
  @Column({ name: 'void_batch_id', type: 'uuid', nullable: true })
  voidBatchId!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @OneToMany(() => PurchaseReceiptItem, (i) => i.receipt)
  items?: PurchaseReceiptItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
