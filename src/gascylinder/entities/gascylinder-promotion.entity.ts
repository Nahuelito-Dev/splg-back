import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { GasCylinder } from './gascylinder.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

/**
 * Una promoción por volumen de un producto: desde `quantity` unidades, un
 * `discountPercentage` de descuento. Antes vivía como arreglo JSON dentro de
 * `gas_cylinder` (grupo repetitivo, fuera de 1FN): la base no podía validar
 * los rangos ni impedir dos promociones para la misma cantidad.
 */
@Entity('gas_cylinder_promotion')
@Unique('UQ_promocion_producto_cantidad', ['gas_cylinder_id', 'quantity'])
@Check('CHK_promocion_cantidad', '"quantity" >= 2')
@Check(
  'CHK_promocion_descuento',
  '"discount_percentage" > 0 AND "discount_percentage" <= 100',
)
export class GasCylinderPromotion {
  @PrimaryGeneratedColumn('uuid', { name: 'promotion_id' })
  promotion_id!: string;

  @ManyToOne(() => GasCylinder, (g) => g.promotions, {
    nullable: false,
    onDelete: 'CASCADE',
    orphanedRowAction: 'delete',
  })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder;

  @Column({ type: 'uuid' })
  gas_cylinder_id!: string;

  /** Unidades desde las que aplica. */
  @Column({ type: 'int' })
  quantity!: number;

  @Column({
    name: 'discount_percentage',
    type: 'decimal',
    precision: 5,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  discountPercentage!: number;
}
