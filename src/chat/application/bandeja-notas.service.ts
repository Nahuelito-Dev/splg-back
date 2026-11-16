import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../../common/events/notificar-admin.event';
import type { CanalDeLaBandeja } from '../domain/bandeja';
import { Channel, MessageKind, MessageVisibility } from '../domain/chat.enums';
import {
  aQuienesAvisar,
  assertMencionables,
  textoDelAvisoDeMencion,
} from '../domain/notas-internas';
import { MessageMention } from '../entities/message-mention.entity';
import type { SendInternalNoteDto } from '../presentation/dto/bandeja-input.dto';
import { type ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import { BandejaEquipoService } from './bandeja-equipo.service';
import { ChatEvents, Efectos } from './chat.events';
import { ChatRateLimit } from './chat-rate-limit';
import { type MensajeEscrito, MessageWriter } from './message-writer';

/** Tipo de aviso del panel para una mención en una nota del chat. */
export const AVISO_DE_MENCION = 'chat_mention';

/**
 * Notas internas de la bandeja con @menciones (4a). La nota es un mensaje de
 * texto del personal con visibilidad `internal`: sólo la ve el personal de esa
 * empresa (nunca el cliente o el chofer, ni por HTTP ni por el socket de su
 * punta, ni el asistente con IA). No cuenta como primera respuesta, no saca a
 * la conversación de «esperando persona», no cambia la vista previa ni el
 * orden de la lista de la otra punta.
 *
 * Las menciones son del personal que atiende el canal (la regla de
 * `assignees`); a cada mencionado (menos al autor) le llega un aviso del panel
 * dirigido sólo a él, y la nota queda en «Me mencionaron» hasta que la marca
 * leída. Se edita como cualquier mensaje propio (sólo el autor, 15 minutos);
 * no se borra (el borrado es sólo del cliente, D-C23). La auditoría la
 * escriben los triggers de `message` y `message_mention`.
 */
@Injectable()
export class BandejaNotasService {
  private readonly logger = new Logger(BandejaNotasService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly acceso: BandejaAcceso,
    private readonly equipo: BandejaEquipoService,
    private readonly writer: MessageWriter,
    private readonly cupos: ChatRateLimit,
    private readonly eventos: ChatEvents,
    private readonly avisos: EventEmitter2,
  ) {}

  /**
   * Deja una nota en una conversación abierta de un canal que atiende quien
   * escribe. 400 si menciona a alguien que no atiende el canal; el mismo
   * `clientMessageId` devuelve la nota ya guardada (sin volver a avisar).
   */
  async escribir(
    actor: ActorDeLaBandeja,
    conversationId: string,
    dto: SendInternalNoteDto,
  ): Promise<MensajeEscrito> {
    const conversacion = await this.acceso.buscar(actor, conversationId);
    const menciones = [...new Set(dto.mentions ?? [])];
    if (menciones.length > 0) {
      const atienden = await this.equipo.quienesAtienden(
        actor.distributorId,
        conversacion.channel as CanalDeLaBandeja,
      );
      assertMencionables(menciones, new Set(atienden.map((p) => p.userId)));
    }
    await this.cupos.mensaje({
      ambito: actor.distributorId,
      userId: actor.userId,
      clientMessageId: dto.clientMessageId,
    });
    const efectos = new Efectos();
    const escrito = await this.dataSource.transaction(async (manager) => {
      const r = await this.writer.escribir(manager, {
        conversationId: conversacion.conversationId,
        distributorId: conversacion.distributorId,
        senderParty: actor.party,
        senderUserId: actor.userId,
        clientMessageId: dto.clientMessageId,
        kind: MessageKind.TEXT,
        visibility: MessageVisibility.INTERNAL,
        body: dto.body,
        payload: null,
        systemCode: null,
        templateKey: null,
      });
      if (!r.created) return r;
      if (menciones.length > 0) {
        await manager.getRepository(MessageMention).insert(
          menciones.map((mentionedUserId) => ({
            messageId: r.message.messageId,
            conversationId: r.conversation.conversationId,
            distributorId: r.conversation.distributorId,
            mentionedUserId,
            readAt: null,
          })),
        );
      }
      efectos.mensaje(r.conversation, r.message);
      return r;
    });
    this.eventos.publicar(efectos);
    if (escrito.created) {
      this.avisarALosMencionados(actor, escrito, menciones, dto.body);
    }
    return escrito;
  }

  /**
   * Marca leídas las menciones a quien pide en esa conversación (todas, o
   * hasta la nota `hastaSeq`). Devuelve cuántas marcó. Una conversación de otra
   * empresa o de un canal que no atiende → 404.
   */
  async marcarLeidas(
    actor: ActorDeLaBandeja,
    conversationId: string,
    hastaSeq?: number,
  ): Promise<number> {
    const c = await this.acceso.buscar(actor, conversationId);
    return marcarMencionesLeidas(
      this.dataSource,
      c.conversationId,
      actor.userId,
      actor.distributorId,
      hastaSeq,
    );
  }

  /** Un aviso del panel para cada mencionado, sólo a él. Best-effort: nunca rompe la nota. */
  private avisarALosMencionados(
    actor: ActorDeLaBandeja,
    escrito: MensajeEscrito,
    menciones: readonly string[],
    texto: string,
  ): void {
    const c = escrito.conversation;
    const conQuien =
      c.channel === Channel.STAFF_CUSTOMER
        ? 'una conversación con un cliente'
        : 'una conversación con un chofer';
    for (const userId of aQuienesAvisar(menciones, actor.userId)) {
      try {
        this.avisos.emit(
          EVENTO_NOTIFICAR_ADMIN,
          new NotificarAdminEvent(
            c.distributorId,
            AVISO_DE_MENCION,
            `Te mencionaron en ${conQuien}`,
            textoDelAvisoDeMencion(texto),
            { entity: 'conversation', id: c.conversationId },
            false,
            `chat-mention:${escrito.message.messageId}:${userId}`,
            undefined,
            userId,
          ),
        );
      } catch (error) {
        this.logger.warn(
          `No se pudo avisar la mención en la conversación ${c.conversationId}: ${errorMessage(error)}`,
        );
      }
    }
  }
}

/**
 * Marca leídas las menciones sin leer de esa persona en la conversación (hasta
 * la nota `hastaSeq`, si viene). Lo usan «marcar leídas» y la lectura de la
 * conversación (leer hasta una nota es haberla visto).
 */
export async function marcarMencionesLeidas(
  dataSource: Pick<DataSource, 'query'>,
  conversationId: string,
  userId: string,
  distributorId: string,
  hastaSeq?: number,
): Promise<number> {
  const resultado: unknown = await dataSource.query(
    `UPDATE "message_mention" mm SET "read_at" = now()
       FROM "message" m
      WHERE m."message_id" = mm."message_id"
        AND mm."conversation_id" = $1 AND mm."mentioned_user_id" = $2
        AND mm."distributor_id" = $3 AND mm."read_at" IS NULL
        AND ($4::bigint IS NULL OR m."seq" <= $4)
      RETURNING mm."mention_id"`,
    [conversationId, userId, distributorId, hastaSeq ?? null],
  );
  return filasDe(resultado);
}

/** Un `UPDATE ... RETURNING` de Postgres devuelve `[filas, cantidad]`. */
function filasDe(resultado: unknown): number {
  if (!Array.isArray(resultado)) return 0;
  const filas: unknown = Array.isArray(resultado[0]) ? resultado[0] : resultado;
  return Array.isArray(filas) ? filas.length : 0;
}
