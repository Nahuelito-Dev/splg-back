import { Injectable } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import {
  completarPlantilla,
  nombreDelAsistente,
  respuestaAutomaticaDeLaEmpresa,
} from '../domain/bandeja';
import {
  MessageKind,
  MessageTemplateScope,
  MessageVisibility,
  Party,
  PLANTILLA_FUERA_DE_HORARIO,
  PLANTILLA_RECIBIDO,
  SystemCode,
} from '../domain/chat.enums';
import { estaAbierto } from '../domain/horario';
import {
  atiendeLaEmpresa,
  proximaAtencion,
} from '../domain/horario-de-la-empresa';
import {
  avisoDeRecibidoPorDefecto,
  respuestaAutomatica,
} from '../domain/respuestas-automaticas';
import type { Conversation } from '../entities/conversation.entity';
import { MessageTemplate } from '../entities/message-template.entity';
import type { Efectos } from './chat.events';
import { ChatViewsService } from './chat-views.service';
import {
  CompanyChatSettingsService,
  horarioDe,
  textoDeRecibido,
  textoFueraDeHorario,
} from './company-chat-settings.service';
import { MessageWriter } from './message-writer';
import { SupportSettingsService } from './support-settings.service';
import { valoresDePlantilla } from './valores-de-plantilla';

/** Texto de la respuesta automática si la plataforma no cargó la suya. */
export const RESPUESTA_FUERA_DE_HORARIO =
  'Ahora no hay nadie en línea. ¿Querés que lo convirtamos en un ticket? Te respondemos según la prioridad.';

/** El aviso de recibido en horario: mensaje de sistema con el texto configurado (D-C29). */
export function avisoDeRecibido(chat: Conversation, body: string) {
  return {
    conversationId: chat.conversationId,
    distributorId: chat.distributorId,
    senderParty: Party.SYSTEM,
    senderUserId: null,
    clientMessageId: null,
    kind: MessageKind.SYSTEM,
    visibility: MessageVisibility.ALL,
    body,
    payload: null,
    systemCode: SystemCode.RECEIVED_ACK,
    templateKey: PLANTILLA_RECIBIDO,
  };
}

/**
 * Las respuestas fijas, sin IA (capa fija del asistente, DISENO-CH-BOT §3):
 * fuera de horario y aviso de recibido, de la empresa a su cliente (C3) y del
 * soporte de la plataforma a la empresa (C1). Las manda el envío cuando la IA
 * no se encarga, y el asistente cuando la IA no corre (tope o falla). La
 * conversación está bloqueada por quien llama: dos mensajes simultáneos no
 * disparan dos respuestas. `true` si escribió una. Las notas internas (4a) no
 * cuentan como que el equipo escribió: el cliente no las ve.
 */
@Injectable()
export class RespuestasFijas {
  constructor(
    private readonly writer: MessageWriter,
    private readonly ajustes: CompanyChatSettingsService,
    private readonly soporte: SupportSettingsService,
    private readonly vistas: ChatViewsService,
  ) {}

  /**
   * Al mensaje del cliente (§8.4, D-C29): fuera de horario, una sola por
   * período cerrado (el período lo identifica su fin, la próxima apertura,
   * guardado en el mensaje); en horario, el aviso de recibido una vez por
   * conversación si nadie de la empresa escribió.
   */
  async deLaEmpresa(
    manager: EntityManager,
    c: Conversation,
    efectos: Efectos,
    ahora: Date,
  ): Promise<boolean> {
    const ajustes = await this.ajustes.leer(c.distributorId, manager);
    const h = horarioDe(ajustes);
    const enHorario = atiendeLaEmpresa(h, ahora);
    const abre = enHorario ? null : proximaAtencion(h, ahora);
    const periodo = abre ? abre.toISOString() : 'sin-apertura';
    const [estado]: Array<{
      fuera: boolean;
      recibido: boolean;
      empresa: boolean;
    }> = await manager.query(
      `SELECT EXISTS (SELECT 1 FROM "message" WHERE "conversation_id" = $1
                         AND "kind" = 'auto_reply' AND "template_key" = 'fuera_de_horario'
                         AND "payload" ->> 'until' = $2) AS fuera,
              EXISTS (SELECT 1 FROM "message" WHERE "conversation_id" = $1
                         AND "kind" = 'system' AND "system_code" = '${SystemCode.RECEIVED_ACK}') AS recibido,
              EXISTS (SELECT 1 FROM "message" WHERE "conversation_id" = $1
                         AND "sender_party" = 'company' AND "visibility" = 'all') AS empresa`,
      [c.conversationId, periodo],
    );
    const cual = respuestaAutomaticaDeLaEmpresa({
      enHorario,
      fueraDeHorarioHabilitado: ajustes.outOfHoursEnabled,
      yaSeRespondioEnEstePeriodo: estado?.fuera ?? false,
      avisoDeRecibidoHabilitado: ajustes.ackEnabled,
      yaSeAvisoRecibido: estado?.recibido ?? false,
      empresaYaEscribio: estado?.empresa ?? false,
    });
    if (cual === null) return false;
    const valores = await valoresDePlantilla(manager, c, ajustes, ahora);
    const fuera = cual === 'fuera_de_horario';
    // La firma queda con el mensaje: cambiar después el nombre del asistente
    // no reescribe el historial.
    const senderLabel = nombreDelAsistente(
      ajustes.assistantName,
      valores['empresa.nombre'] ?? '',
    );
    const r = await this.writer.escribir(manager, {
      conversationId: c.conversationId,
      distributorId: c.distributorId,
      senderParty: Party.SYSTEM,
      senderUserId: null,
      clientMessageId: null,
      kind: fuera ? MessageKind.AUTO_REPLY : MessageKind.SYSTEM,
      visibility: MessageVisibility.ALL,
      body: completarPlantilla(
        fuera ? textoFueraDeHorario(ajustes) : textoDeRecibido(ajustes),
        valores,
      ),
      payload: fuera ? { until: periodo, senderLabel } : { senderLabel },
      systemCode: fuera ? null : SystemCode.RECEIVED_ACK,
      templateKey: fuera ? 'fuera_de_horario' : 'recibido',
    });
    efectos.mensaje(r.conversation, r.message);
    return true;
  }

  /**
   * Al mensaje de la empresa en el chat con la plataforma (D-C29): en
   * horario, el aviso de recibido (mensaje de sistema: no es primera respuesta
   * ni cuenta como sin leer), una vez por apertura; fuera de horario, la que
   * ofrece pasarlo a un ticket, una vez hasta que la plataforma vuelva a
   * escribir.
   */
  async delSoporte(
    manager: EntityManager,
    chat: Conversation,
    efectos: Efectos,
    ahora: Date,
  ): Promise<boolean> {
    const ajustes = await this.soporte.leer(manager);
    const [estado]: Array<{
      recibido: boolean;
      plataforma: boolean;
      fuera: boolean;
    }> = await manager.query(
      `SELECT EXISTS (SELECT 1 FROM "message" WHERE "conversation_id" = $1
                         AND "kind" = 'system' AND "system_code" = '${SystemCode.RECEIVED_ACK}') AS recibido,
              EXISTS (SELECT 1 FROM "message" WHERE "conversation_id" = $1
                         AND "sender_party" = 'platform' AND "visibility" = 'all') AS plataforma,
              EXISTS (
                SELECT 1 FROM "message" a
                 WHERE a."conversation_id" = $1 AND a."kind" = 'auto_reply'
                   AND a."seq" > COALESCE((SELECT max(p."seq") FROM "message" p
                                            WHERE p."conversation_id" = $1 AND p."sender_party" = 'platform'
                                              AND p."visibility" = 'all'), 0)
              ) AS fuera`,
      [chat.conversationId],
    );
    const cual = respuestaAutomatica({
      enHorario: estaAbierto(ajustes.chatHours, ajustes.timezone, ahora),
      avisoDeRecibidoHabilitado: ajustes.chatAckEnabled,
      yaSeAvisoRecibido: estado?.recibido ?? false,
      plataformaYaEscribio: estado?.plataforma ?? false,
      yaSeRespondioFueraDeHorario: estado?.fuera ?? false,
    });
    if (cual === null) return false;
    const r = await this.writer.escribir(
      manager,
      cual === 'recibido'
        ? avisoDeRecibido(
            chat,
            ajustes.chatAckMessage ??
              avisoDeRecibidoPorDefecto(this.vistas.nombreDeLaPlataforma()),
          )
        : {
            ...avisoDeRecibido(chat, ''),
            kind: MessageKind.AUTO_REPLY,
            systemCode: null,
            templateKey: PLANTILLA_FUERA_DE_HORARIO,
            body:
              (
                await manager.getRepository(MessageTemplate).findOne({
                  where: {
                    distributorId: IsNull(),
                    scope: MessageTemplateScope.AUTO_REPLY,
                    key: PLANTILLA_FUERA_DE_HORARIO,
                    active: true,
                  },
                })
              )?.body ?? RESPUESTA_FUERA_DE_HORARIO,
          },
    );
    efectos.mensaje(r.conversation, r.message);
    return true;
  }
}
