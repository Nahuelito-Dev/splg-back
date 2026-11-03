import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  Check,
  ForeignKey,
  VersionColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Car } from '../../car/entities/car.entity';
import { Warehouse } from '../../stock/entities/warehouse.entity';
import { TruckLoad } from '../../truck-load/entities/truck-load.entity';
import { User } from '../../users/entities/user.entity';
import { RoutePlan } from './route-plan.entity';
import {
  RouteBatchKind,
  RouteBatchStatus,
} from '../../route-batch/domain/route-batch.enums';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

// Los enums viven en el dominio (que no importa entidades de TypeORM); acá se
// reexportan para quien los pide desde la entidad.
export { RouteBatchKind, RouteBatchStatus };

/** Por qué se deshizo un lote (`route_batch.close_reason`). */
export enum RouteBatchCloseReason {
  /** Ningún chofer candidato lo tomó: los pedidos vuelven al despacho individual (M1). */
  EXHAUSTED = 'exhausted',
  /** Quedó con menos de dos pedidos disponibles (se cancelaron o se asignaron aparte). */
  ORDERS_UNAVAILABLE = 'orders_unavailable',
  /** El administrador lo deshizo desde el panel. */
  ADMIN = 'admin',
  /** Se cerró el día de la planificación con la hoja todavía en borrador. */
  DAY_CLOSED = 'day_closed',
}

/** Qué tuvo la última palabra sobre el orden de las paradas de una hoja. */
export enum RouteOptimizationMethod {
  NN_2OPT = 'nn_2opt',
  MANUAL = 'manual',
}

/** De dónde salieron los tiempos y distancias de una hoja. */
export enum RouteMatrixSource {
  OSRM = 'osrm',
  GOOGLE = 'google',
  HAVERSINE = 'haversine',
}

export enum RouteProposedBy {
  SYSTEM = 'system',
  ADMIN = 'admin',
}

/**
 * Lote de recorrido
 * Un grupo de pedidos que se entregan en un mismo viaje.
 * Casos: CU-107 (M4)
 */
@Check('CHK_route_batch_peso', `"total_weight_kg" >= 0`)
@Check(
  'CHK_route_batch_chofer',
  `"status" NOT IN ('assigned', 'completed') OR "delivery_id" IS NOT NULL`,
)
@Check(
  'CHK_route_batch_cierre',
  `("status" IN ('dissolved', 'completed')) = ("closed_at" IS NOT NULL)`,
)
@Check(
  'CHK_route_batch_motivo',
  `("status" = 'dissolved') = ("close_reason" IS NOT NULL)`,
)
@Check(
  'CHK_route_batch_hoja_fecha',
  `("kind" = 'planned') = ("plan_date" IS NOT NULL)`,
)
@Check(
  'CHK_route_batch_estados_oferta',
  `"kind" = 'planned' OR "status" NOT IN ('draft', 'confirmed')`,
)
@Check(
  'CHK_route_batch_estados_hoja',
  `"kind" = 'offer' OR "status" NOT IN ('forming', 'offered')`,
)
@Check(
  'CHK_route_batch_hoja_confirmada',
  `"kind" <> 'planned' OR "status" IN ('draft', 'dissolved') OR ("delivery_id" IS NOT NULL AND "car_id" IS NOT NULL AND "confirmed_at" IS NOT NULL)`,
)
@Check(
  'CHK_route_batch_hoja_iniciada',
  `"status" <> 'assigned' OR "kind" <> 'planned' OR "started_at" IS NOT NULL`,
)
@Check(
  'CHK_route_batch_unidades',
  `"total_units" IS NULL OR "total_units" >= 0`,
)
@Check('CHK_route_batch_pico', `"peak_units" IS NULL OR "peak_units" >= 0`)
@Check(
  'CHK_route_batch_totales',
  `("total_distance_km" IS NULL OR "total_distance_km" >= 0) AND ("total_duration_min" IS NULL OR "total_duration_min" >= 0)`,
)
@Check(
  'CHK_route_batch_hoja_numero',
  `"number" IS NULL OR ("kind" = 'planned' AND "number" >= 1)`,
)
@Check(
  'CHK_route_batch_metodo',
  `"optimization_method" IS NULL OR "optimization_method" IN ('nn_2opt', 'manual')`,
)
@Check(
  'CHK_route_batch_matriz',
  `"matrix_source" IS NULL OR "matrix_source" IN ('osrm', 'google', 'haversine')`,
)
@Check(
  'CHK_route_batch_propuesta_por',
  `"proposed_by" IS NULL OR "proposed_by" IN ('system', 'admin')`,
)
@ForeignKey(
  () => RoutePlan,
  ['distributor_id', 'plan_date'],
  ['distributor_id', 'plan_date'],
  { name: 'FK_route_batch_plan_dia', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => Car,
  ['car_id', 'distributor_id'],
  ['car_id', 'distributor_id'],
  {
    name: 'FK_route_batch_car_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Warehouse,
  ['origin_warehouse_id', 'distributor_id'],
  ['warehouse_id', 'distributor_id'],
  {
    name: 'FK_route_batch_origin_warehouse_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => TruckLoad,
  ['truck_load_id', 'distributor_id'],
  ['load_id', 'distributor_id'],
  {
    name: 'FK_route_batch_truck_load_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Index('UQ_route_batch_hoja_chofer_dia', ['deliveryId', 'planDate'], {
  unique: true,
  where: `"kind" = 'planned' AND "status" IN ('confirmed', 'assigned')`,
})
@Index('UQ_route_batch_hoja_vehiculo_dia', ['carId', 'planDate'], {
  unique: true,
  where: `"kind" = 'planned' AND "status" IN ('confirmed', 'assigned')`,
})
@Index('UQ_route_batch_numero', ['distributorId', 'number'], {
  unique: true,
  where: `"number" IS NOT NULL`,
})
@Index('IDX_route_batch_plan', ['distributorId', 'planDate', 'status'])
@Entity('route_batch')
export class RouteBatch {
  @PrimaryGeneratedColumn('uuid', { name: 'batch_id' })
  batchId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: RouteBatchStatus,
    nullable: false,
    default: RouteBatchStatus.FORMING,
  })
  status!: RouteBatchStatus;

  @Column({
    name: 'total_weight_kg',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: false,
  })
  totalWeightKg!: number;

  @ManyToOne(() => Delivery, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'delivery_id' })
  delivery?: Delivery;

  @Column({ name: 'delivery_id', type: 'uuid', nullable: true })
  deliveryId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** Cuándo se deshizo o se completó. */
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({
    name: 'close_reason',
    type: 'enum',
    enum: RouteBatchCloseReason,
    nullable: true,
  })
  closeReason!: RouteBatchCloseReason | null;

  @Column({
    name: 'kind',
    type: 'enum',
    enum: RouteBatchKind,
    nullable: false,
    default: RouteBatchKind.OFFER,
  })
  kind!: RouteBatchKind;

  /** Día de reparto de la hoja (hora argentina). Sólo la modalidad `planned`. */
  @Column({ name: 'plan_date', type: 'date', nullable: true })
  planDate!: string | null;

  /** Número correlativo de la hoja por distribuidora (`document_sequence`). */
  @Column({ name: 'number', type: 'int', nullable: true })
  number!: number | null;

  @ManyToOne(() => Car, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'car_id' })
  car?: Car | null;

  @Column({ name: 'car_id', type: 'uuid', nullable: true })
  carId!: string | null;

  /** Depósito del que sale el recorrido. */
  @ManyToOne(() => Warehouse, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'origin_warehouse_id' })
  originWarehouse?: Warehouse | null;

  @Column({ name: 'origin_warehouse_id', type: 'uuid', nullable: true })
  originWarehouseId!: string | null;

  /** Carga del camión vinculada al iniciar la hoja. */
  @ManyToOne(() => TruckLoad, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'truck_load_id' })
  truckLoad?: TruckLoad | null;

  @Column({ name: 'truck_load_id', type: 'uuid', nullable: true })
  truckLoadId!: string | null;

  @Column({ name: 'planned_start_at', type: 'timestamptz', nullable: true })
  plannedStartAt!: Date | null;

  @Column({
    name: 'total_distance_km',
    type: 'decimal',
    precision: 8,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  totalDistanceKm!: number | null;

  /** Viaje + servicio + esperas. */
  @Column({ name: 'total_duration_min', type: 'int', nullable: true })
  totalDurationMin!: number | null;

  /** Garrafas llenas a cargar. */
  @Column({ name: 'total_units', type: 'int', nullable: true })
  totalUnits!: number | null;

  /** Pico de envases a bordo (llenas + vacías + retiros). */
  @Column({ name: 'peak_units', type: 'int', nullable: true })
  peakUnits!: number | null;

  @Column({
    name: 'optimization_method',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  optimizationMethod!: RouteOptimizationMethod | null;

  @Column({
    name: 'matrix_source',
    type: 'varchar',
    length: 12,
    nullable: true,
  })
  matrixSource!: RouteMatrixSource | null;

  @Column({ name: 'proposed_by', type: 'varchar', length: 10, nullable: true })
  proposedBy!: RouteProposedBy | null;

  /** Último ajuste manual: la re-propuesta no pisa una hoja tocada a mano. */
  @Column({ name: 'edited_at', type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'confirmed_by_user_id' })
  confirmedByUser?: User | null;

  @Column({ name: 'confirmed_by_user_id', type: 'uuid', nullable: true })
  confirmedByUserId!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  /** Concurrencia optimista: toda edición manda la versión que vio. */
  @VersionColumn({ name: 'version', default: 1 })
  version!: number;
}
