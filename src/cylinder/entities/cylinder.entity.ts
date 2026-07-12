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
  cylinder_id: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor: Distributor;

  @Column({ type: 'uuid' })
  distributor_id: string;

  /** Número de serie físico grabado en el envase. Único por distribuidora. */
  @Index()
  @Column({ type: 'varchar' })
  serial: string;

  /** Tipo de producto al que corresponde (ej. "Garrafa 10kg"), sin relación para simplificar. */
  @Column({ type: 'uuid', nullable: true })
  gas_cylinder_id?: string;

  @Index()
  @Column({
    type: 'enum',
    enum: CylinderState,
    default: CylinderState.IN_DEPOT,
  })
  state: CylinderState;

  /** Cliente que tiene actualmente el envase (User user_id), solo seteado en WITH_CUSTOMER. */
  @Column({ type: 'uuid', nullable: true })
  current_customer_id?: string | null;

  /** Monto de garantía/depósito cobrado por el envase. */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  deposit: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
