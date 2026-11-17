import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { CanalDeLaBandeja } from '../domain/bandeja';
import type {
  EnLaCola,
  EstadoDelAgente,
} from '../domain/asignacion-automatica';

/** Lo guardado de una persona del equipo (`chat_agent_settings`). */
export interface AjustesDelAgente {
  status: EstadoDelAgente;
  statusChangedAt: Date;
  maxOpenOverride: number | null;
  lastAssignedAt: Date | null;
}

const fecha = (v: Date | string | null): Date | null =>
  v === null ? null : new Date(v);

/**
 * Lo que la asignación automática (8b) lee y escribe en la base: el estado y
 * el tope de cada persona, cuántas abiertas tiene asignadas cada una y la
 * cola de las que esperan a una persona. Todo dentro de la transacción de
 * quien llama y siempre acotado a una empresa.
 */
@Injectable()
export class AgentesDeLaBandeja {
  /** Lo guardado de cada persona de la empresa que alguna vez eligió estado o tope. */
  async ajustes(
    manager: EntityManager,
    distributorId: string,
  ): Promise<Map<string, AjustesDelAgente>> {
    const filas: Array<{
      user_id: string;
      status: EstadoDelAgente;
      status_changed_at: Date | string;
      max_open_override: number | string | null;
      last_assigned_at: Date | string | null;
    }> = await manager.query(
      `SELECT "user_id", "status", "status_changed_at", "max_open_override", "last_assigned_at"
         FROM "chat_agent_settings" WHERE "distributor_id" = $1`,
      [distributorId],
    );
    return new Map(
      filas.map((f) => [
        f.user_id,
        {
          status: f.status,
          statusChangedAt: new Date(f.status_changed_at),
          maxOpenOverride:
            f.max_open_override === null ? null : Number(f.max_open_override),
          lastAssignedAt: fecha(f.last_assigned_at),
        },
      ]),
    );
  }

  /** Las conversaciones abiertas de la bandeja asignadas a cada persona (los dos canales). */
  async abiertasPorPersona(
    manager: EntityManager,
    distributorId: string,
  ): Promise<Map<string, number>> {
    const filas: Array<{ user_id: string; n: string | number }> =
      await manager.query(
        `SELECT "assigned_to_user_id" AS "user_id", count(*) AS "n"
           FROM "conversation"
          WHERE "distributor_id" = $1 AND "status" = 'open' AND "deleted_at" IS NULL
            AND "channel" IN ('staff_customer', 'staff_driver')
            AND "assigned_to_user_id" IS NOT NULL
          GROUP BY "assigned_to_user_id"`,
        [distributorId],
      );
    return new Map(filas.map((f) => [f.user_id, Number(f.n)]));
  }

  /**
   * La cola: abiertas de la bandeja, sin asignar y esperando a una persona,
   * la que espera hace más primero. Por canal, sólo las que se pueden dar en
   * esta vuelta (`porCanal`: el lugar libre de ese canal); un canal sin lugar
   * ni se mira. Las bloquea (`FOR UPDATE`) y saltea las que otra operación
   * tiene tomadas (una asignación a mano en curso): ésas quedan para la
   * próxima vuelta. Cada una con la última persona del equipo que le respondió.
   */
  async cola(
    manager: EntityManager,
    distributorId: string,
    porCanal: ReadonlyMap<CanalDeLaBandeja, number>,
  ): Promise<EnLaCola[]> {
    const filas: Array<{
      conversation_id: string;
      channel: CanalDeLaBandeja;
      desde: Date | string;
    }> = [];
    for (const [canal, limite] of porCanal) {
      if (limite <= 0) continue;
      const delCanal: typeof filas = await manager.query(
        `SELECT "conversation_id", "channel", "awaiting_human_since" AS "desde"
           FROM "conversation"
          WHERE "distributor_id" = $1 AND "channel" = $2 AND "status" = 'open'
            AND "deleted_at" IS NULL
            AND "assigned_to_user_id" IS NULL AND "awaiting_human_since" IS NOT NULL
          ORDER BY "awaiting_human_since" ASC, "conversation_id" ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED`,
        [distributorId, canal, limite],
      );
      filas.push(...delCanal);
    }
    if (filas.length === 0) return [];
    filas.sort(
      (a, b) =>
        new Date(a.desde).getTime() - new Date(b.desde).getTime() ||
        a.conversation_id.localeCompare(b.conversation_id),
    );
    const preferidos = await this.ultimosQueRespondieron(
      manager,
      filas.map((f) => f.conversation_id),
    );
    return filas.map((f) => ({
      conversationId: f.conversation_id,
      canal: f.channel,
      preferido: preferidos.get(f.conversation_id) ?? null,
    }));
  }

  /** De cada conversación, la última persona del equipo que le escribió a la otra punta (no notas internas). */
  async ultimosQueRespondieron(
    manager: EntityManager,
    conversationIds: readonly string[],
  ): Promise<Map<string, string>> {
    const filas: Array<{ conversation_id: string; sender_user_id: string }> =
      await manager.query(
        `SELECT DISTINCT ON ("conversation_id") "conversation_id", "sender_user_id"
           FROM "message"
          WHERE "conversation_id" = ANY($1::uuid[]) AND "sender_party" = 'company'
            AND "visibility" = 'all' AND "deleted_at" IS NULL
            AND "sender_user_id" IS NOT NULL
          ORDER BY "conversation_id", "seq" DESC`,
        [conversationIds],
      );
    return new Map(filas.map((f) => [f.conversation_id, f.sender_user_id]));
  }

  /** Elige «en línea» o «ausente»; `status_changed_at` sólo se mueve si cambió. */
  async guardarEstado(
    manager: EntityManager,
    distributorId: string,
    userId: string,
    status: EstadoDelAgente,
    ahora: Date,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO "chat_agent_settings" ("distributor_id", "user_id", "status", "status_changed_at")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("distributor_id", "user_id") DO UPDATE
         SET "status" = EXCLUDED."status",
             "status_changed_at" = CASE WHEN "chat_agent_settings"."status" = EXCLUDED."status"
                                        THEN "chat_agent_settings"."status_changed_at"
                                        ELSE EXCLUDED."status_changed_at" END,
             "updated_at" = now()
       WHERE "chat_agent_settings"."status" IS DISTINCT FROM EXCLUDED."status"`,
      [distributorId, userId, status, ahora],
    );
  }

  /** El tope propio de una persona (`null`: el de la empresa). */
  async guardarTope(
    manager: EntityManager,
    distributorId: string,
    userId: string,
    tope: number | null,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO "chat_agent_settings" ("distributor_id", "user_id", "max_open_override")
       VALUES ($1, $2, $3)
       ON CONFLICT ("distributor_id", "user_id") DO UPDATE
         SET "max_open_override" = EXCLUDED."max_open_override", "updated_at" = now()
       WHERE "chat_agent_settings"."max_open_override" IS DISTINCT FROM EXCLUDED."max_open_override"`,
      [distributorId, userId, tope],
    );
  }

  /** Recibió una por asignación automática (desempate de la próxima). */
  async marcarAsignacion(
    manager: EntityManager,
    distributorId: string,
    userId: string,
    ahora: Date,
  ): Promise<void> {
    await manager.query(
      `UPDATE "chat_agent_settings" SET "last_assigned_at" = $3, "updated_at" = now()
        WHERE "distributor_id" = $1 AND "user_id" = $2`,
      [distributorId, userId, ahora],
    );
  }

  /** Las empresas vigentes con la asignación automática prendida (para la tarea programada). */
  async empresasConLaFuncion(manager: EntityManager): Promise<string[]> {
    const filas: Array<{ distributor_id: string }> = await manager.query(
      `SELECT s."distributor_id" FROM "chat_company_settings" s
         JOIN "distributor" d ON d."distributor_id" = s."distributor_id" AND d."deletedAt" IS NULL
        WHERE s."auto_assign_enabled"
        ORDER BY s."distributor_id"`,
    );
    return filas.map((f) => f.distributor_id);
  }
}
