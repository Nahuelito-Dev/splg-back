import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import {
  registrarElementoBien,
  registrarFallaDeElemento,
} from '../../process-run/process-run.context';
import {
  type FilaDelHilo,
  MINUTOS_DE_SILENCIO_TRAS_UNA_PERSONA,
  type MotivoParaCallarse,
  motivoParaCallarse,
  puntasDelAsistente,
} from '../domain/asistente-del-hilo';
import { Channel, type MessageKind, type Party } from '../domain/chat.enums';
import type { Conversation } from '../entities/conversation.entity';
import { CompanyChatSettingsService } from './company-chat-settings.service';
import { SupportSettingsService } from './support-settings.service';

/** El mensaje que dispara al asistente. */
export interface Disparador {
  seq: number;
  messageId: string;
}

/**
 * Si el asistente con IA se encarga de un mensaje (DISENO-CH-BOT B3). Lo usa
 * el envío (si la IA se encarga, no van las respuestas fijas de recibido ni
 * de fuera de horario: la IA las reemplaza) y el asistente (antes de
 * consultar y antes de publicar), con la misma regla y las mismas filas.
 */
@Injectable()
export class AsistenteDelChat {
  private readonly logger = new Logger(AsistenteDelChat.name);

  constructor(
    private readonly acceso: AccesoDeLaEmpresa,
    private readonly ajustes: CompanyChatSettingsService,
    private readonly soporte: SupportSettingsService,
  ) {}

  /**
   * La IA está prendida para la base de esa conversación: en C3, función
   * habilitada a la empresa, su interruptor y el chat de clientes; en C1, el
   * interruptor de la plataforma. Nunca en otro canal.
   */
  async prendido(
    c: Pick<Conversation, 'channel' | 'distributorId'>,
    manager?: EntityManager,
  ): Promise<boolean> {
    if (!puntasDelAsistente(c.channel)) return false;
    if (c.channel === Channel.PLATFORM_CHAT) {
      return (await this.soporte.leer(manager)).assistantAiEnabled;
    }
    const a = await this.ajustes.leer(c.distributorId, manager);
    if (!a.assistantAiEnabled || !a.customerChatEnabled) return false;
    return this.acceso.habilitado(c.distributorId, 'assistant');
  }

  /**
   * Apaga el interruptor de las empresas que lo tienen prendido pero ya no
   * tienen la función (venció la excepción que la habilitaba, cambió el
   * plan): al volver a habilitarla, el asistente no se pone a contestar solo
   * sin que el admin lo prenda. Quitarla a mano ya lo apaga en la misma
   * operación (`ModulosDeLaEmpresaRepository.guardarExcepcion`). Lo corre el
   * rescate cada minuto; la auditoría lo asienta como del sistema. Cada
   * empresa por su lado: la que falla (el acceso no se puede calcular, la
   * fila no se puede actualizar) queda en el log y en el monitoreo y se
   * reintenta en la próxima corrida, sin frenar a las demás ni al rescate.
   */
  async apagarDondeNoEstaHabilitado(manager: EntityManager): Promise<number> {
    const prendidas: Array<{ distributor_id: string }> = await manager.query(
      `SELECT "distributor_id" FROM "chat_company_settings" WHERE "assistant_ai_enabled"`,
    );
    let apagadas = 0;
    for (const { distributor_id } of prendidas) {
      try {
        if (!(await this.acceso.habilitado(distributor_id, 'assistant'))) {
          await manager.query(
            `UPDATE "chat_company_settings"
                SET "assistant_ai_enabled" = false, "updated_at" = now(), "updated_by_user_id" = NULL
              WHERE "distributor_id" = $1 AND "assistant_ai_enabled"`,
            [distributor_id],
          );
          apagadas += 1;
        }
        registrarElementoBien(`empresa:${distributor_id}`);
      } catch (error) {
        registrarFallaDeElemento(`empresa:${distributor_id}`, error);
        this.logger.error(
          `Asistente con IA: no se pudo revisar si la distribuidora ${distributor_id} sigue con la función: ${errorMessage(error)}`,
        );
      }
    }
    return apagadas;
  }

  /** `null` si el asistente tiene que atender el mensaje; si no, por qué se calla. */
  async motivoParaCallarse(
    manager: EntityManager,
    c: Conversation,
    disparador: Disparador,
    ahora: Date,
  ): Promise<MotivoParaCallarse | null> {
    const puntas = puntasDelAsistente(c.channel);
    if (!puntas) return 'taken';
    const filas = await this.filasDelHilo(
      manager,
      c.conversationId,
      disparador.seq,
      ahora,
    );
    return motivoParaCallarse(c, filas, disparador, puntas, ahora);
  }

  /** Para el envío: la IA prendida y el mensaje es suyo (entonces no van las respuestas fijas). */
  async seEncarga(
    manager: EntityManager,
    c: Conversation,
    disparador: Disparador,
    ahora: Date,
  ): Promise<boolean> {
    if (!(await this.prendido(c, manager))) return false;
    return (
      (await this.motivoParaCallarse(manager, c, disparador, ahora)) === null
    );
  }

  /**
   * Las filas del hilo desde el disparador y las de las últimas horas (para
   * saber si alguien del equipo escribió hace poco). Sin texto.
   */
  async filasDelHilo(
    manager: EntityManager,
    conversationId: string,
    desdeSeq: number,
    ahora: Date,
  ): Promise<FilaDelHilo[]> {
    const desde = new Date(
      ahora.getTime() - MINUTOS_DE_SILENCIO_TRAS_UNA_PERSONA * 60_000,
    );
    const filas: Array<{
      seq: string | number;
      message_id: string;
      sender_party: Party;
      kind: MessageKind;
      de_la_ia: boolean;
      created_at: Date | string;
      retirado: boolean;
    }> = await manager.query(
      `SELECT "seq", "message_id", "sender_party", "kind",
              COALESCE("payload" ? 'ai', false) AS "de_la_ia", "created_at",
              ("withdrawn_at" IS NOT NULL OR "redacted_at" IS NOT NULL OR "deleted_at" IS NOT NULL) AS "retirado"
         FROM "message"
        WHERE "conversation_id" = $1 AND "visibility" = 'all'
          AND ("seq" >= $2 OR "created_at" >= $3)
        ORDER BY "seq"`,
      [conversationId, desdeSeq, desde],
    );
    return filas.map((f) => ({
      seq: Number(f.seq),
      messageId: f.message_id,
      senderParty: f.sender_party,
      kind: f.kind,
      deLaIa: Boolean(f.de_la_ia),
      createdAt: new Date(f.created_at),
      retirado: Boolean(f.retirado),
    }));
  }
}

/**
 * Alguien del equipo escribió: la conversación deja de esperar a una persona
 * (el asistente con IA la había derivado).
 */
export async function dejaDeEsperarPersona(
  manager: EntityManager,
  c: Conversation,
): Promise<void> {
  if (!c.awaitingHumanSince) return;
  await manager.query(
    `UPDATE "conversation" SET "awaiting_human_since" = NULL WHERE "conversation_id" = $1`,
    [c.conversationId],
  );
  c.awaitingHumanSince = null;
}
