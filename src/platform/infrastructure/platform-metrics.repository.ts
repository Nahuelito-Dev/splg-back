import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { AuditActionTypeId } from '../../audit/entities/audit-action-type.entity';
import { AuditResult } from '../../audit/entities/audit-log.entity';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { OrderStatus, PaymentStatus } from '../../order/entities/order.entity';

/**
 * Lado de lectura del panel de plataforma (CQRS, CONVENCIONES §4): consultas
 * agregadas sobre tablas de varios módulos, sólo para leer. Cada consulta es
 * UNA sentencia agrupada por empresa, cualquiera sea la cantidad de empresas
 * (sin N+1); todas llevan la marca `/* plataforma:… *\/` para poder contarlas.
 *
 * Nada de lo que sale de acá es un dato personal: conteos, montos, fechas e
 * identificadores. Los nombres y correos que sí salen son de cuentas del panel
 * (administradores), no de clientes ni choferes.
 */

export interface FilaDeEmpresa {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  tax_id: string | null;
  email: string | null;
  status: string;
  owned_by_platform: boolean;
  plan: string | null;
  created_at: Date;
  support_emergency_allowed: boolean;
  support_auto_approve: boolean;
}

export interface FilaDeMetricas {
  id: string;
  pedidos: number;
  ventas: number;
  /** Numérico de Postgres como texto: se suma con `decimal.js`. */
  facturacion: string;
  choferes: number;
  clientes: number;
  ultima_actividad: Date | null;
  soporte_activo: boolean;
  soporte_pendiente: number;
}

export interface FilaDeLector {
  id: string;
  lecturas: number;
  costo: string;
}

export interface FilaDePresupuesto {
  id: string;
  params: Record<string, unknown> | null;
}

export interface FilaDeEstados {
  status: string;
  cantidad: number;
}

export interface FilaDeAdmin {
  distributor_id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  staff_role: string | null;
  blocked: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

export interface FilaDeSesion {
  id: string;
  distributor_id: string;
  kind: string;
  status: string;
  requested_by_name: string | null;
  reason: string;
  requested_minutes: number;
  created_at: Date;
  started_at: Date | null;
  expires_at: Date | null;
  ended_at: Date | null;
  end_reason: string | null;
}

export interface FiltroDeActividad {
  desde: Date | null;
  hasta: Date | null;
  actorUserId: string | null;
  distributorId: string | null;
  limit: number;
  offset: number;
}

export interface FilaDeActividad {
  id: string;
  at: Date;
  kind: 'request' | 'login';
  actor_user_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  method: string | null;
  resource: string;
  resource_id: string | null;
  path: string | null;
  distributor_id: string | null;
  distributor_name: string | null;
  result: string;
  status_code: number;
  total: number;
}

/** Los recursos cuyas escrituras son de la plataforma aunque las haga una empresa. */
export const RECURSOS_DE_PLATAFORMA = [
  'distributor',
  'platform',
  'support-sessions',
  'support-access',
  'role',
] as const;

const numero = (v: unknown): number => Number(v ?? 0);

@Injectable()
export class PlatformMetricsRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Empresas vigentes (sin las dadas de baja), por nombre, con su total. */
  async empresas(
    status: string | null,
    ownedByPlatform: boolean | null,
    limit: number,
    offset: number,
  ): Promise<{ filas: FilaDeEmpresa[]; total: number }> {
    const filas = await this.ds.query<FilaDeEmpresa[]>(
      `/* plataforma:empresas */
       SELECT ${COLUMNAS_DE_EMPRESA}
         FROM "distributor" d
        WHERE d."deletedAt" IS NULL
          AND ($1::text IS NULL OR d."status"::text = $1)
          AND ($2::boolean IS NULL OR d."owned_by_platform" = $2)
        ORDER BY d."owned_by_platform" DESC, d."name", d."distributor_id"
        LIMIT $3 OFFSET $4`,
      [status, ownedByPlatform, limit, offset],
    );
    const [cuenta] = await this.ds.query<Array<{ total: string }>>(
      `/* plataforma:empresas-total */
       SELECT COUNT(*) AS total FROM "distributor" d
        WHERE d."deletedAt" IS NULL
          AND ($1::text IS NULL OR d."status"::text = $1)
          AND ($2::boolean IS NULL OR d."owned_by_platform" = $2)`,
      [status, ownedByPlatform],
    );
    return { filas, total: numero(cuenta?.total) };
  }

  /** Id y nombre de todas las empresas vigentes, por nombre. */
  async nombres(): Promise<Array<{ id: string; name: string }>> {
    return this.ds.query<Array<{ id: string; name: string }>>(
      `/* plataforma:nombres */
       SELECT d."distributor_id" AS id, d."name"
         FROM "distributor" d
        WHERE d."deletedAt" IS NULL
        ORDER BY d."name", d."distributor_id"`,
    );
  }

  /** Una empresa vigente, o `null` si no existe o está dada de baja. */
  async empresa(id: string): Promise<FilaDeEmpresa | null> {
    const [fila] = await this.ds.query<FilaDeEmpresa[]>(
      `/* plataforma:empresa */
       SELECT ${COLUMNAS_DE_EMPRESA}
         FROM "distributor" d
        WHERE d."distributor_id" = $1 AND d."deletedAt" IS NULL`,
      [id],
    );
    return fila ?? null;
  }

  /** Cuántas empresas vigentes hay en cada estado. */
  async estados(): Promise<FilaDeEstados[]> {
    const filas = await this.ds.query<
      Array<{ status: string; cantidad: string }>
    >(
      `/* plataforma:estados */
       SELECT d."status"::text AS status, COUNT(*) AS cantidad
         FROM "distributor" d
        WHERE d."deletedAt" IS NULL
        GROUP BY d."status"`,
    );
    return filas.map((f) => ({
      status: f.status,
      cantidad: numero(f.cantidad),
    }));
  }

  /**
   * Las métricas de cada empresa en `[desde, hasta)`, en una sola consulta:
   * pedidos creados, ventas (entregados y cobrados, el mismo criterio que
   * `/v2/reports/sales-summary`) y su facturación, choferes habilitados,
   * clientes vinculados, última actividad y sesiones de soporte. `ids` nulo:
   * todas las empresas vigentes.
   */
  async metricas(
    ids: string[] | null,
    desde: Date,
    hasta: Date,
    ahora: Date,
  ): Promise<FilaDeMetricas[]> {
    const filas = await this.ds.query<
      Array<Record<keyof FilaDeMetricas, unknown>>
    >(
      `/* plataforma:metricas */
       WITH empresas AS (
         SELECT d."distributor_id" FROM "distributor" d
          WHERE d."deletedAt" IS NULL
            AND ($1::uuid[] IS NULL OR d."distributor_id" = ANY($1::uuid[]))
       ),
       pedidos AS (
         SELECT o."distributor_id",
                COUNT(*) FILTER (WHERE o."createdAt" >= $2 AND o."createdAt" < $3) AS pedidos,
                COUNT(*) FILTER (WHERE ${VENTA}) AS ventas,
                COALESCE(SUM(o."totalAmount") FILTER (WHERE ${VENTA}), 0) AS facturacion
           FROM "order" o
           JOIN empresas e ON e."distributor_id" = o."distributor_id"
          WHERE (o."createdAt" >= $2 AND o."createdAt" < $3)
             OR (o."deliveredAt" >= $2 AND o."deliveredAt" < $3)
          GROUP BY o."distributor_id"
       ),
       choferes AS (
         SELECT c."distributor_id", COUNT(*) AS choferes
           FROM "delivery" c
           JOIN empresas e ON e."distributor_id" = c."distributor_id"
          WHERE c."deletedAt" IS NULL AND c."isEnabled" AND c."validated"
          GROUP BY c."distributor_id"
       ),
       clientes AS (
         SELECT cd."distributor_id", COUNT(*) AS clientes
           FROM "customer_distributor" cd
           JOIN empresas e ON e."distributor_id" = cd."distributor_id"
          WHERE cd."removed_at" IS NULL
          GROUP BY cd."distributor_id"
       ),
       soporte AS (
         SELECT s."distributor_id",
                bool_or(s."status" = 'active' AND s."expires_at" > $6) AS activa,
                COUNT(*) FILTER (WHERE s."status" = 'pending' AND s."request_expires_at" > $6) AS pendientes
           FROM "support_session" s
           JOIN empresas e ON e."distributor_id" = s."distributor_id"
          WHERE s."status" IN ('active', 'pending')
          GROUP BY s."distributor_id"
       )
       SELECT e."distributor_id" AS id,
              COALESCE(p.pedidos, 0) AS pedidos,
              COALESCE(p.ventas, 0) AS ventas,
              COALESCE(p.facturacion, 0)::text AS facturacion,
              COALESCE(ch.choferes, 0) AS choferes,
              COALESCE(cl.clientes, 0) AS clientes,
              actividad.ultima_actividad,
              COALESCE(s.activa, false) AS soporte_activo,
              COALESCE(s.pendientes, 0) AS soporte_pendiente
         FROM empresas e
         LEFT JOIN pedidos p ON p."distributor_id" = e."distributor_id"
         LEFT JOIN choferes ch ON ch."distributor_id" = e."distributor_id"
         LEFT JOIN clientes cl ON cl."distributor_id" = e."distributor_id"
         LEFT JOIN soporte s ON s."distributor_id" = e."distributor_id"
         LEFT JOIN LATERAL (
           SELECT MAX(actividad.at) AS ultima_actividad
             FROM (
               (SELECT o."createdAt" AS at
                  FROM "order" o
                 WHERE o."distributor_id" = e."distributor_id"
                 ORDER BY o."createdAt" DESC
                 LIMIT 1)
               UNION ALL
               (SELECT l."created_at" AS at
                  FROM "audit_log" l
                 WHERE l."distributor_id" = e."distributor_id"
                   AND l."actor_user_id" IS NOT NULL
                   AND l."actor_role" IS DISTINCT FROM '${RoleType.SUPER_ADMIN}'
                 ORDER BY l."created_at" DESC
                 LIMIT 1)
             ) actividad
         ) actividad ON true`,
      [ids, desde, hasta, OrderStatus.DELIVERED, PaymentStatus.PAID, ahora],
    );
    return filas.map((f) => ({
      id: String(f.id),
      pedidos: numero(f.pedidos),
      ventas: numero(f.ventas),
      facturacion: typeof f.facturacion === 'string' ? f.facturacion : '0',
      choferes: numero(f.choferes),
      clientes: numero(f.clientes),
      ultima_actividad: f.ultima_actividad
        ? new Date(f.ultima_actividad as string)
        : null,
      soporte_activo: f.soporte_activo === true,
      soporte_pendiente: numero(f.soporte_pendiente),
    }));
  }

  /**
   * Uso del lector de documentos por empresa en `[desde, hasta)`: lecturas que
   * llegaron al proveedor y su costo, igual que `gastoDelMes` de cada empresa.
   */
  async lector(
    ids: string[] | null,
    desde: Date,
    hasta: Date,
  ): Promise<FilaDeLector[]> {
    const filas = await this.ds.query<
      Array<{ id: string; lecturas: string; costo: string }>
    >(
      `/* plataforma:lector */
       SELECT r."distributor_id" AS id,
              COUNT(*) FILTER (WHERE r."input_tokens" > 0) AS lecturas,
              COALESCE(SUM(r."cost_usd"), 0)::text AS costo
         FROM "document_reading" r
        WHERE r."attempted_at" >= $2 AND r."attempted_at" < $3
          AND ($1::uuid[] IS NULL OR r."distributor_id" = ANY($1::uuid[]))
        GROUP BY r."distributor_id"`,
      [ids, desde, hasta],
    );
    return filas.map((f) => ({
      id: f.id,
      lecturas: numero(f.lecturas),
      costo: f.costo,
    }));
  }

  /** Los parámetros guardados del lector de cada empresa (el tope sale de acá). */
  async parametrosDelLector(
    ids: string[] | null,
  ): Promise<FilaDePresupuesto[]> {
    return this.ds.query<FilaDePresupuesto[]>(
      `/* plataforma:lector-parametros */
       SELECT m."distributor_id" AS id, m."params" AS params
         FROM "module_config" m
        WHERE m."module"::text = $2
          AND ($1::uuid[] IS NULL OR m."distributor_id" = ANY($1::uuid[]))`,
      [ids, ConfigurableProcess.DOCUMENT_READING],
    );
  }

  /** Los administradores de una empresa con su rol de personal y su último ingreso. */
  async admins(distributorId: string): Promise<FilaDeAdmin[]> {
    return this.ds.query<FilaDeAdmin[]>(
      `/* plataforma:admins */
       SELECT a."distributor_id", u."user_id", u."full_name", u."email",
              sr."name" AS staff_role, u."blocked",
              (SELECT MAX(au."created_at") FROM "audit" au
                WHERE au."user_id" = u."user_id" AND au."action_type_id" = $2) AS last_login_at,
              a."createdAt" AS created_at
         FROM "admin" a
         JOIN "user" u ON u."user_id" = a."user_id" AND u."deletedAt" IS NULL
         LEFT JOIN "staff_role" sr ON sr."staff_role_id" = a."staff_role_id"
        WHERE a."distributor_id" = $1
        ORDER BY u."full_name", u."user_id"`,
      [distributorId, AuditActionTypeId.LOGIN],
    );
  }

  /** Las últimas sesiones de soporte de una empresa (las más nuevas primero). */
  async sesionesRecientes(
    distributorId: string,
    limite: number,
  ): Promise<FilaDeSesion[]> {
    return this.ds.query<FilaDeSesion[]>(
      `/* plataforma:sesiones */
       SELECT s."support_session_id" AS id, s."distributor_id", s."kind"::text AS kind,
              s."status"::text AS status, u."full_name" AS requested_by_name, s."reason",
              s."requested_minutes", s."created_at", s."started_at", s."expires_at",
              s."ended_at", s."end_reason"
         FROM "support_session" s
         LEFT JOIN "user" u ON u."user_id" = s."requested_by"
        WHERE s."distributor_id" = $1
        ORDER BY s."created_at" DESC, s."support_session_id" DESC
        LIMIT $2`,
      [distributorId, limite],
    );
  }

  /**
   * La actividad de la plataforma, las más nuevas primero: lo que escribieron
   * los administradores generales (auditoría HTTP), los cambios de empresas y
   * de sesiones de soporte (también los que hace una empresa al aprobar o
   * revocar) y los ingresos de los administradores generales. No sale el
   * detalle de los cambios ni el texto de los errores: sólo quién, qué, cuándo.
   */
  async actividad(filtro: FiltroDeActividad): Promise<FilaDeActividad[]> {
    const filas = await this.ds.query<Array<Record<string, unknown>>>(
      `/* plataforma:actividad */
       WITH actividad AS (
         SELECT l."audit_id"::text AS id, l."created_at" AS at, 'request' AS kind,
                l."actor_user_id", l."actor_role", l."http_method" AS method,
                l."resource", l."resource_id", l."path", l."distributor_id",
                l."result"::text AS result, l."status_code"
           FROM "audit_log" l
          WHERE l."actor_role" = $1 OR l."resource" = ANY($2::text[])
         UNION ALL
         SELECT au."audit_id"::text, au."created_at", 'login',
                au."user_id", $1, NULL, 'auth', NULL, NULL, NULL,
                '${AuditResult.SUCCESS}', 200
           FROM "audit" au
           JOIN "user" u ON u."user_id" = au."user_id"
           JOIN "role" r ON r."role_id" = u."role_id"
          WHERE au."action_type_id" = $3 AND r."type" = $1
       )
       SELECT x.*, u."full_name" AS actor_name, d."name" AS distributor_name,
              COUNT(*) OVER () AS total
         FROM actividad x
         LEFT JOIN "user" u ON u."user_id" = x."actor_user_id"
         LEFT JOIN "distributor" d ON d."distributor_id" = x."distributor_id"
        WHERE ($4::timestamptz IS NULL OR x.at >= $4)
          AND ($5::timestamptz IS NULL OR x.at < $5)
          AND ($6::uuid IS NULL OR x."actor_user_id" = $6)
          AND ($7::uuid IS NULL OR x."distributor_id" = $7)
        ORDER BY x.at DESC, x.id DESC
        LIMIT $8 OFFSET $9`,
      [
        RoleType.SUPER_ADMIN,
        [...RECURSOS_DE_PLATAFORMA],
        AuditActionTypeId.LOGIN,
        filtro.desde,
        filtro.hasta,
        filtro.actorUserId,
        filtro.distributorId,
        filtro.limit,
        filtro.offset,
      ],
    );
    return filas.map((f) => ({
      id: String(f.id),
      at: new Date(f.at as string),
      kind: f.kind === 'login' ? 'login' : 'request',
      actor_user_id: (f.actor_user_id as string | null) ?? null,
      actor_name: (f.actor_name as string | null) ?? null,
      actor_role: (f.actor_role as string | null) ?? null,
      method: (f.method as string | null) ?? null,
      resource: String(f.resource),
      resource_id: (f.resource_id as string | null) ?? null,
      path: (f.path as string | null) ?? null,
      distributor_id: (f.distributor_id as string | null) ?? null,
      distributor_name: (f.distributor_name as string | null) ?? null,
      result: String(f.result),
      status_code: numero(f.status_code),
      total: numero(f.total),
    }));
  }

  /** Cuántas filas tiene la actividad con ese filtro (cuando la página quedó vacía). */
  async totalDeActividad(filtro: FiltroDeActividad): Promise<number> {
    const filas = await this.actividad({ ...filtro, limit: 1, offset: 0 });
    return filas[0]?.total ?? 0;
  }
}

/** Una venta: entregado y cobrado en el período (el criterio de los reportes). */
const VENTA = `o."status"::text = $4 AND o."paymentStatus"::text = $5 AND o."deliveredAt" >= $2 AND o."deliveredAt" < $3`;

const COLUMNAS_DE_EMPRESA = `d."distributor_id" AS id, d."name", d."slug", d."legal_name", d."tax_id",
       d."email", d."status"::text AS status, d."owned_by_platform", d."plan",
       d."createdAt" AS created_at, d."support_emergency_allowed", d."support_auto_approve"`;
