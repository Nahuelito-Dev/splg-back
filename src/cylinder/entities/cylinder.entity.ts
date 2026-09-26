import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { User } from '../../users/entities/user.entity';
import { Order } from '../../order/entities/order.entity';

/**
 * Estado del ciclo de vida FÍSICO del envase. No confundir con `OrderStatus`
 * (estado del pedido) ni con `gas_cylinder` (el TIPO de producto, ej "Garrafa
 * 10kg"): acá cada fila es UNA garrafa real, identificada por su serial.
 */
export enum CylinderState {
  IN_DEPOT = 'in_depot',
  FILLED = 'filled',
  DISPATCHED = 'dispatched',
  WITH_CUSTOMER = 'with_customer',
  EMPTY_RETURNED = 'empty_returned',
}

/**
 * Unidad física de envase (cilindro/garrafa) con serial propio. Tenant-scoped:
 * SIEMPRE pertenece a una distribuidora (a diferencia de otras entidades que
 * admiten `distributor_id` nullable durante el backfill). El serial es único
 * POR distribuidora, no global (dos empresas pueden tener garrafas con el
 * mismo número de serie de fábrica).
 */
@Entity('cylinder')
@Unique(['distributor_id', 'serial'])
export class Cylinder {
  @PrimaryGeneratedColumn('uuid', { name: 'cylinder_id' })
  cylinder_id!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ type: 'uuid' })
  distributor_id!: string;

  /** Número de serie físico grabado en el envase. Único por distribuidora. */
  @Index()
  @Column({ type: 'varchar' })
  serial!: string;

  /** Tipo de producto al que corresponde (ej. "Garrafa 10kg"), sin relación para simplificar. */
  @Column({ type: 'uuid', nullable: true })
  gas_cylinder_id!: string | null;

  @ManyToOne(() => GasCylinder, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder;

  @Index()
  @Column({
    type: 'enum',
    enum: CylinderState,
    default: CylinderState.IN_DEPOT,
  })
  state!: CylinderState;

  /** Cliente que tiene actualmente el envase (User user_id), solo seteado en WITH_CUSTOMER. */
  @Column({ type: 'uuid', nullable: true })
  current_customer_id!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'current_customer_id' })
  currentCustomer?: User;

  /**
   * Pedido en el que el envase salió despachado. Se setea al asignarlo a un
   * pedido (FILLED→DISPATCHED) y permite que, al pasar el pedido a DELIVERED,
   * el sistema avance solo los envases de ESE pedido a WITH_CUSTOMER. Queda
   * como referencia del último pedido en el que se entregó.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  current_order_id!: string | null;

  @ManyToOne(() => Order, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'current_order_id' })
  currentOrder?: Order;

  /** Monto de garantía/depósito cobrado por el envase. */
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    default: 0,
  })
  deposit!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'manufactured_at', type: 'timestamptz', nullable: true })
  manufactured_at!: Date | null;

  @Column({ name: 'last_inspection_at', type: 'timestamptz', nullable: true })
  last_inspection_at!: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expires_at!: Date | null;
}
