import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { CashSystemCode, CategoryDirection } from '../domain/cash.enums';

/**
 * Categoría de ingresos o gastos. Las de sistema (`systemCode`) las siembra el
 * sistema por distribuidora, las usan las demás operaciones y no se editan ni
 * se desactivan. El nombre es único entre las activas del mismo sentido (el servicio lo
 * compara sin distinguir mayúsculas y también contra las de sistema).
 */
@Unique('UQ_cash_category_id_distribuidora', ['categoryId', 'distributorId'])
@Entity('cash_category')
@Index('UQ_cash_category_sistema', ['distributorId', 'systemCode'], {
  unique: true,
  where: '"system_code" IS NOT NULL',
})
@Index(
  'UQ_cash_category_nombre_activa',
  ['distributorId', 'direction', 'name'],
  {
    unique: true,
    where: '"is_active" = true AND "system_code" IS NULL',
  },
)
export class CashCategory {
  @PrimaryGeneratedColumn('uuid', { name: 'category_id' })
  categoryId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Index('IDX_cash_category_distributor')
  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'enum', enum: CategoryDirection })
  direction!: CategoryDirection;

  @Column({
    name: 'system_code',
    type: 'enum',
    enum: CashSystemCode,
    nullable: true,
  })
  systemCode!: CashSystemCode | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
