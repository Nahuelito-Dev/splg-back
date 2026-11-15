import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { ModuloKey } from './catalogo-de-modulos';

export interface FotoDeModulos {
  planCode: string;
  modules: string[];
}

export interface ExcepcionDeModulo {
  moduleKey: string;
  enabled: boolean | null;
  reason: string;
  expiresAt: Date | null;
}

export interface CambioDeExcepcion {
  distributorId: string;
  moduleKey: ModuloKey;
  enabled: boolean | null;
  reason: string;
  expiresAt: Date | null;
  actorUserId: string;
}

/**
 * Lo que queda en curso de cada módulo al apagarlo (§7.3), contado en la base
 * por empresa. Cada consulta filtra por `distributor_id` ($1).
 */
const PENDIENTES: Readonly<Record<ModuloKey, string | null>> = {
  document_reading: `SELECT count(*)::int AS n FROM "document_reading" WHERE "distributor_id" = $1 AND "status" = 'pending' AND "deleted_at" IS NULL`,
  route_planning: `SELECT count(*)::int AS n FROM "route_batch" WHERE "distributor_id" = $1 AND "kind" = 'planned' AND "status" IN ('draft', 'confirmed', 'assigned')`,
  route_batching: `SELECT count(*)::int AS n FROM "route_batch" WHERE "distributor_id" = $1 AND "kind" = 'offer' AND "status" IN ('forming', 'offered')`,
  repurchase: `SELECT count(*)::int AS n FROM "repurchase_invitation" WHERE "distributor_id" = $1 AND "status" = 'pending' AND "expires_at" > now()`,
  cylinder_recovery: `SELECT count(*)::int AS n FROM "cylinder_recovery_notice" n JOIN "cylinder_recovery_case" c ON c."case_id" = n."case_id" WHERE c."distributor_id" = $1 AND n."kind" = 'pickup_offer' AND n."status" = 'pending' AND n."expires_at" > now()`,
  fleet_planner: `SELECT count(*)::int AS n FROM "maintenance_planning_case" WHERE "distributor_id" = $1 AND "status" IN ('negotiating', 'awaiting_confirmation')`,
  mercadopago: `SELECT count(*)::int AS n FROM "order" WHERE "distributor_id" = $1 AND "paymentMethod" = 'mercadopago' AND "paymentStatus" = 'pending' AND "status" NOT IN ('delivered', 'cancelled')`,
  express: `SELECT count(*)::int AS n FROM "order" WHERE "distributor_id" = $1 AND "delivery_mode" = 'express' AND "status" IN ('pending', 'accepted', 'on_the_way')`,
  // M7 todavía no tiene código: no hay conversaciones que contar.
  whatsapp: null,
  chat: `SELECT count(*)::int AS n FROM "conversation" WHERE "distributor_id" = $1 AND "channel" IN ('staff_customer', 'staff_driver') AND "status" = 'open' AND "deleted_at" IS NULL`,
};

/** Lecturas y escrituras de la plataforma sobre los módulos de una empresa. */
@Injectable()
export class ModulosDeLaEmpresaRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async fotoDelPlan(distributorId: string): Promise<FotoDeModulos | null> {
    const filas = await this.dataSource.query<
      Array<{ plan_code: string; modules: unknown }>
    >(
      `SELECT "plan_code", "plan_snapshot" -> 'modules' AS modules
         FROM "distributor_subscription" WHERE "distributor_id" = $1`,
      [distributorId],
    );
    const fila = filas[0];
    if (!fila) return null;
    return {
      planCode: fila.plan_code,
      modules: Array.isArray(fila.modules)
        ? fila.modules.filter((m): m is string => typeof m === 'string')
        : [],
    };
  }

  async excepciones(distributorId: string): Promise<ExcepcionDeModulo[]> {
    const filas = await this.dataSource.query<
      Array<{
        module_key: string;
        enabled: boolean | null;
        reason: string;
        expires_at: Date | null;
      }>
    >(
      `SELECT "module_key", "enabled", "reason", "expires_at"
         FROM "distributor_module" WHERE "distributor_id" = $1`,
      [distributorId],
    );
    return filas.map((f) => ({
      moduleKey: f.module_key,
      enabled: f.enabled,
      reason: f.reason,
      expiresAt: f.expires_at ? new Date(f.expires_at) : null,
    }));
  }

  /**
   * Una sola sentencia (alta o reemplazo por la clave primaria): dos cambios
   * simultáneos sobre el mismo módulo no se pisan a medias; gana el último.
   * El actor de la auditoría lo fija `ActorEnLaBase`.
   */
  async guardarExcepcion(c: CambioDeExcepcion): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO "distributor_module" ("distributor_id", "module_key", "enabled", "reason", "expires_at", "updated_by", "updated_at")
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT ("distributor_id", "module_key") DO UPDATE
         SET "enabled" = EXCLUDED."enabled", "reason" = EXCLUDED."reason",
             "expires_at" = EXCLUDED."expires_at", "updated_by" = EXCLUDED."updated_by",
             "updated_at" = now()`,
      [
        c.distributorId,
        c.moduleKey,
        c.enabled,
        c.reason,
        c.expiresAt,
        c.actorUserId,
      ],
    );
  }

  async pendientes(distributorId: string, modulo: ModuloKey): Promise<number> {
    const sql = PENDIENTES[modulo];
    if (!sql) return 0;
    const filas = await this.dataSource.query<Array<{ n: number }>>(sql, [
      distributorId,
    ]);
    return Number(filas[0]?.n ?? 0);
  }
}
