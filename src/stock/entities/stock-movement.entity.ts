import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { User } from '../../users/entities/user.entity';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../domain/stock.enums';
import { StockLocation } from './stock-location.entity';

/**
 * Libro de movimientos de stock. APPEND-ONLY: un trigger de la base rechaza
 * todo UPDATE y DELETE (migración `StockFisico`). Un error se corrige con un
 * contraasiento (`reason = reversal`, que apunta al movimiento original en
 * `reversedMovementId`), nunca editando.
 *
 * `from` nulo = las garrafas entran desde afuera (planta, cliente, hallazgo);
 * `to` nulo = salen (cliente, planta, merma).
 */
@Entity('stock_movement')
@Index('IDX_stock_movement_fecha', ['distributorId', 'occurredAt'])
@Index('IDX_stock_movement_alta', ['distributorId', 'createdAt'])
@Index('IDX_stock_movement_garrafa_fecha', ['gasCylinderId', 'occurredAt'])
@Index('IDX_stock_movement_origen', ['fromLocationId'])
@Index('IDX_stock_movement_destino', ['toLocationId'])
@Index('IDX_stock_movement_referencia', ['referenceType', 'referenceId'])
@Index('IDX_stock_movement_lote', ['batchId'])
// Idempotencia de la entrega: un pedido deja a lo sumo un movimiento por
// garrafa y motivo.
@Index('UQ_stock_movement_pedido', ['referenceId', 'gasCylinderId', 'reason'], {
  unique: true,
  where: '"reference_type" = \'order\' AND "reason" <> \'reversal\'',
})
// Un movimiento se contraasienta una sola vez.
@Index('UQ_stock_movement_contraasiento', ['reversedMovementId'], {
  unique: true,
  where: '"reversed_movement_id" IS NOT NULL',
})
@Check('CHK_stock_movement_cantidad', '"quantity" > 0')
@Check(
  'CHK_stock_movement_origen_o_destino',
  '"from_location_id" IS NOT NULL OR "to_location_id" IS NOT NULL',
)
@Check(
  'CHK_stock_movement_origen_coherente',
  '("from_location_id" IS NULL) = ("from_condition" IS NULL)',
)
@Check(
  'CHK_stock_movement_destino_coherente',
  '("to_location_id" IS NULL) = ("to_condition" IS NULL)',
)
export class StockMovement {
  @PrimaryGeneratedColumn('uuid', { name: 'movement_id' })
  movementId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => GasCylinder, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder;

  @Column({ name: 'gas_cylinder_id', type: 'uuid' })
  gasCylinderId!: string;

  /** Agrupa los movimientos de una misma operación. */
  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @ManyToOne(() => StockLocation, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'from_location_id' })
  fromLocation?: StockLocation | null;

  @Column({ name: 'from_location_id', type: 'uuid', nullable: true })
  fromLocationId!: string | null;

  @Column({
    name: 'from_condition',
    type: 'enum',
    enum: StockCondition,
    enumName: 'stock_condition_enum',
    nullable: true,
  })
  fromCondition!: StockCondition | null;

  @ManyToOne(() => StockLocation, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'to_location_id' })
  toLocation?: StockLocation | null;

  @Column({ name: 'to_location_id', type: 'uuid', nullable: true })
  toLocationId!: string | null;

  @Column({
    name: 'to_condition',
    type: 'enum',
    enum: StockCondition,
    enumName: 'stock_condition_enum',
    nullable: true,
  })
  toCondition!: StockCondition | null;

  @Column({ type: 'enum', enum: StockMovementReason })
  reason!: StockMovementReason;

  @Column({
    name: 'reference_type',
    type: 'enum',
    enum: StockReferenceType,
  })
  referenceType!: StockReferenceType;

  /** Sin clave foránea, a propósito: apunta a tablas distintas según `referenceType`. */
  @Column({ name: 'reference_id', type: 'uuid', nullable: true })
  referenceId!: string | null;

  /** El movimiento que este contraasiento anula. */
  @ManyToOne(() => StockMovement, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reversed_movement_id' })
  reversedMovement?: StockMovement | null;

  @Column({ name: 'reversed_movement_id', type: 'uuid', nullable: true })
  reversedMovementId!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  notes!: string | null;

  /** `null`: lo hizo el sistema (entrega de un pedido, cron). */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actor?: User | null;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'now()' })
  occurredAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
