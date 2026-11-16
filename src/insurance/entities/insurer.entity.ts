import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

/**
 * Aseguradora de una distribuidora. Guarda el enlace de pago (la página de la
 * aseguradora o su Mercado Pago) que el aviso de la cuota le muestra al admin.
 * Baja lógica; el nombre es único entre las vigentes de la distribuidora.
 */
@Check('CHK_insurer_cuit', `"tax_id" IS NULL OR es_cuit_valido("tax_id")`)
@Check(
  'CHK_insurer_enlaces',
  `("payment_url" IS NULL OR "payment_url" ~ '^https://[^[:space:]]+$') AND ("website" IS NULL OR "website" ~ '^https?://[^[:space:]]+$')`,
)
@Check('CHK_insurer_nombre', `char_length(btrim("name")) >= 2`)
@Unique('UQ_insurer_id_distribuidora', ['insurerId', 'distributorId'])
@Entity('insurer')
@Index('UQ_insurer_nombre_vigente', { synchronize: false })
export class Insurer {
  @PrimaryGeneratedColumn('uuid', { name: 'insurer_id' })
  insurerId!: string;

  @Index('IDX_insurer_distributor')
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'name', type: 'varchar', length: 120 })
  name!: string;

  /** Once dígitos, sin guiones. */
  @Column({ name: 'tax_id', type: 'varchar', length: 11, nullable: true })
  taxId!: string | null;

  @Column({ name: 'phone', type: 'varchar', length: 40, nullable: true })
  phone!: string | null;

  @Column({ name: 'email', type: 'varchar', length: 120, nullable: true })
  email!: string | null;

  @Column({ name: 'website', type: 'varchar', length: 255, nullable: true })
  website!: string | null;

  /** Página de pago de la aseguradora (https). */
  @Column({ name: 'payment_url', type: 'varchar', length: 500, nullable: true })
  paymentUrl!: string | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt!: Date | null;
}
