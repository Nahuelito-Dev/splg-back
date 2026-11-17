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
  MessageVisibility,
  Party,
} from '../domain/chat.enums';
import { minutosHabiles } from '../domain/horario-de-la-empresa';
import { vistaPreviaDelMensaje } from '../domain/reglas-del-mensaje';
import type { Attachment } from '../../attachment/entities/attachment.entity';
import type { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import type { Conversation } from '../entities/conversation.entity';
import type { ConversationRating } from '../entities/conversation-rating.entity';
import { accionesHabilitadas } from '../domain/acciones-del-cliente';
import { estadoDeLaEncuesta } from '../domain/encuesta';
import type { Message } from '../entities/message.entity';
import {
  BandejaReadModel,
  type EtiquetaDeLaConversacion,
  type MencionDeLaNota,
  type PedidoDeLaConversacion,
} from '../infrastructure/bandeja-read-model';
import type { Lector } from '../infrastructure/chat-read-model';
import { payloadPara } from './payload-del-mensaje';
import { adjuntoADto } from './adjunto.mapper';

export { payloadPara };
import type {
  InboxConversationDto,
  InboxCsatDto,
  InboxMessageDto,
} from './dto/bandeja-response.dto';

/** Lo que hace falta, además de las entidades, para armar lo que ve quien mira. */
export interface ContextoDeLaBandeja {
  quien: Lector;
  ahora: Date;
  nombres: Map<string, string>;
  /**
   * El nombre de cada empresa como lo ve quien mira: para el cliente y el
   * chofer, el de marca (o el legal si no tiene); para el personal, el legal.
   */
  empresas: Map<string, string>;
  /** Nombre de marca de las empresas (para la firma del asistente en los mensajes sin firma guardada). */
  marcas: Map<string, string>;
  pedidos: Map<string, PedidoDeLaConversacion>;
  noLeidos: Map<string, number>;
  lecturaPropia: Map<string, number>;
  lecturaDeLaOtraParte: Map<string, number>;
  ultimos: Map<string, Message>;
  respondidos: Map<string, Message>;
  primerEntrante: Map<string, Date>;
  ajustes: Map<string, ChatCompanySettings>;
  /** De los mensajes que quien mira podría editar, los que quedaron atados (pedido, reclamo, ticket o citados). */
  atados: Set<string>;
  /** Sólo para el personal: a quiénes menciona cada nota interna. */
  menciones: Map<string, MencionDeLaNota[]>;
  /** Sólo para el personal: menciones sin leer a quien mira, por conversación. */
  mencionesSinLeer: Map<string, number>;
  /** La encuesta del último cierre de cada conversación con un cliente (4b). */
  encuestas: Map<string, ConversationRating>;
  /** Sólo para el cliente: el `seq` del primer mensaje del asistente de cada conversación (4e). */
  primerDelAsistente: Map<string, number>;
  /** El adjunto de cada mensaje de adjunto (CH7), por `messageId`. */
  adjuntos: Map<string, Attachment>;
  /** Sólo para el personal: las etiquetas vigentes de cada conversación (7c). */
  etiquetas: Map<string, EtiquetaDeLaConversacion[]>;
}

/** La encuesta de un cierre como la ven el personal y el cliente (4b). */
export function encuestaADto(
  e: ConversationRating,
  ahora: Date,
  personal: boolean,
): InboxCsatDto {
  return {
    ratingId: e.ratingId,
    status: estadoDeLaEncuesta(e, ahora),
    score: e.score,
    comment: e.comment,
    // Quién atendió es para el tablero del equipo, no para el cliente.
    ...(personal ? { servedBy: e.servedBy } : {}),
    requestedAt: e.requestedAt.toISOString(),
    expiresAt: e.expiresAt.toISOString(),
    answeredAt: e.answeredAt?.toISOString() ?? null,
  };
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
 * Lo escribió quien mira (la persona, no su equipo), es un texto que se ve y
 * está en los 15 minutos: falta saber si quedó atado a algo.
 */
function editablePorPlazo(m: Message, quien: Lector, ahora: Date): boolean {
  return (
    m.senderUserId !== null &&
    m.senderUserId === quien.userId &&
    m.kind === MessageKind.TEXT &&
    m.redactedAt === null &&
    m.withdrawnAt === null &&
    ahora.getTime() - m.createdAt.getTime() <=
      VENTANA_DE_EDICION_MINUTOS * 60_000
  );
}

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
    const ahora = new Date();
    const [
      noLeidos,
      lecturaPropia,
      lecturaDeLaOtraParte,
      ultimos,
      respondidos,
      primerEntrante,
      pedidos,
      atados,
      menciones,
      mencionesSinLeer,
      encuestas,
      primerDelAsistente,
      adjuntos,
      etiquetas,
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
      // Sólo los que pasarían el plazo: el resto ya no se edita.
      this.lectura.atados(
        mensajes
          .filter((m) => editablePorPlazo(m, quien, ahora))
          .map((m) => m.messageId),
      ),
      quien.party === Party.COMPANY
        ? this.lectura.menciones(
            mensajes
              .filter((m) => m.visibility === MessageVisibility.INTERNAL)
              .map((m) => m.messageId),
          )
        : Promise.resolve(new Map<string, MencionDeLaNota[]>()),
      quien.party === Party.COMPANY
        ? this.lectura.mencionesSinLeer(ids, quien.userId)
        : Promise.resolve(new Map<string, number>()),
      quien.party === Party.DRIVER
        ? Promise.resolve(new Map<string, ConversationRating>())
        : this.lectura.encuestas(
            conversaciones
              .filter((c) => c.channel === Channel.STAFF_CUSTOMER)
              .map((c) => c.conversationId),
          ),
      quien.party === Party.CUSTOMER
        ? this.lectura.primerMensajeDelAsistente(
            mensajes.filter(esRespuestaAutomatica).map((m) => m.conversationId),
          )
        : Promise.resolve(new Map<string, number>()),
      this.lectura.adjuntos(mensajes),
      quien.party === Party.COMPANY
        ? this.lectura.etiquetas(ids)
        : Promise.resolve(new Map<string, EtiquetaDeLaConversacion[]>()),
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
    // El cliente y el chofer conocen a la empresa por su marca: la misma
    // consulta da el nombre que ven y la firma del asistente.
    const delPersonal = quien.party === Party.COMPANY;
    const [nombres, nombresDeEmpresas, marcas, ajustes] = await Promise.all([
      this.lectura.nombres(usuarios),
      delPersonal
        ? this.lectura.empresas(empresas)
        : Promise.resolve(new Map<string, string>()),
      this.lectura.marcas(delPersonal ? sinFirma : empresas),
      Promise.all(
        [...empresas].map(
          async (id) => [id, await this.ajustes.leer(id)] as const,
        ),
      ),
    ]);
    return {
      quien,
      ahora,
      nombres,
      empresas: delPersonal ? nombresDeEmpresas : marcas,
      marcas,
      pedidos,
      noLeidos,
      lecturaPropia,
      lecturaDeLaOtraParte,
      ultimos,
      respondidos,
      primerEntrante,
      ajustes: new Map(ajustes),
      atados,
      menciones,
      mencionesSinLeer,
      encuestas,
      primerDelAsistente,
      adjuntos,
      etiquetas,
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
                : vistaPreviaDelMensaje(ultimo),
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
    if (c.channel === Channel.STAFF_CUSTOMER) {
      const e = ctx.encuestas.get(c.conversationId);
      dto.csat = e ? encuestaADto(e, ctx.ahora, esPersonal(ctx)) : null;
    }
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
      dto.unreadMentions = ctx.mencionesSinLeer.get(c.conversationId) ?? 0;
      dto.labels = (ctx.etiquetas.get(c.conversationId) ?? []).map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
      }));
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
    const respondido =
      m.replyToSeq !== null
        ? ctx.respondidos.get(`${m.conversationId}:${m.replyToSeq}`)
        : undefined;
    const automatico = esRespuestaAutomatica(m);
    const interna = m.visibility === MessageVisibility.INTERNAL;
    const dto: InboxMessageDto = {
      id: m.messageId,
      conversationId: m.conversationId,
      seq: m.seq,
      clientMessageId:
        m.senderParty === ctx.quien.party ? m.clientMessageId : null,
      party: m.senderParty,
      sender: this.autor(m, ctx),
      isMine: m.senderParty === ctx.quien.party,
      // La misma regla que el PATCH (D-C22): si quedó atado, no se ofrece.
      canEdit:
        editablePorPlazo(m, ctx.quien, ctx.ahora) &&
        !ctx.atados.has(m.messageId),
      kind: m.kind,
      internal: interna,
      body: sinTexto ? null : m.body,
      attachment: adjuntoADto(ctx.adjuntos.get(m.messageId), sinTexto),
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
      payload: sinTexto
        ? null
        : payloadPara(
            m.payload as Record<string, unknown> | null,
            esPersonal(ctx),
          ),
      replyTo: respondido
        ? {
            seq: respondido.seq,
            party: respondido.senderParty,
            preview:
              respondido.redactedAt || respondido.withdrawnAt
                ? null
                : vistaPreviaDelMensaje(respondido),
          }
        : null,
      editedAt: m.editedAt?.toISOString() ?? null,
      deleted: borrado,
      deletedAt: m.withdrawnAt?.toISOString() ?? null,
      redacted: redactado,
      createdAt: m.createdAt.toISOString(),
    };
    if (interna && esPersonal(ctx)) {
      dto.mentions = ctx.menciones.get(m.messageId) ?? [];
    }
    // 4e: al cliente, los botones de acción en el primer mensaje del asistente.
    const ajustes = ctx.ajustes.get(m.distributorId);
    if (
      ctx.quien.party === Party.CUSTOMER &&
      automatico &&
      ajustes?.customerChatEnabled !== false &&
      ctx.primerDelAsistente.get(m.conversationId) === m.seq
    ) {
      dto.actions = accionesHabilitadas(ajustes?.customerActions ?? []).map(
        ({ key, label, kind, text }) => ({ key, label, kind, text }),
      );
    }
    return dto;
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
