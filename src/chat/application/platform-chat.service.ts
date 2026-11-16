import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import {
  registrarElementoBien,
  registrarFallaDeElemento,
} from '../../process-run/process-run.context';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SystemCode,
} from '../domain/chat.enums';
import {
  ConversacionCerradaError,
  ConversacionYaTomadaError,
} from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import type { SendMessageDto } from '../presentation/dto/chat-input.dto';
import { AsistenteDelChat, dejaDeEsperarPersona } from './asistente-del-chat';
import { ChatEvents, Efectos } from './chat.events';
import { ChatRateLimit } from './chat-rate-limit';
import { ConversationFactory } from './conversation-factory';
import { MensajeEscrito, MessageWriter } from './message-writer';
import { RespuestasFijas } from './respuestas-fijas';
import { assertEmpresaVigente } from './ticket-store';

export {
  avisoDeRecibido,
  RESPUESTA_FUERA_DE_HORARIO,
} from './respuestas-fijas';

/**
 * Chat en vivo con la plataforma (C1a, diseño §4.2.1). Uno abierto por
 * empresa; el próximo mensaje después de cerrarse abre otro. Núcleo: lo usa
 * también una empresa restringida o suspendida.
 */
@Injectable()
export class PlatformChatService {
  private readonly logger = new Logger(PlatformChatService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly writer: MessageWriter,
    private readonly fabrica: ConversationFactory,
    private readonly cupos: ChatRateLimit,
    private readonly eventos: ChatEvents,
    private readonly fijas: RespuestasFijas,
    private readonly asistente: AsistenteDelChat,
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
    await this.cupos.mensaje({
      ambito: distributorId,
      userId,
      clientMessageId: dto.clientMessageId,
    });
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
    await this.cupos.mensaje({
      ambito: distributorId,
      userId,
      clientMessageId: dto.clientMessageId,
    });
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
    await this.cupos.mensaje({
      ambito: `chat:${chatId}`,
      userId,
      clientMessageId: dto.clientMessageId,
    });
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
    const candidatos: Array<{ id: string; empresa: string }> =
      await this.dataSource.query(
        `SELECT "conversation_id" AS id, "distributor_id" AS empresa FROM "conversation"
          WHERE "channel" = 'platform_chat' AND "status" = 'open' AND "deleted_at" IS NULL
            AND COALESCE("last_message_at", "created_at") < $1`,
        [limite],
      );
    let cerrados = 0;
    // Cada chat por su lado: el que falla queda abierto (se reintenta en la
    // próxima corrida) y no frena el cierre de los de las demás empresas.
    for (const { id, empresa } of candidatos) {
      try {
        if (await this.cerrarSiSigueInactivo(id, limite)) cerrados += 1;
        registrarElementoBien(`chat:${id}`);
      } catch (error) {
        registrarFallaDeElemento(`chat:${id}`, error);
        this.logger.error(
          `Cierre de chats inactivos: falló el chat ${id} de la distribuidora ${empresa}: ${errorMessage(error)}`,
        );
      }
    }
    return cerrados;
  }

  /** Cierra el chat si, con la fila bloqueada, sigue abierto y sin mensajes desde el límite. */
  private async cerrarSiSigueInactivo(
    id: string,
    limite: Date,
  ): Promise<boolean> {
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
    this.eventos.publicar(efectos);
    return cerrado;
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
          r.message,
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
   * Respuesta automática al mensaje de la empresa (D-C29): la de la IA si el
   * asistente con IA del soporte se encarga (corre después del commit y
   * reemplaza a las fijas); si no, las fijas de siempre.
   */
  private async responderAutomaticamente(
    manager: EntityManager,
    chat: Conversation,
    m: Message,
    ahora: Date,
    efectos: Efectos,
  ): Promise<void> {
    if (await this.asistente.seEncarga(manager, chat, m, ahora)) return;
    await this.fijas.delSoporte(manager, chat, efectos, ahora);
  }

  /** La plataforma escribió: primera respuesta y deja de esperar a una persona. */
  private async registrarPrimeraRespuesta(
    manager: EntityManager,
    chat: Conversation,
  ): Promise<void> {
    await manager.query(
      `UPDATE "conversation" SET "first_response_at" = now()
        WHERE "conversation_id" = $1 AND "first_response_at" IS NULL`,
      [chat.conversationId],
    );
    await dejaDeEsperarPersona(manager, chat);
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
        // Deja de esperar a una persona (el asistente con IA la derivó).
        c.awaitingHumanSince = null;
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
    actual.awaitingHumanSince = null;
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
