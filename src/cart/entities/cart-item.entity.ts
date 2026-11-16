import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Unique,
  Check,
} from 'typeorm';
import { Cart } from './cart.entity';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

/**
 * Ítem del carrito
 * Cada producto cargado en el carrito, con su cantidad.
 * Casos: CU-122 a CU-126
 */
@Check('CHK_cart_item_cantidad', `"quantity" BETWEEN 1 AND 999`)
@Check('CHK_cart_item_precio', `"unit_price" >= 0`)
@Entity('cart_item')
@Unique('UQ_cart_item_cart_gascylinder', ['cartId', 'gasCylinderId'])
export class CartItem {
  @PrimaryGeneratedColumn('uuid', { name: 'cart_item_id' })
  cartItemId!: string;

  @ManyToOne(() => Cart, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cart_id' })
  cart!: Cart;

  @Column({ name: 'cart_id', type: 'uuid' })
  cartId!: string;

  @ManyToOne(() => GasCylinder, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder!: GasCylinder;

  @Column({ name: 'gas_cylinder_id', type: 'uuid' })
  gasCylinderId!: string;

  @Column({ name: 'quantity', type: 'integer', nullable: false })
  quantity!: number;

  @Column({
    name: 'unit_price',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: false,
  })
  unitPrice!: number;
}
