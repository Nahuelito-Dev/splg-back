import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';

export enum DistributorStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/**
 * Distribuidora = el TENANT de la plataforma. Multi-tenant por columna
 * discriminadora `distributor_id` (shared DB + shared schema). Cada empresa
 * de garrafas es un Distributor: tiene su propio catálogo, choferes, admins,
 * pedidos, zonas y reportes, aislados del resto.
 *
 * El `super_admin` (operador de la plataforma) es cross-tenant; el `admin` de
 * una distribuidora sólo ve/opera lo suyo.
 */
@Entity('distributor')
export class Distributor {
  @PrimaryGeneratedColumn('uuid', { name: 'distributor_id' })
  distributorId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /** Identificador legible/estable para resolver el tenant (header/subdominio). */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60, unique: true })
  slug!: string;

  @Column({
    name: 'legal_name',
    type: 'varchar',
    length: 160,
    nullable: true,
  })
  legalName!: string | null;

  /** CUIT / identificación fiscal. */
  @Column({
    name: 'tax_id',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  taxId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', nullable: true })
  phone!: string | null;

  @Column({
    name: 'logo_url',
    type: 'varchar',
    nullable: true,
  })
  logoUrl!: string | null;

  /** Key de el logo en el bucket (`distributors/{distribuidora}/logo/{uuid}.{ext}`). */
  @Column({ name: 'logo_key', type: 'varchar', length: 512, nullable: true })
  logoKey!: string | null;

  /** URL firmada; la completa `EntityPhotoService.firmar`. No es una columna. */
  photoSignedUrl?: string | null;

  @Column({
    type: 'enum',
    enum: DistributorStatus,
    default: DistributorStatus.ACTIVE,
  })
  status!: DistributorStatus;

  /** Plan de suscripción SaaS (para facturación futura). */
  @Column({ type: 'varchar', nullable: true })
  plan!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
