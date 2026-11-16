import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
  CreateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Vínculo de un cliente con una distribuidora que lo dio de alta (panel).
 * Los clientes son de la plataforma; además de "le compró" (un pedido), un
 * cliente es de la distribuidora que lo registró aunque todavía no tenga
 * pedidos. La clave compuesta impide duplicar el vínculo.
 *
 * La baja del cliente en la distribuidora (`removedAt`) no toca su cuenta ni
 * sus pedidos: sólo lo saca de "sus" clientes hasta que vuelva a comprar o la
 * distribuidora lo dé de alta de nuevo.
 */
@Check(
  'CHK_customer_distributor_baja',
  `"removed_by_user_id" IS NULL OR "removed_at" IS NOT NULL`,
)
@Entity('customer_distributor')
export class CustomerDistributor {
  @PrimaryColumn({
    name: 'user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_customer_distributor',
  })
  userId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_customer_distributor_user',
  })
  user?: User;

  @Index('IDX_customer_distributor_distributor')
  @PrimaryColumn({
    name: 'distributor_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_customer_distributor',
  })
  distributorId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_customer_distributor_distributor',
  })
  distributor?: Distributor;

  /** Quién dio el alta; null si esa cuenta ya no existe. */
  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'FK_customer_distributor_created_by',
  })
  createdBy?: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** Cuándo la distribuidora dio de baja al cliente; null si está vigente. */
  @Column({ name: 'removed_at', type: 'timestamptz', nullable: true })
  removedAt!: Date | null;

  /** Quién lo dio de baja; null si no hay baja o esa cuenta ya no existe. */
  @Column({ name: 'removed_by_user_id', type: 'uuid', nullable: true })
  removedByUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'removed_by_user_id',
    foreignKeyConstraintName: 'FK_customer_distributor_removed_by',
  })
  removedBy?: User | null;
}
