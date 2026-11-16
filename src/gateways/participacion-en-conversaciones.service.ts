import { Injectable, Optional } from '@nestjs/common';
import { AccesoDeLaEmpresa } from '../platform/access/acceso-de-la-empresa.service';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** Lo mínimo de una conversación para decidir quién puede entrar a su sala. */
export interface ConversacionParaSala {
  distributorId: string;
  channel: string;
  /** La persona de la bandeja (C3 / C2); nulas en C1. */
  customerUserId: string | null;
  driverUserId: string | null;
}

/** Canales cuyas salas existen hoy: C1 (chat con la plataforma e hilo de ticket) y la bandeja (C3, C2). */
export const CANALES_CON_SALA: ReadonlySet<string> = new Set([
  'platform_chat',
  'platform_ticket',
  'staff_customer',
  'staff_driver',
]);

/** El permiso del personal que abre la sala de cada canal del lado de la empresa. */
export const PERMISO_DE_LA_SALA = {
  platform_chat: 'soporte.ver',
  platform_ticket: 'soporte.ver',
  staff_customer: 'mensajes.clientes',
  staff_driver: 'mensajes.choferes',
} as const;

/** El permiso para «escribir» (y mandar el «escribiendo…») en cada canal del lado de la empresa. */
export const PERMISO_PARA_ESCRIBIR = {
  platform_chat: 'soporte.gestionar',
  platform_ticket: 'soporte.gestionar',
  staff_customer: 'mensajes.clientes',
  staff_driver: 'mensajes.choferes',
} as const;

export type CanalConSala = keyof typeof PERMISO_DE_LA_SALA;

export function esCanalConSala(canal: string): canal is CanalConSala {
  return CANALES_CON_SALA.has(canal);
}

/**
 * Lectura de la conversación para la sala por conversación (D-C28): el socket
 * no confía en lo que mande el cliente y lo resuelve contra la base. Sólo
 * lectura (el chat es dueño de la tabla); una conversación dada de baja no
 * existe.
 */
@Injectable()
export class ParticipacionEnConversaciones {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly acceso?: AccesoDeLaEmpresa,
  ) {}

  /** La bandeja es del módulo `chat`: apagado para la empresa, nadie entra a sus salas. */
  async chatHabilitado(distributorId: string): Promise<boolean> {
    return this.acceso ? this.acceso.habilitado(distributorId, 'chat') : false;
  }

  /**
   * La persona sigue siendo de la empresa de la conversación y su cuenta está
   * vigente: el chofer con su perfil de reparto en esa empresa; el cliente con
   * vínculo vigente o algún pedido con ella.
   */
  async personaVigente(
    conversationId: string,
    userId: string,
    punta: 'customer' | 'driver',
  ): Promise<boolean> {
    const filas: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "conversation" c
         JOIN "user" u ON u."user_id" = $2 AND u."deletedAt" IS NULL AND u."blocked" = false
        WHERE c."conversation_id" = $1 AND c."deleted_at" IS NULL
          AND (($3 = 'customer' AND c."channel" = 'staff_customer' AND c."customer_user_id" = $2
                AND (EXISTS (SELECT 1 FROM "customer_distributor" cd
                              WHERE cd."user_id" = $2 AND cd."distributor_id" = c."distributor_id"
                                AND cd."removed_at" IS NULL)
                     OR EXISTS (SELECT 1 FROM "order" o
                                 WHERE o."customer_id" = $2 AND o."distributor_id" = c."distributor_id")))
            OR ($3 = 'driver' AND c."channel" = 'staff_driver' AND c."driver_user_id" = $2
                AND EXISTS (SELECT 1 FROM "delivery" d
                             WHERE d."user_id" = $2 AND d."distributor_id" = c."distributor_id"
                               AND d."deletedAt" IS NULL)))`,
      [conversationId, userId, punta],
    );
    return filas.length > 0;
  }

  async deConversacion(
    conversationId: string,
  ): Promise<ConversacionParaSala | null> {
    const filas: Array<{
      distributor_id: string;
      channel: string;
      customer_user_id: string | null;
      driver_user_id: string | null;
    }> = await this.dataSource.query(
      `SELECT "distributor_id", "channel", "customer_user_id", "driver_user_id"
         FROM "conversation"
        WHERE "conversation_id" = $1 AND "deleted_at" IS NULL`,
      [conversationId],
    );
    const f = filas[0];
    return f
      ? {
          distributorId: f.distributor_id,
          channel: f.channel,
          customerUserId: f.customer_user_id,
          driverUserId: f.driver_user_id,
        }
      : null;
  }
}
