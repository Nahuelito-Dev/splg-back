import {
  Check,
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GasCylinder } from './gascylinder.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

/**
 * Una promoción por volumen de un producto: desde `quantity` unidades, un
 * `discountPercentage` de descuento. Antes vivía como arreglo JSON dentro de
 * `gas_cylinder` (grupo repetitivo, fuera de 1FN): la base no podía validar
 * los rangos ni impedir dos promociones para la misma cantidad. Al editar el
 * producto, las que ya no están en la lista se dan de baja (`deletedAt`), no se
 * borran: queda la auditoría.
 */
@Entity('gas_cylinder_promotion')
// Única sólo entre las vigentes: una promoción dada de baja no impide cargar
// otra para la misma cantidad.
@Index('UQ_promocion_producto_cantidad', ['gasCylinderId', 'quantity'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
@Check('CHK_promocion_cantidad', '"quantity" >= 2')
@Check(
  'CHK_promocion_descuento',
  '"discount_percentage" > 0 AND "discount_percentage" <= 100',
)
export class GasCylinderPromotion {
  @PrimaryGeneratedColumn('uuid', { name: 'promotion_id' })
  promotionId!: string;

  @ManyToOne(() => GasCylinder, (g) => g.promotions, {
    nullable: false,
    onDelete: 'CASCADE',
    orphanedRowAction: 'soft-delete',
  })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder;

  @Column({
    name: 'gas_cylinder_id',
    type: 'uuid',
  })
  gasCylinderId!: string;

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

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
