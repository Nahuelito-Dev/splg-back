import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  OneToMany,
  Unique,
  Check,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { GasCylinderPromotion } from './gascylinder-promotion.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

@Check(
  'CHK_gas_cylinder_valores',
  `"price" > 0 AND "weight" > 0 AND "stock" >= 0 AND "reservation_deficit" >= 0 AND ("average_unit_cost" IS NULL OR "average_unit_cost" >= 0)`,
)
@Check('CHK_gas_cylinder_tipo', `btrim("type") <> ''`)
@Index('UQ_gas_cylinder_tipo_normalizado', { synchronize: false })
@Unique('UQ_gas_cylinder_id_distribuidora', ['gasCylinderId', 'distributorId'])
@Entity('gas_cylinder')
// El tipo es la clave natural del producto dentro de una distribuidora.
@Unique('UQ_gas_cylinder_distribuidora_tipo', ['distributorId', 'type'])
export class GasCylinder {
  @PrimaryGeneratedColumn('uuid', { name: 'gas_cylinder_id' })
  gasCylinderId!: string;

  /** Distribuidora dueña del producto. */
  @Index()
  @ManyToOne(() => Distributor, { nullable: false })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({
    name: 'distributor_id',
    type: 'uuid',
    nullable: false,
  })
  distributorId!: string;

  @Column({ type: 'varchar', length: 50 })
  type!: string; // '10kg', '15kg', '45kg'

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  weight!: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  price!: number;

  @Column({ type: 'int', default: 0 })
  stock!: number;

  /**
   * Unidades reservadas por pedidos abiertos que el físico no cubre
   * (`max(0, reservadas − llenas)`). Lo escribe el módulo de stock cuando una
   * pérdida física deja el vendible en cero: con esto el vendible vale siempre
   * `llenas − reservadas + deficit` y una cancelación o una entrada de llenas
   * primero cubre el déficit en lugar de inflar el vendible (sobreventa).
   */
  @Column({ name: 'reservation_deficit', type: 'int', default: 0 })
  reservationDeficit!: number;

  /** Costo promedio ponderado de las llenas compradas; lo mantiene la recepción de compras. */
  @Column({
    name: 'average_unit_cost',
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: columnNumericTransformer,
  })
  averageUnitCost!: number | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /** Key de la imagen del producto en el bucket (`gascylinders/{distribuidora}/{producto}/{uuid}.{ext}`). */
  @Column({ name: 'photo_key', type: 'varchar', length: 512, nullable: true })
  photoKey!: string | null;

  /** URL firmada; la completa `EntityPhotoService.firmar`. No es una columna. */
  photoSignedUrl?: string | null;

  /** Promociones por volumen; se guardan y se reemplazan junto con el producto. */
  @OneToMany(() => GasCylinderPromotion, (p) => p.gasCylinder, {
    cascade: true,
  })
  promotions?: GasCylinderPromotion[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
