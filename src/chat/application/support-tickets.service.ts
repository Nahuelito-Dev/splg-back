import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  Channel,
  MessageKind,
  MessageVisibility,
  Party,
  SystemCode,
  TicketCategory,
  TicketPriority,
} from '../domain/chat.enums';
import {
  armarCita,
  assertRangoValido,
  primeraRespuestaEnLaCita,
} from '../domain/cita';
import {
  assertAbierto,
  estadoInicial,
  numeroDeTicket,
  venceLaPrimeraRespuesta,
} from '../domain/support-ticket.machine';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { SupportTicket } from '../entities/support-ticket.entity';
import type {
  AddExcerptDto,
  OpenTicketFromChatDto,
  SendMessageDto,
} from '../presentation/dto/chat-input.dto';
import { ChatEvents, Efectos } from './chat.events';
import { ChatNotices } from './chat-notices';
import { ChatRateLimit } from './chat-rate-limit';
import { ConversationFactory } from './conversation-factory';
import { MessageWriter } from './message-writer';
import {
  objetivosDe,
  SupportSettingsService,
} from './support-settings.service';
import {
  ActorDeTicket,
  assertEmpresaVigente,
  bloquearChatDeLaEmpresa,
  bloquearTicket,
  enlazarCitados,
  esPlataforma,
  mensajesACitar,
  nombreDeLaEmpresa,
  siguienteNumero,
} from './ticket-store';

export interface NuevoTicket {
  distributorId: string;
  category: TicketCategory;
  priority: TicketPriority;
  subject: string;
  firstMessage: SendMessageDto;
}

export interface TicketDesdeElChat extends OpenTicketFromChatDto {
  assignToMe?: boolean;
}

/**
 * Apertura de tickets (C1b, diseño §4.2.2): directo o desde el chat, con la
 * cita de los mensajes elegidos (copia congelada, D-C21), y citas
 * posteriores. Todo en una transacción; los avisos salen después del commit.
 */
@Injectable()
export class SupportTicketsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly writer: MessageWriter,
    private readonly fabrica: ConversationFactory,
    private readonly ajustes: SupportSettingsService,
    private readonly cupos: ChatRateLimit,
    private readonly eventos: ChatEvents,
    private readonly avisos: ChatNotices,
  ) {}

  /**
   * Ticket directo. Reintentar con el mismo `firstMessage.clientMessageId`
   * devuelve el ticket ya creado (`created: false`).
   */
  async crear(
    actor: ActorDeTicket,
    nuevo: NuevoTicket,
  ): Promise<{ ticket: SupportTicket; created: boolean }> {
    const efectos = new Efectos();
    const resultado = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `ticket:${actor.userId}:${nuevo.firstMessage.clientMessageId}`,
      ]);
      const previo = await this.ticketDelPrimerMensaje(
        manager,
        nuevo.distributorId,
        actor.userId,
        nuevo.firstMessage.clientMessageId,
      );
      if (previo) return { ticket: previo, created: false };
      await this.controlarCupos(manager, actor, nuevo.distributorId);

      const ticket = await this.abrir(manager, actor, {
        distributorId: nuevo.distributorId,
        category: nuevo.category,
        priority: nuevo.priority,
        subject: nuevo.subject,
        origen: null,
        primeraRespuesta: esPlataforma(actor) ? new Date() : null,
        asignado: esPlataforma(actor) ? actor.userId : null,
        efectos,
      });
      const r = await this.writer.escribir(manager, {
        conversationId: ticket.conversationId,
        distributorId: ticket.distributorId,
        senderParty: actor.party,
        senderUserId: actor.userId,
        clientMessageId: nuevo.firstMessage.clientMessageId,
        kind: MessageKind.TEXT,
        visibility: MessageVisibility.ALL,
        body: nuevo.firstMessage.body,
        payload: null,
        systemCode: null,
        templateKey: null,
      });
      efectos.mensaje(r.conversation, r.message);
      return { ticket, created: true };
    });
    if (resultado.created) await this.avisar(actor, resultado.ticket);
    this.eventos.publicar(efectos);
    return resultado;
  }

  /**
   * Ticket desde el chat: el hilo arranca con la cita de `fromSeq`–`toSeq`
   * (hasta 200 mensajes, del chat de esa empresa), el chat recibe el mensaje
   * `ticket_opened` y los mensajes citados quedan enlazados.
   */
  async crearDesdeElChat(
    actor: ActorDeTicket,
    chatId: string,
    dto: TicketDesdeElChat,
  ): Promise<SupportTicket> {
    const efectos = new Efectos();
    const ticket = await this.dataSource.transaction(async (manager) => {
      const chat = await bloquearChatDeLaEmpresa(
        manager,
        chatId,
        actor.distributorId,
      );
      assertRangoValido(dto.fromSeq, dto.toSeq, chat.lastMessageSeq);
      await this.controlarCupos(manager, actor, chat.distributorId);
      const { aCitar } = await mensajesACitar(
        manager,
        chat,
        dto.fromSeq,
        dto.toSeq,
      );
      const { payload, citados } = armarCita(
        chat.conversationId,
        dto.fromSeq,
        dto.toSeq,
        aCitar,
      );
      const t = await this.abrir(manager, actor, {
        distributorId: chat.distributorId,
        category: dto.category,
        priority: dto.priority,
        subject: dto.subject,
        origen: { chat, desde: dto.fromSeq, hasta: dto.toSeq },
        primeraRespuesta: esPlataforma(actor)
          ? new Date()
          : primeraRespuestaEnLaCita(aCitar, dto.fromSeq, dto.toSeq),
        asignado: esPlataforma(actor) && dto.assignToMe ? actor.userId : null,
        efectos,
      });
      const cita = await this.writer.escribir(manager, {
        conversationId: t.conversationId,
        distributorId: t.distributorId,
        senderParty: actor.party,
        senderUserId: actor.userId,
        clientMessageId: null,
        kind: MessageKind.QUOTED_EXCERPT,
        visibility: MessageVisibility.ALL,
        body: null,
        payload,
        systemCode: null,
        templateKey: null,
      });
      efectos.mensaje(cita.conversation, cita.message);
      await enlazarCitados(
        manager,
        t,
        citados,
        cita.message.messageId,
        actor.userId,
      );
      if (dto.note) {
        const nota = await this.writer.escribir(manager, {
          conversationId: t.conversationId,
          distributorId: t.distributorId,
          senderParty: actor.party,
          senderUserId: actor.userId,
          clientMessageId: null,
          kind: MessageKind.TEXT,
          visibility: MessageVisibility.ALL,
          body: dto.note,
          payload: null,
          systemCode: null,
          templateKey: null,
        });
        efectos.mensaje(nota.conversation, nota.message);
      }
      const enElChat = await this.writer.escribir(manager, {
        conversationId: chat.conversationId,
        distributorId: chat.distributorId,
        senderParty: Party.SYSTEM,
        senderUserId: null,
        clientMessageId: null,
        kind: MessageKind.SYSTEM,
        visibility: MessageVisibility.ALL,
        body: null,
        payload: {
          ticketId: t.ticketId,
          number: numeroDeTicket(t.number),
          subject: t.subject,
        },
        systemCode: SystemCode.TICKET_OPENED,
        templateKey: null,
      });
      efectos.mensaje(enElChat.conversation, enElChat.message);
      return t;
    });
    await this.avisar(actor, ticket);
    this.eventos.publicar(efectos);
    return ticket;
  }

  /** Lleva más mensajes del chat al hilo de un ticket abierto (se copian; el chat queda igual). */
  async agregarCita(
    actor: ActorDeTicket,
    ticketId: string,
    dto: AddExcerptDto,
  ): Promise<Message> {
    const efectos = new Efectos();
    const mensaje = await this.dataSource.transaction(async (manager) => {
      const ticket = await bloquearTicket(
        manager,
        ticketId,
        actor.distributorId,
      );
      assertAbierto(ticket.status);
      // El chat tiene que ser de la empresa del ticket: el de otra es 404.
      const chat = await bloquearChatDeLaEmpresa(
        manager,
        dto.sourceConversationId,
        ticket.distributorId,
      );
      assertRangoValido(dto.fromSeq, dto.toSeq, chat.lastMessageSeq);
      const { aCitar } = await mensajesACitar(
        manager,
        chat,
        dto.fromSeq,
        dto.toSeq,
      );
      const { payload, citados } = armarCita(
        chat.conversationId,
        dto.fromSeq,
        dto.toSeq,
        aCitar,
      );
      const cita = await this.writer.escribir(manager, {
        conversationId: ticket.conversationId,
        distributorId: ticket.distributorId,
        senderParty: actor.party,
        senderUserId: actor.userId,
        clientMessageId: null,
        kind: MessageKind.QUOTED_EXCERPT,
        visibility: MessageVisibility.ALL,
        body: null,
        payload,
        systemCode: null,
        templateKey: null,
      });
      efectos.mensaje(cita.conversation, cita.message);
      await enlazarCitados(
        manager,
        ticket,
        citados,
        cita.message.messageId,
        actor.userId,
      );
      return cita.message;
    });
    this.eventos.publicar(efectos);
    return mensaje;
  }

  private async abrir(
    manager: EntityManager,
    actor: ActorDeTicket,
    datos: {
      distributorId: string;
      category: TicketCategory;
      priority: TicketPriority;
      subject: string;
      origen: { chat: Conversation; desde: number; hasta: number } | null;
      primeraRespuesta: Date | null;
      asignado: string | null;
      efectos: Efectos;
    },
  ): Promise<SupportTicket> {
    const ahora = new Date();
    const ajustes = await this.ajustes.leer(manager);
    const numero = await siguienteNumero(manager);
    const hilo = await this.fabrica.crear(manager, {
      distributorId: datos.distributorId,
      channel: Channel.PLATFORM_TICKET,
      subject: datos.subject,
      createdByUserId: actor.userId,
    });
    datos.efectos.conversacion(hilo, 'created');
    const repo = manager.getRepository(SupportTicket);
    const ticket = await repo.save(
      repo.create({
        distributorId: datos.distributorId,
        conversationId: hilo.conversationId,
        originConversationId: datos.origen?.chat.conversationId ?? null,
        originFromSeq: datos.origen?.desde ?? null,
        originToSeq: datos.origen?.hasta ?? null,
        number: numero,
        subject: datos.subject,
        category: datos.category,
        priority: datos.priority,
        status: estadoInicial(actor.party),
        statusChangedAt: ahora,
        openedByParty: actor.party,
        openedByUserId: actor.userId,
        assignedMemberUserId: datos.asignado,
        firstResponseDueAt: venceLaPrimeraRespuesta(
          ahora,
          datos.priority,
          objetivosDe(ajustes),
        ),
        firstResponseAt: datos.primeraRespuesta,
        resolvedAt: null,
        closedAt: null,
        satisfaction: null,
      }),
    );
    datos.efectos.ticket(ticket, 'created');
    const creado = await this.writer.escribir(manager, {
      conversationId: hilo.conversationId,
      distributorId: hilo.distributorId,
      senderParty: Party.SYSTEM,
      senderUserId: null,
      clientMessageId: null,
      kind: MessageKind.SYSTEM,
      visibility: MessageVisibility.ALL,
      body: null,
      payload: {
        ticketId: ticket.ticketId,
        number: numeroDeTicket(ticket.number),
        subject: ticket.subject,
      },
      systemCode: SystemCode.TICKET_CREATED,
      templateKey: null,
    });
    datos.efectos.mensaje(creado.conversation, creado.message);
    return ticket;
  }

  /** El ticket cuyo hilo empezó con ese mensaje de ese autor (reintento). */
  private async ticketDelPrimerMensaje(
    manager: EntityManager,
    distributorId: string,
    userId: string,
    clientMessageId: string,
  ): Promise<SupportTicket | null> {
    return manager
      .getRepository(SupportTicket)
      .createQueryBuilder('t')
      .innerJoin(Message, 'm', 'm.conversationId = t.conversationId')
      .where('t.distributorId = :distributorId', { distributorId })
      .andWhere('m.senderUserId = :userId', { userId })
      .andWhere('m.clientMessageId = :cmid', { cmid: clientMessageId })
      .getOne();
  }

  /** La empresa: tope de tickets por hora. La plataforma: la empresa tiene que existir. */
  private async controlarCupos(
    manager: EntityManager,
    actor: ActorDeTicket,
    distributorId: string,
  ): Promise<void> {
    if (esPlataforma(actor)) {
      await assertEmpresaVigente(manager, distributorId);
      return;
    }
    await this.cupos.ticket(distributorId);
  }

  private async avisar(
    actor: ActorDeTicket,
    ticket: SupportTicket,
  ): Promise<void> {
    if (esPlataforma(actor)) {
      this.avisos.ticketDeLaPlataforma(ticket);
      return;
    }
    const empresa = await nombreDeLaEmpresa(
      this.dataSource.manager,
      ticket.distributorId,
    );
    this.avisos.ticketDeLaEmpresa(ticket, empresa);
  }
}
