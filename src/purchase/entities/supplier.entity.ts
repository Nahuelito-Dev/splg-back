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
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { SupplierKind } from '../domain/purchase.enums';

/**
 * Proveedor de una distribuidora (planta fraccionadora u otro). Baja lógica; el
 * CUIT es único entre los proveedores vigentes de la distribuidora.
 */
@Check('CHK_supplier_cuit', `es_cuit_valido("cuit")`)
@Unique('UQ_supplier_id_distribuidora', ['supplierId', 'distributorId'])
@Entity('supplier')
@Index('UQ_supplier_cuit_vigente', ['distributorId', 'cuit'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
export class Supplier {
  @PrimaryGeneratedColumn('uuid', { name: 'supplier_id' })
  supplierId!: string;

  @Index('IDX_supplier_distributor')
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** Key de la foto principal en el bucket (`suppliers/{distribuidora}/{id}/{uuid}.{ext}`). */
  @Column({ name: 'photo_key', type: 'varchar', length: 512, nullable: true })
  photoKey!: string | null;

  /** URL firmada; la completa `EntityPhotoService.firmar`. No es una columna. */
  photoSignedUrl?: string | null;

  @Column({ name: 'business_name', type: 'varchar', length: 120 })
  businessName!: string;

  /** Once dígitos, sin guiones. */
  @Column({ type: 'varchar', length: 11 })
  cuit!: string;

  @Column({
    type: 'enum',
    enum: SupplierKind,
    default: SupplierKind.OTHER,
  })
  kind!: SupplierKind;

  @Column({ name: 'contact_name', type: 'varchar', length: 80, nullable: true })
  contactName!: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  email!: string | null;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ name: 'payment_terms_days', type: 'int', nullable: true })
  paymentTermsDays!: number | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;
}
