import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AuditActionTypeId } from '../entities/audit-action-type.entity';

/** Por dónde entró: las apps o el panel (`POST /auth/login/dashboard`). */
export type CanalDeIngreso = 'app' | 'panel';

export interface IngresoAuditado {
  ok: boolean;
  email: string;
  canal: CanalDeIngreso;
  /** Cabecera `X-Client-Source`. */
  origen: string | null;
  ip: string | null;
  /** Por qué falló (texto fijo, nunca el mensaje de Firebase). Sólo si `!ok`. */
  motivo?: string;
}

interface CuentaDelIngreso {
  user_id: string;
  distributor_id: string | null;
}

/**
 * Asienta en la auditoría los ingresos a la sesión: entidad `Sesion`, acción
 * `Ingreso` o `Ingreso fallido`. El detalle lleva el email, el canal, el origen
 * y el motivo; nunca la contraseña ni el token.
 *
 *  - Ingreso correcto: a nombre de la cuenta, con la distribuidora de su perfil
 *    de admin o chofer; `record_id` es su id.
 *  - Ingreso fallido: sin usuario (no se le atribuye al dueño de la cuenta
 *    el intento de un tercero); `record_id` es el email intentado. Si la cuenta
 *    existe, su id va en el detalle `cuenta` y el asiento queda en su
 *    distribuidora, para que el admin vea los intentos contra sus cuentas.
 *
 * No hay endpoint de salida (el token vive en Firebase y vence solo): la acción
 * `Salida` está en el catálogo para cuando lo haya.
 */
@Injectable()
export class SesionAuditService {
  private readonly logger = new Logger(SesionAuditService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Nunca rompe el ingreso: si la auditoría falla, se registra en el log. */
  async registrarIngreso(ingreso: IngresoAuditado): Promise<void> {
    const email = ingreso.email.trim().slice(0, 200);
    try {
      const [cuenta] = await this.dataSource.query<CuentaDelIngreso[]>(
        `SELECT u.user_id,
                COALESCE(
                  (SELECT a.distributor_id FROM "admin" a WHERE a.user_id = u.user_id),
                  (SELECT d.distributor_id FROM "delivery" d WHERE d.user_id = u.user_id)
                ) AS distributor_id
           FROM "user" u WHERE lower(u.email) = lower($1::text) LIMIT 1`,
        [email],
      );
      const detalles = [
        { field: 'email', value: email },
        { field: 'canal', value: ingreso.canal },
        { field: 'origen', value: ingreso.origen?.slice(0, 60) ?? null },
        ...(ingreso.ok
          ? []
          : [
              { field: 'motivo', value: ingreso.motivo ?? null },
              { field: 'cuenta', value: cuenta?.user_id ?? null },
            ]),
      ].filter((d) => d.value !== null);
      const aNombreDeLaCuenta = ingreso.ok && cuenta;
      await this.dataSource.query(
        `WITH cabecera AS (
           INSERT INTO "audit"
             ("audit_id", "action_type_id", "user_id", "distributor_id",
              "entity", "record_id", "ip", "source", "app_name")
           VALUES ($1::uuid, $2::smallint, $3::uuid, $4::uuid, 'Sesion',
                   $5::text, $6::text, 'app',
                   left(current_setting('application_name'), 63))
         )
         INSERT INTO "audit_detail" ("audit_detail_id", "audit_id", "field", "new_value")
         SELECT gen_random_uuid(), $1::uuid, d.field, d.value
           FROM jsonb_to_recordset($7::jsonb) AS d(field text, value text)`,
        [
          randomUUID(),
          ingreso.ok ? AuditActionTypeId.LOGIN : AuditActionTypeId.LOGIN_FAILED,
          aNombreDeLaCuenta ? cuenta.user_id : null,
          cuenta?.distributor_id ?? null,
          aNombreDeLaCuenta ? cuenta.user_id : email.slice(0, 64),
          ingreso.ip?.slice(0, 45) ?? null,
          JSON.stringify(detalles),
        ],
      );
    } catch (error) {
      this.logger.error(
        `No se pudo asentar el ingreso: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
