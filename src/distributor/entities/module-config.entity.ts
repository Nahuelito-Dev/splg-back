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
 * Configuración de módulo
 * Los parámetros de un proceso automático para una distribuidora.
 * Casos: CU-105 a CU-108, CU-149, CU-171 y CU-173 (parametrización)
 */
@Check(
  'CHK_module_config_planificador',
  `"module" <> 'fleet_planner' OR (${CHECK_PLANIFICADOR})`,
)
@Check(
  'CHK_module_config_recompra',
  `"module" <> 'repurchase' OR (${CHECK_RECOMPRA})`,
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
