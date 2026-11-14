import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PlatformPlanModule } from './platform-plan-module.entity';

/** Topes de un plan: número ≥ 0, o `null` = sin tope. */
export interface LimitesDelPlan {
  maxDrivers: number | null;
  maxAdmins: number | null;
  maxOrdersMonth: number | null;
  documentReadingUsdMonth: number | null;
}

export const CLAVES_DE_LIMITES = [
  'maxDrivers',
  'maxAdmins',
  'maxOrdersMonth',
  'documentReadingUsdMonth',
] as const;

/**
 * Las cuatro claves de topes, obligatorias: cada una un número ≥ 0 o `null`
 * (sin tope), y ninguna otra. `?&` exige que estén (un `->` de una clave
 * ausente da NULL, y un CHECK que da NULL pasa) y el `COALESCE` cierra
 * cualquier otro NULL.
 */
export const CHECK_LIMITES_DEL_PLAN = `COALESCE(${[
  `jsonb_typeof("limits") = 'object'`,
  `"limits" ?& ARRAY[${CLAVES_DE_LIMITES.map((k) => `'${k}'`).join(', ')}]`,
  `("limits" - ARRAY[${CLAVES_DE_LIMITES.map((k) => `'${k}'`).join(', ')}]) = '{}'::jsonb`,
  ...CLAVES_DE_LIMITES.map(
    (k) =>
      `(jsonb_typeof("limits" -> '${k}') = 'null' OR (jsonb_typeof("limits" -> '${k}') = 'number' AND ("limits" ->> '${k}')::numeric >= 0))`,
  ),
].join(' AND ')}, false)`;

/**
 * Plan del servicio que la plataforma vende a las distribuidoras
 * (DISENO-PLATAFORMA-ORIXTECH §4.2). Lo que rige para cada empresa no es esta
 * fila sino la foto que se guardó al asignárselo
 * (`distributor_subscription.plan_snapshot`): editar un plan no cambia en
 * caliente a nadie.
 */
@Check('CHK_platform_plan_codigo', `"plan_code" ~ '^[a-z][a-z0-9_]{1,29}$'`)
@Check('CHK_platform_plan_nombre', `btrim("name") <> ''`)
@Check('CHK_platform_plan_precio', `"monthly_price" >= 0`)
@Check('CHK_platform_plan_moneda', `"currency" ~ '^[A-Z]{3}$'`)
@Check(
  'CHK_platform_plan_prueba',
  `("plan_code" = 'trial') = ("trial_days" IS NOT NULL) AND ("trial_days" IS NULL OR "trial_days" BETWEEN 1 AND 365)`,
)
@Check('CHK_platform_plan_version', `"version" >= 1`)
@Check('CHK_platform_plan_limites', CHECK_LIMITES_DEL_PLAN)
@Entity('platform_plan')
export class PlatformPlan {
  @PrimaryColumn({
    name: 'plan_code',
    type: 'varchar',
    length: 30,
    primaryKeyConstraintName: 'PK_platform_plan',
  })
  planCode!: string;

  @Column({ name: 'name', type: 'varchar', length: 60 })
  name!: string;

  /** Importe en `numeric(14,2)`: se lee como texto y se opera con `decimal.js`. */
  @Column({ name: 'monthly_price', type: 'numeric', precision: 14, scale: 2 })
  monthlyPrice!: string;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'trial_days', type: 'smallint', nullable: true })
  trialDays!: number | null;

  @Column({ name: 'limits', type: 'jsonb' })
  limits!: LimitesDelPlan;

  @Column({ name: 'is_public', type: 'boolean', default: true })
  isPublic!: boolean;

  /** Sube con cada cambio del plan; la foto de la suscripción guarda la que tomó. */
  @Column({ name: 'version', type: 'integer', default: 1 })
  version!: number;

  @OneToMany(() => PlatformPlanModule, (m) => m.plan)
  modules?: PlatformPlanModule[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
