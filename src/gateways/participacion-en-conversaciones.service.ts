import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** Lo mínimo de una conversación para decidir quién puede entrar a su sala. */
export interface ConversacionParaSala {
  distributorId: string;
  channel: string;
}

/** Canales cuyas salas existen hoy (C1: chat con la plataforma e hilo de ticket). */
export const CANALES_CON_SALA: ReadonlySet<string> = new Set([
  'platform_chat',
  'platform_ticket',
]);

/**
 * Lectura de la conversación para la sala por conversación (D-C28): el socket
 * no confía en lo que mande el cliente y lo resuelve contra la base. Sólo
 * lectura (el chat es dueño de la tabla); una conversación dada de baja no
 * existe.
 */
@Injectable()
export class ParticipacionEnConversaciones {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async deConversacion(
    conversationId: string,
  ): Promise<ConversacionParaSala | null> {
    const filas: Array<{ distributor_id: string; channel: string }> =
      await this.dataSource.query(
        `SELECT "distributor_id", "channel" FROM "conversation"
          WHERE "conversation_id" = $1 AND "deleted_at" IS NULL`,
        [conversationId],
      );
    const f = filas[0];
    return f ? { distributorId: f.distributor_id, channel: f.channel } : null;
  }
}
