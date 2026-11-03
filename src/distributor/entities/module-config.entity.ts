import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
  UpdateDateColumn,
  Check,
} from 'typeorm';
import { Distributor } from './distributor.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Los parámetros de un proceso automático. Su forma la define y la valida el
 * DTO de cada proceso (M1 no se parece a M3): la tabla sólo los guarda.
 */
export type ModuleConfigParams = Record<string, unknown>;

export enum ConfigurableProcess {
  FLEET_PLANNER = 'fleet_planner',
  REPURCHASE = 'repurchase',
  ROUTE_BATCHING = 'route_batching',
  CYLINDER_RECOVERY = 'cylinder_recovery',
  EXPRESS_DISPATCH = 'express_dispatch',
  /** Control del stock del camión (`requireOpenTruckLoad`). */
  STOCK_CONTROL = 'stock_control',
  /** Pasos de radio y ventana de la oferta del despacho (M1, CU-171). */
  DISPATCH = 'dispatch',
  /** Frecuencia de las tareas programadas (CU-173). */
  SCHEDULED_TASKS = 'scheduled_tasks',
  /** Recargo por medio de pago, en % (transferencia, Mercado Pago, efectivo). */
  PAYMENT_SURCHARGES = 'payment_surcharges',
}

/**
 * Rangos de los parámetros del planificador de flota (CU-105): los mismos de
 * `ESQUEMAS` en `process-config.ts`. Una clave ausente vale lo de omisión; una
 * presente tiene que ser un número dentro del rango.
 */
const RANGOS_DEL_PLANIFICADOR: ReadonlyArray<[string, number, number]> = [
  ['cronHour', 0, 23],
  ['proposalTtlHours', 1, 168],
  ['topNWindows', 1, 10],
  ['minVehiclesPerZone', 0, 100],
  ['minSampleDays', 1, 365],
  ['decay', 0, 1],
  ['horizonDays', 1, 180],
  ['minLeadDays', 0, 30],
  ['zoneLookbackDays', 1, 90],
  ['demandWeeks', 1, 26],
  ['workshopStartHour', 0, 23],
  ['workshopEndHour', 1, 24],
  ['workshopDays', 1, 127],
  ['usageStaleDays', 1, 90],
  ['anticipationKm', 0, 1_000_000],
  ['driverEmail', 0, 1],
];

/** Los parámetros enteros del planificador: `decay` es el único con decimales. */
const CHECK_PLANIFICADOR = [
  ...RANGOS_DEL_PLANIFICADOR.map(
    ([k, min, max]) =>
      `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${k === 'decay' ? '' : ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)`}))`,
  ),
  `(COALESCE(("params" ->> 'workshopStartHour')::numeric, 8) < COALESCE(("params" ->> 'workshopEndHour')::numeric, 13))`,
].join(' AND ');

/** Rangos de los parámetros de la recompra anticipada (CU-106): todos enteros. */
const RANGOS_DE_LA_RECOMPRA: ReadonlyArray<[string, number, number]> = [
  ['enabled', 0, 1],
  ['minOrders', 2, 50],
  ['anticipationDays', 1, 30],
  ['invitationTtlHours', 1, 168],
  ['minIntervalDays', 1, 90],
  ['runHour', 8, 21],
  ['recentOrderDays', 1, 30],
  ['staleDays', 7, 365],
];

const CHECK_RECOMPRA = RANGOS_DE_LA_RECOMPRA.map(
  ([k, min, max]) =>
    `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max} AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)))`,
).join(' AND ');

/**
 * Rangos de los parámetros de la recuperación de envases (CU-108): los mismos
 * de `ESQUEMAS` en `process-config.ts`. `escalationAmountThreshold` admite
 * decimales; el resto son enteros.
 */
const RANGOS_DE_LA_RECUPERACION: ReadonlyArray<[string, number, number]> = [
  ['toleranceDays', 1, 365],
  ['escalationStepDays', 1, 90],
  ['escalationAmountThreshold', 0, 100_000_000],
  ['pickupOfferTtlHours', 1, 720],
  ['pickupWindowDays', 1, 60],
  ['runHour', 0, 23],
  ['enabled', 0, 1],
];

const CHECK_RECUPERACION = RANGOS_DE_LA_RECUPERACION.map(
  ([k, min, max]) =>
    `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${k === 'escalationAmountThreshold' ? '' : ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)`}))`,
).join(' AND ');

/**
 * Rangos de los parámetros de la agrupación por recorrido (CU-107): los mismos
 * de `ESQUEMAS` en `process-config.ts`. `groupingRadiusKm` es el único decimal.
 */
const RANGOS_DE_LA_AGRUPACION: ReadonlyArray<[string, number, number]> = [
  ['maxBatchSize', 2, 20],
  ['groupingRadiusKm', 0.5, 50],
  ['slotToleranceMinutes', 0, 480],
  ['offerTtlSeconds', 10, 600],
  ['evaluationFrequencyMinutes', 1, 1440],
  ['batchingHoldMinutes', 0, 720],
  ['enabled', 0, 1],
];

const CHECK_AGRUPACION = RANGOS_DE_LA_AGRUPACION.map(
  ([k, min, max]) =>
    `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${k === 'groupingRadiusKm' ? '' : ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)`}))`,
).join(' AND ');

/** Recargos por medio de pago: 0 a 30 %, hasta 2 decimales (cada clave puede faltar). */
const CHECK_RECARGOS = [
  'transferPercentage',
  'mercadoPagoPercentage',
  'cashPercentage',
]
  .map(
    (k) =>
      `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN 0 AND 30 AND ("params" ->> '${k}')::numeric = round(("params" ->> '${k}')::numeric, 2)))`,
  )
  .join(' AND ');

/**
 * Parámetros del despacho (CU-171, CU-013): entero en su rango; los pasos de radio
 * sólo en su forma (lista de 1 a 8), el resto lo valida el servicio.
 */
const CHECK_DESPACHO = [
  `("params" -> 'radiusStepsKm' IS NULL OR (jsonb_typeof("params" -> 'radiusStepsKm') = 'array' AND jsonb_array_length("params" -> 'radiusStepsKm') BETWEEN 1 AND 8))`,
  ...(
    [
      ['offerTtlSeconds', 10, 300],
      ['finishingRadiusMeters', 0, 5000],
    ] as const
  ).map(
    ([k, min, max]) =>
      `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max} AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)))`,
  ),
].join(' AND ');

/**
 * Configuración de módulo
 * Los parámetros de un proceso automático para una distribuidora.
 * Casos: CU-105 a CU-108, CU-149, CU-171 y CU-173 (parametrización)
 */
@Check(
  'CHK_module_config_despacho',
  `"module" <> 'dispatch' OR (${CHECK_DESPACHO})`,
)
@Check(
  'CHK_module_config_planificador',
  `"module" <> 'fleet_planner' OR (${CHECK_PLANIFICADOR})`,
)
@Check(
  'CHK_module_config_recompra',
  `"module" <> 'repurchase' OR (${CHECK_RECOMPRA})`,
)
@Check(
  'CHK_module_config_recuperacion',
  `"module" <> 'cylinder_recovery' OR (${CHECK_RECUPERACION})`,
)
@Check(
  'CHK_module_config_agrupacion',
  `"module" <> 'route_batching' OR (${CHECK_AGRUPACION})`,
)
@Check(
  'CHK_module_config_recargos',
  `"module"::text <> 'payment_surcharges' OR (${CHECK_RECARGOS})`,
)
@Entity('module_config')
@Unique('UQ_module_config_distributor_module', ['distributorId', 'module'])
export class ModuleConfig {
  @PrimaryGeneratedColumn('uuid', { name: 'config_id' })
  configId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({
    name: 'module',
    type: 'enum',
    enum: ConfigurableProcess,
    enumName: 'configurable_process_enum',
    nullable: false,
  })
  module!: ConfigurableProcess;

  @Column({ name: 'params', type: 'jsonb', nullable: false })
  params!: ModuleConfigParams;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'updated_by_user_id' })
  updatedByUser?: User;

  @Column({ name: 'updated_by_user_id', type: 'uuid', nullable: true })
  updatedByUserId!: string | null;
}
