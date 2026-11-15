import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfiguracionDePlataforma } from '../../common/config/plataforma.config';
import { NOMBRE_DE_PLATAFORMA_POR_DEFECTO } from '../../common/config/plataforma.config';
import { Channel, Party } from '../domain/chat.enums';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import type { SupportTicket } from '../entities/support-ticket.entity';
import { ChatReadModel, Observador } from '../infrastructure/chat-read-model';

/** Todo lo que hace falta, además de las entidades, para armar las respuestas de quien mira. */
export interface ContextoDeVista {
  observador: Observador;
  plataforma: string;
  nombres: Map<string, string>;
  empresas: Map<string, string>;
  noLeidos: Map<string, number>;
  lecturaDeLaOtraParte: Map<string, number>;
  /** Hasta dónde leyó quien mira, por conversación (sólo la de los hilos de los tickets). */
  lecturaPropia: Map<string, number>;
  ultimos: Map<string, Message>;
  citados: Map<string, Array<{ ticketId: string; number: string }>>;
  ticketsDesde: Map<string, SupportTicket[]>;
  ticketDelHilo: Map<string, SupportTicket>;
  sesiones: Map<string, Array<{ id: string; status: string }>>;
}

export interface QueMostrar {
  conversaciones?: readonly Conversation[];
  mensajes?: readonly Message[];
  tickets?: readonly SupportTicket[];
}

/**
 * Junta en pocas consultas lo que las respuestas necesitan de otras tablas,
 * para todo lo que se va a mostrar de una vez (sin una consulta por fila).
 */
@Injectable()
export class ChatViewsService {
  constructor(
    private readonly lectura: ChatReadModel,
    private readonly config: ConfigService,
  ) {}

  nombreDeLaPlataforma(): string {
    return (
      this.config.get<ConfiguracionDePlataforma>('plataforma')?.name ??
      NOMBRE_DE_PLATAFORMA_POR_DEFECTO
    );
  }

  async contexto(
    observador: Observador,
    que: QueMostrar,
  ): Promise<ContextoDeVista> {
    const conversaciones = [...(que.conversaciones ?? [])];
    const mensajes = [...(que.mensajes ?? [])];
    const convIds = conversaciones.map((c) => c.conversationId);
    const chats = conversaciones
      .filter((c) => c.channel === Channel.PLATFORM_CHAT)
      .map((c) => c.conversationId);
    const hilos = conversaciones
      .filter((c) => c.channel === Channel.PLATFORM_TICKET)
      .map((c) => c.conversationId);
    const otra =
      observador.party === Party.COMPANY ? Party.PLATFORM : Party.COMPANY;

    const [
      noLeidos,
      lecturaDeLaOtraParte,
      ultimos,
      citados,
      ticketsDesde,
      ticketDelHilo,
    ] = await Promise.all([
      this.lectura.noLeidos(convIds, observador),
      this.lectura.lecturaDeLaOtraParte(convIds, otra),
      this.lectura.ultimosVisibles(convIds, observador.party),
      // Sólo los mensajes del chat se citan; los del hilo no dan resultados.
      this.lectura.citadosEn(mensajes.map((m) => m.messageId)),
      this.lectura.ticketsDesde(chats),
      this.lectura.ticketsDeLosHilos(hilos),
    ]);

    const tickets = [...(que.tickets ?? []), ...ticketDelHilo.values()];
    // Los resúmenes de ticket (listas, tarjetas del chat) llevan sus no leídos
    // y su último mensaje: los de los hilos que no se pidieron arriba.
    const hilosDeTickets = [
      ...new Set(
        [...tickets, ...[...ticketsDesde.values()].flat()]
          .map((t) => t.conversationId)
          .filter((id) => !convIds.includes(id)),
      ),
    ];
    // El «leído» de las fichas de ticket: el de la otra punta y el propio.
    const hilosDeLasFichas = [...new Set(tickets.map((t) => t.conversationId))];
    const [lecturaPropia] = await Promise.all([
      this.lectura.lecturaPropia(hilosDeLasFichas, observador.userId),
      this.completarLecturaDeLaOtraParte(
        hilosDeLasFichas.filter((id) => !convIds.includes(id)),
        otra,
        lecturaDeLaOtraParte,
      ),
    ]);
    if (hilosDeTickets.length > 0) {
      const [masNoLeidos, masUltimos] = await Promise.all([
        this.lectura.noLeidos(hilosDeTickets, observador),
        this.lectura.ultimosVisibles(hilosDeTickets, observador.party),
      ]);
      for (const [k, v] of masNoLeidos) noLeidos.set(k, v);
      for (const [k, v] of masUltimos) ultimos.set(k, v);
    }
    const usuarios = new Set<string>();
    for (const c of conversaciones) {
      if (c.assignedToUserId) usuarios.add(c.assignedToUserId);
    }
    for (const m of [...mensajes, ...ultimos.values()]) {
      if (m.senderUserId) usuarios.add(m.senderUserId);
    }
    for (const t of tickets) {
      if (t.assignedMemberUserId) usuarios.add(t.assignedMemberUserId);
    }
    const [nombres, empresas, sesiones] = await Promise.all([
      this.lectura.nombres(usuarios),
      this.lectura.empresas([
        ...conversaciones.map((c) => c.distributorId),
        ...tickets.map((t) => t.distributorId),
      ]),
      this.lectura.sesionesDeSoporte(tickets),
    ]);
    return {
      observador,
      plataforma: this.nombreDeLaPlataforma(),
      nombres,
      empresas,
      noLeidos,
      lecturaDeLaOtraParte,
      lecturaPropia,
      ultimos,
      citados,
      ticketsDesde,
      ticketDelHilo,
      sesiones,
    };
  }

  private async completarLecturaDeLaOtraParte(
    conversationIds: string[],
    otra: Party.COMPANY | Party.PLATFORM,
    destino: Map<string, number>,
  ): Promise<void> {
    if (conversationIds.length === 0) return;
    const mas = await this.lectura.lecturaDeLaOtraParte(conversationIds, otra);
    for (const [k, v] of mas) destino.set(k, v);
  }
}
