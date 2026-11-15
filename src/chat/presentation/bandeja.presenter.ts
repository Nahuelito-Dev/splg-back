import { Injectable } from '@nestjs/common';
import {
  CompanyChatSettingsService,
  horarioDe,
} from '../application/company-chat-settings.service';
import {
  esRespuestaAutomatica,
  nombreDelAsistente,
  VENTANA_DE_EDICION_MINUTOS,
} from '../domain/bandeja';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  Party,
} from '../domain/chat.enums';
import { minutosHabiles } from '../domain/horario-de-la-empresa';
import { vistaPrevia } from '../domain/reglas-del-mensaje';
import type { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import {
  BandejaReadModel,
  type PedidoDeLaConversacion,
} from '../infrastructure/bandeja-read-model';
import type { Lector } from '../infrastructure/chat-read-model';
import type {
  InboxConversationDto,
  InboxMessageDto,
} from './dto/bandeja-response.dto';

/** Lo que hace falta, además de las entidades, para armar lo que ve quien mira. */
export interface ContextoDeLaBandeja {
  quien: Lector;
  ahora: Date;
  nombres: Map<string, string>;
  empresas: Map<string, string>;
  /** Nombre de marca de las empresas con mensajes del asistente sin firma guardada. */
  marcas: Map<string, string>;
  pedidos: Map<string, PedidoDeLaConversacion>;
  noLeidos: Map<string, number>;
  lecturaPropia: Map<string, number>;
  lecturaDeLaOtraParte: Map<string, number>;
  ultimos: Map<string, Message>;
  respondidos: Map<string, Message>;
  primerEntrante: Map<string, Date>;
  ajustes: Map<string, ChatCompanySettings>;
}

/** La firma con que se mandó el mensaje del asistente (`payload.senderLabel`); nula en los anteriores. */
function firmaGuardada(m: Message): string | null {
  const firma: unknown = m.payload
    ? (m.payload as Record<string, unknown>).senderLabel
    : undefined;
  return typeof firma === 'string' && firma.length > 0 ? firma : null;
}

const esPersonal = (ctx: ContextoDeLaBandeja) =>
  ctx.quien.party === Party.COMPANY;

/**
 * Arma las conversaciones y los mensajes de la bandeja tal como los ve quien
 * pide: el personal ve a la persona, quién atiende y las métricas; el cliente
 * y el chofer ven la marca de la empresa, nunca al operador (D-C5). Junta en
 * pocas consultas lo de todo lo que se muestra de una vez.
 */
@Injectable()
export class BandejaPresenter {
  constructor(
    private readonly lectura: BandejaReadModel,
    private readonly ajustes: CompanyChatSettingsService,
  ) {}

  async contexto(
    quien: Lector,
    conversaciones: readonly Conversation[],
    mensajes: readonly Message[] = [],
  ): Promise<ContextoDeLaBandeja> {
    const ids = conversaciones.map((c) => c.conversationId);
    const [
      noLeidos,
      lecturaPropia,
      lecturaDeLaOtraParte,
      ultimos,
      respondidos,
      primerEntrante,
      pedidos,
    ] = await Promise.all([
      this.lectura.noLeidos(ids, quien),
      this.lectura.lecturaPropia(ids, quien.userId),
      this.lectura.lecturaDeLaOtraParte(ids, quien.party),
      this.lectura.ultimos(ids),
      this.lectura.respondidos(mensajes),
      quien.party === Party.COMPANY
        ? this.lectura.primerMensajeEntrante(ids)
        : Promise.resolve(new Map<string, Date>()),
      this.lectura.pedidos(
        conversaciones.flatMap((c) => (c.orderId ? [c.orderId] : [])),
      ),
    ]);
    const usuarios = new Set<string>();
    for (const c of conversaciones) {
      for (const id of [c.customerUserId, c.driverUserId, c.assignedToUserId]) {
        if (id) usuarios.add(id);
      }
    }
    for (const m of mensajes) if (m.senderUserId) usuarios.add(m.senderUserId);
    const empresas = new Set([
      ...conversaciones.map((c) => c.distributorId),
      ...mensajes.map((m) => m.distributorId),
    ]);
    // Los mensajes del asistente anteriores a guardar la firma se firman con
    // el nombre vigente: hace falta la marca de su empresa.
    const sinFirma = new Set(
      mensajes
        .filter((m) => esRespuestaAutomatica(m) && firmaGuardada(m) === null)
        .map((m) => m.distributorId),
    );
    const [nombres, nombresDeEmpresas, marcas, ajustes] = await Promise.all([
      this.lectura.nombres(usuarios),
      this.lectura.empresas(empresas),
      this.lectura.marcas(sinFirma),
      Promise.all(
        [...empresas].map(
          async (id) => [id, await this.ajustes.leer(id)] as const,
        ),
      ),
    ]);
    return {
      quien,
      ahora: new Date(),
      nombres,
      empresas: nombresDeEmpresas,
      marcas,
      pedidos,
      noLeidos,
      lecturaPropia,
      lecturaDeLaOtraParte,
      ultimos,
      respondidos,
      primerEntrante,
      ajustes: new Map(ajustes),
    };
  }

  async conversaciones(
    conversaciones: readonly Conversation[],
    quien: Lector,
  ): Promise<InboxConversationDto[]> {
    const ctx = await this.contexto(quien, conversaciones);
    return conversaciones.map((c) => this.conversacionCon(c, ctx));
  }

  async conversacion(
    c: Conversation,
    quien: Lector,
  ): Promise<InboxConversationDto> {
    const [dto] = await this.conversaciones([c], quien);
    return dto;
  }

  async mensajes(
    mensajes: readonly Message[],
    quien: Lector,
  ): Promise<InboxMessageDto[]> {
    const ctx = await this.contexto(quien, [], mensajes);
    return mensajes.map((m) => this.mensajeCon(m, ctx));
  }

  async mensaje(m: Message, quien: Lector): Promise<InboxMessageDto> {
    const [dto] = await this.mensajes([m], quien);
    return dto;
  }

  conversacionCon(
    c: Conversation,
    ctx: ContextoDeLaBandeja,
  ): InboxConversationDto {
    const empresa = ctx.empresas.get(c.distributorId) ?? '';
    const ajustes = ctx.ajustes.get(c.distributorId);
    const personaId = c.customerUserId ?? c.driverUserId;
    const persona = personaId
      ? {
          id: personaId,
          displayName: ctx.nombres.get(personaId) ?? 'Sin nombre',
        }
      : null;
    const ultimo = ctx.ultimos.get(c.conversationId);
    const abierta = c.status === ConversationStatus.OPEN;
    const dto: InboxConversationDto = {
      id: c.conversationId,
      distributorId: c.distributorId,
      channel: c.channel,
      subjectType: c.subjectType,
      order: c.orderId ? (ctx.pedidos.get(c.orderId) ?? null) : null,
      counterpart: esPersonal(ctx)
        ? {
            party:
              c.channel === Channel.STAFF_CUSTOMER
                ? Party.CUSTOMER
                : Party.DRIVER,
            displayName: persona?.displayName ?? '',
          }
        : { party: Party.COMPANY, displayName: empresa },
      status: c.status,
      canWrite:
        abierta &&
        (ctx.quien.party !== Party.CUSTOMER ||
          (ajustes?.customerChatEnabled ?? true)),
      lastMessage: ultimo
        ? {
            seq: ultimo.seq,
            preview:
              ultimo.redactedAt ||
              ultimo.withdrawnAt ||
              // Los avisos del sistema no muestran texto, salvo las respuestas
              // automáticas (aviso de recibido): ésas se leen como del asistente.
              (ultimo.kind === MessageKind.SYSTEM &&
                !esRespuestaAutomatica(ultimo))
                ? null
                : vistaPrevia(ultimo.body, ultimo.visibility),
            at: ultimo.createdAt.toISOString(),
            party: ultimo.senderParty,
          }
        : null,
      unreadCount: ctx.noLeidos.get(c.conversationId) ?? 0,
      lastReadSeq: ctx.lecturaPropia.get(c.conversationId) ?? 0,
      counterpartLastReadSeq:
        ctx.lecturaDeLaOtraParte.get(c.conversationId) ?? 0,
      closedReason: c.closedReason,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
    if (esPersonal(ctx)) {
      dto.customer = c.channel === Channel.STAFF_CUSTOMER ? persona : null;
      dto.driver = c.channel === Channel.STAFF_DRIVER ? persona : null;
      dto.assignedTo = c.assignedToUserId
        ? {
            userId: c.assignedToUserId,
            fullName: ctx.nombres.get(c.assignedToUserId) ?? 'Sin nombre',
          }
        : null;
      dto.linkedClaimId = c.linkedClaimId;
      dto.firstResponseAt = c.firstResponseAt?.toISOString() ?? null;
      dto.awaitingHumanSince = c.awaitingHumanSince?.toISOString() ?? null;
      const entrante = ctx.primerEntrante.get(c.conversationId);
      dto.firstResponseBusinessMinutes =
        entrante && c.firstResponseAt && ajustes
          ? minutosHabiles(horarioDe(ajustes), entrante, c.firstResponseAt)
          : null;
    }
    return dto;
  }

  mensajeCon(m: Message, ctx: ContextoDeLaBandeja): InboxMessageDto {
    const redactado = m.redactedAt !== null;
    // Borrado por su autor (D-C23): el texto no sale nunca, para nadie.
    const borrado = m.withdrawnAt !== null;
    const sinTexto = redactado || borrado;
    const propio =
      m.senderUserId !== null && m.senderUserId === ctx.quien.userId;
    const respondido =
      m.replyToSeq !== null
        ? ctx.respondidos.get(`${m.conversationId}:${m.replyToSeq}`)
        : undefined;
    const automatico = esRespuestaAutomatica(m);
    return {
      id: m.messageId,
      conversationId: m.conversationId,
      seq: m.seq,
      clientMessageId:
        m.senderParty === ctx.quien.party ? m.clientMessageId : null,
      party: m.senderParty,
      sender: this.autor(m, ctx),
      isMine: m.senderParty === ctx.quien.party,
      canEdit:
        propio &&
        m.kind === MessageKind.TEXT &&
        !sinTexto &&
        ctx.ahora.getTime() - m.createdAt.getTime() <=
          VENTANA_DE_EDICION_MINUTOS * 60_000,
      kind: m.kind,
      body: sinTexto ? null : m.body,
      templateKey: m.templateKey,
      systemCode: m.systemCode,
      automated: automatico,
      senderLabel: automatico
        ? (firmaGuardada(m) ??
          nombreDelAsistente(
            ctx.ajustes.get(m.distributorId)?.assistantName ?? null,
            ctx.marcas.get(m.distributorId) ?? '',
          ))
        : null,
      payload: sinTexto ? null : (m.payload as Record<string, unknown> | null),
      replyTo: respondido
        ? {
            seq: respondido.seq,
            party: respondido.senderParty,
            preview:
              respondido.redactedAt || respondido.withdrawnAt
                ? null
                : vistaPrevia(respondido.body, respondido.visibility),
          }
        : null,
      editedAt: m.editedAt?.toISOString() ?? null,
      deleted: borrado,
      deletedAt: m.withdrawnAt?.toISOString() ?? null,
      redacted: redactado,
      createdAt: m.createdAt.toISOString(),
    };
  }

  /** El personal ve quién escribió; el cliente y el chofer, la marca de la empresa (D-C5). */
  private autor(
    m: Message,
    ctx: ContextoDeLaBandeja,
  ): { displayName: string; userId?: string } | null {
    if (!m.senderUserId) return null;
    if (!esPersonal(ctx) && m.senderParty === Party.COMPANY) {
      return { displayName: ctx.empresas.get(m.distributorId) ?? '' };
    }
    const displayName = ctx.nombres.get(m.senderUserId) ?? 'Sin nombre';
    // Sólo el personal recibe el id (para la foto de perfil); el cliente y el
    // chofer ven a la empresa como una sola voz (D-C5).
    return esPersonal(ctx)
      ? { displayName, userId: m.senderUserId }
      : { displayName };
  }
}
