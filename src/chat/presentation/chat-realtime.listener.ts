import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import {
  AdminGateway,
  EVENTO_ESCRIBIENDO_DEL_PANEL,
  type EscribiendoDelPanel,
} from '../../gateways/admin.gateway';
import {
  ChatViewsService,
  type ContextoDeVista,
} from '../application/chat-views.service';
import {
  type ConversacionCambiada,
  EVENTO_CONVERSACION_CAMBIO,
  EVENTO_LECTURA,
  EVENTO_MENSAJE_CREADO,
  EVENTO_TICKET,
  type LecturaRegistrada,
  type MensajeCreado,
  type TicketCambiado,
} from '../application/chat.events';
import {
  Channel,
  ConversationStatus,
  MessageVisibility,
  Party,
} from '../domain/chat.enums';
import { numeroDeTicket } from '../domain/support-ticket.machine';
import { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import { vistaPrevia } from '../domain/reglas-del-mensaje';
import type { Observador } from '../infrastructure/chat-read-model';
import { ChatMapper } from './chat.mapper';

/** Eventos del socket del panel (diseño §7.3); escritos uno por uno, como pide TIEMPO-REAL.md. */
export const EVENTO_SOCKET_MENSAJE = 'chat:message';
export const EVENTO_SOCKET_CONVERSACION = 'chat:conversation';
export const EVENTO_SOCKET_LEIDO = 'chat:read';
/** Aviso liviano a las salas de lista (bandeja y contadores), sin el cuerpo. */
export const EVENTO_SOCKET_BANDEJA = 'chat:inbox';
export const EVENTO_SOCKET_ESCRIBIENDO = 'chat:typing';
export const EVENTO_SOCKET_TICKET_CREADO = 'ticket:created';
export const EVENTO_SOCKET_TICKET_ACTUALIZADO = 'ticket:updated';

/** Cuánto dura un «escribiendo…» si no llega otro. */
export const ESCRIBIENDO_DURA_MS = 5000;

/** Canales cuyo «escribiendo…» viaja entre la empresa y la plataforma (C1). */
const CANALES_DE_C1: ReadonlySet<string> = new Set([
  Channel.PLATFORM_CHAT,
  Channel.PLATFORM_TICKET,
]);

/**
 * Sólo el chat con la plataforma y el hilo de un ticket, y sólo abiertos: el
 * «escribiendo…» de cualquier otra conversación de la empresa (C2–C4) nunca
 * llega a la plataforma (§11, R11).
 */
export function admiteEscribiendo(c: Conversation): boolean {
  return CANALES_DE_C1.has(c.channel) && c.status === ConversationStatus.OPEN;
}

/** En una sala no hay una persona: la lectura y el «sin leer» no aplican. */
const NADIE = '00000000-0000-0000-0000-000000000000';
const SALA_DE_LA_EMPRESA: Observador = { party: Party.COMPANY, userId: NADIE };
const SALA_DE_LA_PLATAFORMA: Observador = {
  party: Party.PLATFORM,
  userId: NADIE,
};

/**
 * Lleva los eventos de la mensajería al socket del panel, después del commit.
 * Cada punta recibe su versión: la empresa nunca una nota interna ni quién la
 * atiende más allá del nombre de pila; la plataforma, todo. Es un aviso: la
 * verdad está en la base y se recupera por HTTP (`afterSeq`).
 */
@Injectable()
export class ChatRealtimeListener {
  private readonly logger = new Logger(ChatRealtimeListener.name);

  constructor(
    private readonly gateway: AdminGateway,
    private readonly vistas: ChatViewsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Mensaje nuevo: el cuerpo completo viaja SÓLO a la sala de la conversación
   * (cada punta su versión; una nota interna sólo a la plataforma). A las
   * salas de lista, el aviso liviano `chat:inbox`.
   */
  @OnEvent(EVENTO_MENSAJE_CREADO, { async: true })
  async mensaje({ conversation, message }: MensajeCreado): Promise<void> {
    await this.seguro(EVENTO_SOCKET_MENSAJE, async () => {
      const base = {
        conversationId: conversation.conversationId,
        distributorId: conversation.distributorId,
        seq: message.seq,
      };
      const interna = message.visibility !== MessageVisibility.ALL;
      const plataforma = await this.contexto(SALA_DE_LA_PLATAFORMA, {
        mensajes: [message],
      });
      this.gateway.emitirAConversacion(
        conversation.conversationId,
        'platform',
        EVENTO_SOCKET_MENSAJE,
        { ...base, message: ChatMapper.mensaje(message, plataforma) },
      );
      this.avisarALasListas(conversation, 'message', message, interna);
      if (interna) return;
      const empresa = await this.contexto(SALA_DE_LA_EMPRESA, {
        mensajes: [message],
      });
      this.gateway.emitirAConversacion(
        conversation.conversationId,
        'company',
        EVENTO_SOCKET_MENSAJE,
        { ...base, message: ChatMapper.mensaje(message, empresa) },
      );
    });
  }

  /** Cambio de la conversación: la ficha completa a su sala; a las listas, el aviso liviano. */
  @OnEvent(EVENTO_CONVERSACION_CAMBIO, { async: true })
  async conversacion({
    conversation,
    change,
  }: ConversacionCambiada): Promise<void> {
    await this.seguro(EVENTO_SOCKET_CONVERSACION, async () => {
      const base = {
        conversationId: conversation.conversationId,
        distributorId: conversation.distributorId,
        change,
      };
      const [plataforma, empresa] = await Promise.all([
        this.contexto(SALA_DE_LA_PLATAFORMA, {
          conversaciones: [conversation],
        }),
        this.contexto(SALA_DE_LA_EMPRESA, { conversaciones: [conversation] }),
      ]);
      this.gateway.emitirAConversacion(
        conversation.conversationId,
        'platform',
        EVENTO_SOCKET_CONVERSACION,
        {
          ...base,
          conversation: ChatMapper.conversacion(conversation, plataforma),
        },
      );
      this.gateway.emitirAConversacion(
        conversation.conversationId,
        'company',
        EVENTO_SOCKET_CONVERSACION,
        {
          ...base,
          conversation: ChatMapper.conversacion(conversation, empresa),
        },
      );
      this.avisarALasListas(conversation, change, null, false);
    });
  }

  /**
   * El «leído»: a todas las conexiones de quien leyó (sus otras pestañas
   * apagan el contador) y, si subió la lectura de su punta, a la otra punta
   * dentro de la sala de la conversación. Nunca a sus compañeros de equipo.
   */
  @OnEvent(EVENTO_LECTURA, { async: true })
  async lectura(evento: LecturaRegistrada): Promise<void> {
    await this.seguro(EVENTO_SOCKET_LEIDO, () => {
      const payload = {
        conversationId: evento.conversationId,
        party: evento.party,
        lastReadSeq: evento.lastReadSeq,
      };
      if (evento.personal) {
        this.gateway.emitirAUsuario(
          evento.userId,
          EVENTO_SOCKET_LEIDO,
          payload,
        );
      }
      if (evento.deLaParte) {
        this.gateway.emitirAConversacion(
          evento.conversationId,
          evento.party === Party.COMPANY ? 'platform' : 'company',
          EVENTO_SOCKET_LEIDO,
          payload,
        );
      }
      return Promise.resolve();
    });
  }

  /** `ticket:created` / `ticket:updated`: la tarjeta del ticket en el chat de origen se actualiza en vivo. */
  @OnEvent(EVENTO_TICKET, { async: true })
  async ticket({ ticket, change }: TicketCambiado): Promise<void> {
    const evento =
      change === 'created'
        ? EVENTO_SOCKET_TICKET_CREADO
        : EVENTO_SOCKET_TICKET_ACTUALIZADO;
    await this.seguro(evento, () => {
      const base = {
        ticketId: ticket.ticketId,
        number: numeroDeTicket(ticket.number),
        distributorId: ticket.distributorId,
        conversationId: ticket.conversationId,
        originConversationId: ticket.originConversationId,
        status: ticket.status,
        priority: ticket.priority,
        subject: ticket.subject,
      };
      this.gateway.emitirAlSoporteDePlataforma(evento, {
        ...base,
        assignedTo: ticket.assignedMemberUserId,
      });
      this.gateway.emitirAlSoporteDeEmpresa(ticket.distributorId, evento, base);
      return Promise.resolve();
    });
  }

  /**
   * «Escribiendo…»: sólo si la conversación es de quien escribe (la de otra
   * empresa no se reenvía a nadie). Le llega a la otra punta, sin decir quién.
   */
  @OnEvent(EVENTO_ESCRIBIENDO_DEL_PANEL, { async: true })
  async escribiendo(pedido: EscribiendoDelPanel): Promise<void> {
    await this.seguro(EVENTO_SOCKET_ESCRIBIENDO, async () => {
      const c = await this.dataSource.getRepository(Conversation).findOne({
        where: { conversationId: pedido.conversationId },
      });
      if (!c || !admiteEscribiendo(c)) return;
      if (!pedido.esPlataforma && c.distributorId !== pedido.distributorId) {
        return;
      }
      const payload = {
        conversationId: c.conversationId,
        party: pedido.esPlataforma ? Party.PLATFORM : Party.COMPANY,
        until: new Date(Date.now() + ESCRIBIENDO_DURA_MS).toISOString(),
      };
      // Sólo a la otra punta, dentro de la sala de la conversación (D-C28).
      this.gateway.emitirAConversacion(
        c.conversationId,
        pedido.esPlataforma ? 'company' : 'platform',
        EVENTO_SOCKET_ESCRIBIENDO,
        payload,
      );
    });
  }

  /**
   * Aviso liviano a las salas de lista de cada punta (bandeja y contadores):
   * id, estado y el último mensaje resumido (número, hora, punta y vista
   * previa de 140 caracteres), nunca el cuerpo. Los no leídos son de cada
   * persona: el panel los deriva del `seq` contra su lectura o pide
   * `GET .../support/summary`. Una nota interna no se avisa a la empresa ni
   * lleva vista previa.
   */
  private avisarALasListas(
    c: Conversation,
    change: string,
    m: Message | null,
    interna: boolean,
  ): void {
    const aviso = {
      conversationId: c.conversationId,
      distributorId: c.distributorId,
      channel: c.channel,
      status: c.status,
      change,
      lastMessage: m
        ? {
            seq: m.seq,
            at: m.createdAt.toISOString(),
            party: m.senderParty,
            kind: m.kind,
            preview: interna ? null : vistaPrevia(m.body, m.visibility),
          }
        : null,
    };
    this.gateway.emitirAlSoporteDePlataforma(EVENTO_SOCKET_BANDEJA, aviso);
    if (!interna) {
      this.gateway.emitirAlSoporteDeEmpresa(
        c.distributorId,
        EVENTO_SOCKET_BANDEJA,
        aviso,
      );
    }
  }

  private contexto(
    quien: Observador,
    que: Parameters<ChatViewsService['contexto']>[1],
  ): Promise<ContextoDeVista> {
    return this.vistas.contexto(quien, que);
  }

  /** Best-effort: un error de un aviso se registra y no sube. */
  private async seguro(evento: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(
        `No se pudo emitir ${evento} por el socket: ${errorMessage(error)}`,
      );
    }
  }
}
