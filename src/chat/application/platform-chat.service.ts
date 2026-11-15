import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  MessageKind,
  MessageTemplateScope,
  MessageVisibility,
  Party,
  PLANTILLA_FUERA_DE_HORARIO,
  PLANTILLA_RECIBIDO,
  SystemCode,
} from '../domain/chat.enums';
import {
  ConversacionCerradaError,
  ConversacionYaTomadaError,
} from '../domain/chat.errors';
import { estaAbierto } from '../domain/horario';
import {
  avisoDeRecibidoPorDefecto,
  respuestaAutomatica,
} from '../domain/respuestas-automaticas';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { MessageTemplate } from '../entities/message-template.entity';
import type { SendMessageDto } from '../presentation/dto/chat-input.dto';
import { ChatEvents, Efectos } from './chat.events';
import { ChatViewsService } from './chat-views.service';
import { ChatRateLimit } from './chat-rate-limit';
import { ConversationFactory } from './conversation-factory';
import { MensajeEscrito, MessageWriter } from './message-writer';
import { SupportSettingsService } from './support-settings.service';
import { assertEmpresaVigente } from './ticket-store';

/** Texto de la respuesta automática si la plataforma no cargó la suya. */
export const RESPUESTA_FUERA_DE_HORARIO =
  'Ahora no hay nadie en línea. ¿Querés que lo convirtamos en un ticket? Te respondemos según la prioridad.';

/**
 * Chat en vivo con la plataforma (C1a, diseño §4.2.1). Uno abierto por
 * empresa; el próximo mensaje después de cerrarse abre otro. Núcleo: lo usa
 * también una empresa restringida o suspendida.
 */
@Injectable()
export class PlatformChatService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly writer: MessageWriter,
    private readonly fabrica: ConversationFactory,
    private readonly ajustes: SupportSettingsService,
    private readonly cupos: ChatRateLimit,
    private readonly eventos: ChatEvents,
    private readonly vistas: ChatViewsService,
  ) {}

  abiertoDe(distributorId: string): Promise<Conversation | null> {
    return this.dataSource.getRepository(Conversation).findOne({
      where: {
        distributorId,
        channel: Channel.PLATFORM_CHAT,
        status: ConversationStatus.OPEN,
      },
    });
  }

  async historial(
    distributorId: string,
    pagina: { limit: number; offset: number },
  ): Promise<{ items: Conversation[]; total: number }> {
    const [items, total] = await this.dataSource
      .getRepository(Conversation)
      .findAndCount({
        where: {
          distributorId,
          channel: Channel.PLATFORM_CHAT,
          status: ConversationStatus.CLOSED,
        },
        order: { closedAt: 'DESC', conversationId: 'ASC' },
        take: pagina.limit,
        skip: pagina.offset,
      });
    return { items, total };
  }

  /** La empresa escribe: en el chat abierto o en uno nuevo. Fuera de horario, responde el sistema. */
  async enviarComoEmpresa(
    distributorId: string,
    userId: string,
    dto: SendMessageDto,
    ahora: Date = new Date(),
  ): Promise<MensajeEscrito> {
    await this.cupos.mensaje(userId, dto.clientMessageId);
    return this.enviarAlChatDeLaEmpresa(
      distributorId,
      Party.COMPANY,
      userId,
      dto,
      ahora,
    );
  }

  /** La plataforma le escribe a una empresa (crea su chat o usa el abierto) y queda atendiéndolo. */
  async enviarComoPlataforma(
    distributorId: string,
    userId: string,
    dto: SendMessageDto,
  ): Promise<MensajeEscrito> {
    await assertEmpresaVigente(this.dataSource.manager, distributorId);
    await this.cupos.mensaje(userId, dto.clientMessageId);
    return this.enviarAlChatDeLaEmpresa(
      distributorId,
      Party.PLATFORM,
      userId,
      dto,
      new Date(),
    );
  }

  /** La plataforma escribe en un chat puntual (409 si ya se cerró). */
  async responder(
    chatId: string,
    userId: string,
    dto: SendMessageDto,
  ): Promise<MensajeEscrito> {
    await this.cupos.mensaje(userId, dto.clientMessageId);
    const efectos = new Efectos();
    const escrito = await this.dataSource.transaction(async (manager) => {
      const chat = await this.chatDeLaPlataforma(manager, chatId);
      const r = await this.writer.escribir(
        manager,
        texto(chat, Party.PLATFORM, userId, dto),
      );
      if (r.created) {
        efectos.mensaje(r.conversation, r.message);
        await this.registrarPrimeraRespuesta(manager, r.conversation);
      }
      return r;
    });
    this.eventos.publicar(efectos);
    return escrito;
  }

  /** Un miembro de la plataforma toma el chat (lo atiende). */
  async tomar(chatId: string, userId: string): Promise<Conversation> {
    return this.cambiarAsignacion(chatId, userId, 'tomar');
  }

  /** Lo suelta: vuelve a la cola. */
  async soltar(chatId: string, userId: string): Promise<Conversation> {
    return this.cambiarAsignacion(chatId, userId, 'soltar');
  }

  /** Cierre a mano por la plataforma. No toca los tickets que salieron del chat. */
  async cerrar(chatId: string, userId: string): Promise<Conversation> {
    const efectos = new Efectos();
    const chat = await this.dataSource.transaction(async (manager) => {
      const c = await this.chatDeLaPlataforma(manager, chatId);
      if (c.status !== ConversationStatus.OPEN) {
        throw new ConversacionCerradaError();
      }
      return this.cerrarDentro(
        manager,
        c,
        ConversationClosedReason.MANUAL,
        userId,
        efectos,
      );
    });
    this.eventos.publicar(efectos);
    return chat;
  }

  /**
   * Cierra los chats sin mensajes hace más de `horas` (proceso automático).
   * Cada uno en su transacción, con la fila bloqueada y la condición vuelta a
   * mirar: si entró un mensaje en el medio, sigue abierto.
   */
  async cerrarInactivos(ahora: Date, horas: number): Promise<number> {
    const limite = new Date(ahora.getTime() - horas * 60 * 60 * 1000);
    const candidatos: Array<{ id: string }> = await this.dataSource.query(
      `SELECT "conversation_id" AS id FROM "conversation"
        WHERE "channel" = 'platform_chat' AND "status" = 'open' AND "deleted_at" IS NULL
          AND COALESCE("last_message_at", "created_at") < $1`,
      [limite],
    );
    let cerrados = 0;
    for (const { id } of candidatos) {
      const efectos = new Efectos();
      const cerrado = await this.dataSource.transaction(async (manager) => {
        const c = await manager.getRepository(Conversation).findOne({
          where: { conversationId: id },
          lock: { mode: 'pessimistic_write' },
        });
        const ultimo = c ? (c.lastMessageAt ?? c.createdAt) : null;
        if (
          !c ||
          c.status !== ConversationStatus.OPEN ||
          !ultimo ||
          ultimo.getTime() >= limite.getTime()
        ) {
          return false;
        }
        await this.cerrarDentro(
          manager,
          c,
          ConversationClosedReason.INACTIVITY,
          null,
          efectos,
        );
        return true;
      });
      if (cerrado) cerrados += 1;
      this.eventos.publicar(efectos);
    }
    return cerrados;
  }

  private async enviarAlChatDeLaEmpresa(
    distributorId: string,
    party: Party.COMPANY | Party.PLATFORM,
    userId: string,
    dto: SendMessageDto,
    ahora: Date,
  ): Promise<MensajeEscrito> {
    const efectos = new Efectos();
    const escrito = await this.dataSource.transaction(async (manager) => {
      // Reintento de un mensaje que ya se escribió (aunque ese chat ya se haya cerrado).
      const previo = await this.yaEscrito(manager, distributorId, userId, dto);
      if (previo) return previo;
      // Un solo «buscar o crear» a la vez por empresa: dos primeros mensajes
      // simultáneos no abren dos chats.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `platform_chat:${distributorId}`,
      ]);
      let chat = await manager.getRepository(Conversation).findOne({
        where: {
          distributorId,
          channel: Channel.PLATFORM_CHAT,
          status: ConversationStatus.OPEN,
        },
      });
      if (!chat) {
        chat = await this.fabrica.crear(manager, {
          distributorId,
          channel: Channel.PLATFORM_CHAT,
          subject: null,
          createdByUserId: userId,
          assignedToUserId: party === Party.PLATFORM ? userId : null,
        });
        efectos.conversacion(chat, 'created');
      }
      const r = await this.writer.escribir(
        manager,
        texto(chat, party, userId, dto),
      );
      efectos.mensaje(r.conversation, r.message);
      if (party === Party.PLATFORM) {
        await this.registrarPrimeraRespuesta(manager, r.conversation);
      } else {
        await this.responderAutomaticamente(
          manager,
          r.conversation,
          ahora,
          efectos,
        );
      }
      return r;
    });
    this.eventos.publicar(efectos);
    return escrito;
  }

  /** El mensaje de ese autor con ese `clientMessageId` en algún chat de la empresa. */
  private async yaEscrito(
    manager: EntityManager,
    distributorId: string,
    userId: string,
    dto: SendMessageDto,
  ): Promise<MensajeEscrito | null> {
    const message = await manager
      .getRepository(Message)
      .createQueryBuilder('m')
      .innerJoin(Conversation, 'c', 'c.conversationId = m.conversationId')
      .where('m.distributorId = :distributorId', { distributorId })
      .andWhere('c.channel = :canal', { canal: Channel.PLATFORM_CHAT })
      .andWhere('m.senderUserId = :userId', { userId })
      .andWhere('m.clientMessageId = :cmid', { cmid: dto.clientMessageId })
      .getOne();
    if (!message) return null;
    const conversation = await manager
      .getRepository(Conversation)
      .findOneByOrFail({ conversationId: message.conversationId });
    return { message, created: false, conversation };
  }

  /**
   * Respuesta automática al mensaje de la empresa (D-C29): en horario, el
   * aviso de recibido (mensaje de sistema: no es primera respuesta ni cuenta
   * como sin leer), una vez por apertura; fuera de horario, la que ofrece
   * pasarlo a un ticket, una vez hasta que la plataforma vuelva a escribir.
   */
  private async responderAutomaticamente(
    manager: EntityManager,
    chat: Conversation,
    ahora: Date,
    efectos: Efectos,
  ): Promise<void> {
    const ajustes = await this.ajustes.leer(manager);
    const [estado]: Array<{
      recibido: boolean;
      plataforma: boolean;
      fuera: boolean;
    }> = await manager.query(
      `SELECT EXISTS (SELECT 1 FROM "message" WHERE "conversation_id" = $1
                         AND "kind" = 'system' AND "system_code" = '${SystemCode.RECEIVED_ACK}') AS recibido,
              EXISTS (SELECT 1 FROM "message" WHERE "conversation_id" = $1
                         AND "sender_party" = 'platform') AS plataforma,
              EXISTS (
                SELECT 1 FROM "message" a
                 WHERE a."conversation_id" = $1 AND a."kind" = 'auto_reply'
                   AND a."seq" > COALESCE((SELECT max(p."seq") FROM "message" p
                                            WHERE p."conversation_id" = $1 AND p."sender_party" = 'platform'), 0)
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
    if (cual === null) return;
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
  }

  private async registrarPrimeraRespuesta(
    manager: EntityManager,
    chat: Conversation,
  ): Promise<void> {
    await manager.query(
      `UPDATE "conversation" SET "first_response_at" = now()
        WHERE "conversation_id" = $1 AND "first_response_at" IS NULL`,
      [chat.conversationId],
    );
  }

  private async cambiarAsignacion(
    chatId: string,
    userId: string,
    accion: 'tomar' | 'soltar',
  ): Promise<Conversation> {
    const efectos = new Efectos();
    const chat = await this.dataSource.transaction(async (manager) => {
      const c = await this.chatDeLaPlataforma(manager, chatId);
      if (c.status !== ConversationStatus.OPEN) {
        throw new ConversacionCerradaError();
      }
      if (accion === 'tomar') {
        if (c.assignedToUserId === userId) return c;
        if (c.assignedToUserId !== null) throw new ConversacionYaTomadaError();
        c.assignedToUserId = userId;
      } else {
        if (c.assignedToUserId === null) return c;
        c.assignedToUserId = null;
      }
      const guardado = await manager.getRepository(Conversation).save(c);
      efectos.conversacion(guardado, 'assigned');
      return guardado;
    });
    this.eventos.publicar(efectos);
    return chat;
  }

  private async cerrarDentro(
    manager: EntityManager,
    chat: Conversation,
    motivo: ConversationClosedReason,
    userId: string | null,
    efectos: Efectos,
  ): Promise<Conversation> {
    const r = await this.writer.escribir(manager, {
      conversationId: chat.conversationId,
      distributorId: chat.distributorId,
      senderParty: Party.SYSTEM,
      senderUserId: null,
      clientMessageId: null,
      kind: MessageKind.SYSTEM,
      visibility: MessageVisibility.ALL,
      body: null,
      payload: null,
      systemCode:
        motivo === ConversationClosedReason.INACTIVITY
          ? SystemCode.CLOSED_INACTIVITY
          : SystemCode.CLOSED_MANUAL,
      templateKey: null,
    });
    efectos.mensaje(r.conversation, r.message);
    const repo = manager.getRepository(Conversation);
    const actual = await repo.findOneByOrFail({
      conversationId: chat.conversationId,
    });
    actual.status = ConversationStatus.CLOSED;
    actual.closedAt = new Date();
    actual.closedReason = motivo;
    actual.closedByUserId = userId;
    actual.assignedToUserId = null;
    const cerrado = await repo.save(actual);
    efectos.conversacion(cerrado, 'closed');
    return cerrado;
  }

  /** El chat por id, con la fila bloqueada (la plataforma ve los de todas las empresas). */
  private async chatDeLaPlataforma(
    manager: EntityManager,
    chatId: string,
  ): Promise<Conversation> {
    const c = await manager.getRepository(Conversation).findOne({
      where: { conversationId: chatId, channel: Channel.PLATFORM_CHAT },
      lock: { mode: 'pessimistic_write' },
    });
    if (!c) throw new NotFoundException('No existe ese chat');
    return c;
  }
}

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

function texto(
  chat: Conversation,
  party: Party.COMPANY | Party.PLATFORM,
  userId: string,
  dto: SendMessageDto,
) {
  return {
    conversationId: chat.conversationId,
    distributorId: chat.distributorId,
    senderParty: party,
    senderUserId: userId,
    clientMessageId: dto.clientMessageId,
    kind: MessageKind.TEXT,
    visibility: MessageVisibility.ALL,
    body: dto.body,
    payload: null,
    systemCode: null,
    templateKey: null,
  };
}
