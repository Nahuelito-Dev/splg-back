import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import {
  MessageKind,
  MessageVisibility,
  TicketStatus,
} from '../domain/chat.enums';
import {
  assertAbierto,
  estadoTrasAsignar,
  estadoTrasConfirmar,
  estadoTrasResponder,
  venceLaPrimeraRespuesta,
} from '../domain/support-ticket.machine';
import { SupportTicket } from '../entities/support-ticket.entity';
import { TransicionDeTicketInvalidaError } from '../domain/chat.errors';
import { ETIQUETA_DEL_ESTADO_DEL_TICKET } from '../domain/support-ticket.machine';
import { ChatReadModel } from '../infrastructure/chat-read-model';
import type {
  SendMessageDto,
  UpdateTicketDto,
} from '../presentation/dto/chat-input.dto';
import { ChatEvents, Efectos } from './chat.events';
import { ChatNotices } from './chat-notices';
import { ChatRateLimit } from './chat-rate-limit';
import { MensajeEscrito, MessageWriter } from './message-writer';
import {
  objetivosDe,
  SupportSettingsService,
} from './support-settings.service';
import { ActorDeTicket, bloquearTicket, esPlataforma } from './ticket-store';
import { TicketState } from './ticket-state';

/**
 * Lo que pasa en un ticket abierto (§4.2.2): responder (la respuesta mueve el
 * estado según la máquina), notas internas de la plataforma (no mueven nada y
 * la empresa no las ve), cambios de la plataforma (estado, prioridad,
 * asignación, categoría) y la confirmación de la empresa.
 */
@Injectable()
export class TicketActivityService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly writer: MessageWriter,
    private readonly estado: TicketState,
    private readonly ajustes: SupportSettingsService,
    private readonly lectura: ChatReadModel,
    private readonly cupos: ChatRateLimit,
    private readonly eventos: ChatEvents,
    private readonly avisos: ChatNotices,
  ) {}

  async responder(
    actor: ActorDeTicket,
    ticketId: string,
    dto: SendMessageDto,
    visibility: MessageVisibility = MessageVisibility.ALL,
  ): Promise<MensajeEscrito & { ticket: SupportTicket }> {
    await this.cupos.mensaje(actor.userId, dto.clientMessageId);
    const efectos = new Efectos();
    const r = await this.dataSource.transaction(async (manager) => {
      const ticket = await bloquearTicket(
        manager,
        ticketId,
        actor.distributorId,
      );
      assertAbierto(ticket.status);
      const escrito = await this.writer.escribir(manager, {
        conversationId: ticket.conversationId,
        distributorId: ticket.distributorId,
        senderParty: actor.party,
        senderUserId: actor.userId,
        clientMessageId: dto.clientMessageId,
        kind: MessageKind.TEXT,
        visibility,
        body: dto.body,
        payload: null,
        systemCode: null,
        templateKey: null,
      });
      if (!escrito.created) return { ...escrito, ticket };
      efectos.mensaje(escrito.conversation, escrito.message);
      if (visibility !== MessageVisibility.ALL) return { ...escrito, ticket };

      if (esPlataforma(actor)) {
        ticket.firstResponseAt ??= escrito.message.createdAt;
        ticket.assignedMemberUserId ??= actor.userId;
      }
      const nuevo = estadoTrasResponder(ticket.status, actor.party);
      if (nuevo) await this.estado.cambiar(manager, ticket, nuevo, efectos);
      const guardado = await manager.getRepository(SupportTicket).save(ticket);
      efectos.ticket(guardado, 'updated');
      return { ...escrito, ticket: guardado };
    });
    if (
      r.created &&
      esPlataforma(actor) &&
      visibility === MessageVisibility.ALL
    ) {
      this.avisos.respuestaDeLaPlataforma(r.ticket, r.message.messageId);
    }
    this.eventos.publicar(efectos);
    return r;
  }

  /** Cambios de la plataforma; lo que no viene queda como estaba. */
  async actualizar(
    userId: string,
    ticketId: string,
    dto: UpdateTicketDto,
  ): Promise<SupportTicket> {
    const pide = (
      ['status', 'priority', 'assignedTo', 'category'] as const
    ).some((k) => dto[k] !== undefined);
    if (!pide) {
      throw new BadRequestException('Indicá qué querés cambiar del ticket');
    }
    if (dto.assignedTo) {
      const esMiembro = await this.lectura.esMiembroDeLaPlataforma(
        dto.assignedTo,
      );
      if (!esMiembro) {
        throw conCodigo(
          BadRequestException,
          400,
          'Sólo se puede asignar a alguien activo del equipo de la plataforma',
          CODIGOS_DE_ERROR.TICKET_ASSIGNEE_INVALID,
        );
      }
    }
    const efectos = new Efectos();
    let resuelto = false;
    const ticket = await this.dataSource.transaction(async (manager) => {
      const t = await bloquearTicket(manager, ticketId, null);
      assertAbierto(t.status);
      // Cerrar no es una acción del equipo (§4.2.2): se cierra solo a los 7
      // días o cuando la empresa confirma la solución.
      if (dto.status === TicketStatus.CLOSED) {
        throw new TransicionDeTicketInvalidaError(
          ETIQUETA_DEL_ESTADO_DEL_TICKET[t.status],
          ETIQUETA_DEL_ESTADO_DEL_TICKET[TicketStatus.CLOSED],
        );
      }
      if (dto.category) t.category = dto.category;
      if (dto.priority && dto.priority !== t.priority) {
        t.priority = dto.priority;
        if (t.firstResponseAt === null) {
          const ajustes = await this.ajustes.leer(manager);
          t.firstResponseDueAt = venceLaPrimeraRespuesta(
            t.createdAt,
            t.priority,
            objetivosDe(ajustes),
          );
        }
      }
      if (dto.assignedTo !== undefined) {
        t.assignedMemberUserId = dto.assignedTo;
        const tomado = dto.assignedTo ? estadoTrasAsignar(t.status) : null;
        if (tomado && dto.status === undefined) {
          await this.estado.cambiar(manager, t, tomado, efectos);
        }
      }
      if (dto.status !== undefined) {
        resuelto =
          dto.status === TicketStatus.RESOLVED &&
          t.status !== TicketStatus.RESOLVED;
        await this.estado.cambiar(manager, t, dto.status, efectos);
      }
      const guardado = await manager.getRepository(SupportTicket).save(t);
      efectos.ticket(guardado, 'updated');
      return guardado;
    });
    if (resuelto) this.avisos.resuelto(ticket);
    this.eventos.publicar(efectos);
    return ticket;
  }

  /** La empresa confirma un ticket resuelto (y puede calificar): se cierra. */
  async confirmar(
    distributorId: string,
    ticketId: string,
    satisfaction: number | undefined,
  ): Promise<SupportTicket> {
    const efectos = new Efectos();
    const ticket = await this.dataSource.transaction(async (manager) => {
      const t = await bloquearTicket(manager, ticketId, distributorId);
      const nuevo = estadoTrasConfirmar(t.status);
      t.satisfaction = satisfaction ?? null;
      await this.estado.cambiar(manager, t, nuevo, efectos);
      const guardado = await manager.getRepository(SupportTicket).save(t);
      efectos.ticket(guardado, 'updated');
      return guardado;
    });
    this.eventos.publicar(efectos);
    return ticket;
  }

  /** El proceso automático cierra un ticket (esperando a la empresa o resuelto) si sigue vencido. */
  async cerrarVencido(
    ticketId: string,
    seguirVencido: (t: SupportTicket) => boolean,
  ): Promise<boolean> {
    const efectos = new Efectos();
    const cerrado = await this.dataSource.transaction(async (manager) => {
      const t = await bloquearTicket(manager, ticketId, null);
      if (!seguirVencido(t)) return false;
      await this.estado.cambiar(manager, t, TicketStatus.CLOSED, efectos);
      efectos.ticket(
        await manager.getRepository(SupportTicket).save(t),
        'updated',
      );
      return true;
    });
    this.eventos.publicar(efectos);
    return cerrado;
  }
}
