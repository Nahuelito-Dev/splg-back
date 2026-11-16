import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import {
  type ChoferDelPedidoCambiado,
  EVENTO_CHOFER_DEL_PEDIDO_CAMBIADO,
} from '../../order/domain/events/chofer-del-pedido-cambiado.event';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SubjectType,
  SystemCode,
} from '../domain/chat.enums';
import {
  ChatNoEscribibleError,
  ConversacionCerradaError,
} from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import { clienteDeLaEmpresa, choferDeLaEmpresa } from './bandeja-personas';
import { ChatEvents, Efectos } from './chat.events';
import { MessageWriter } from './message-writer';

/**
 * Que una conversación de la bandeja siga siendo de quien está en ella
 * (Corrección 1 de CH3):
 *
 *  - C2 por pedido es del pedido **y del chofer**: si el pedido pasa a otro
 *    chofer (o vuelve a buscar uno), la del anterior se cierra con
 *    `driver_changed` y un mensaje de sistema; el anterior la sigue leyendo
 *    pero ya no escribe, y no ve nada de la del nuevo (es otra conversación).
 *    Se cierra al reasignar (evento `pedido.chofer-cambiado`) y, por las dudas
 *    de un camino que no avise, también al intentar escribir en ella.
 *  - La persona sigue siendo de la empresa: un chofer dado de baja o un
 *    cliente sin vínculo ni pedidos ya no reciben ni mandan mensajes (409
 *    `CHAT_NOT_WRITABLE`), tampoco la empresa a ellos.
 */
@Injectable()
export class ConversacionVigente {
  private readonly logger = new Logger(ConversacionVigente.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly writer: MessageWriter,
    private readonly eventos: ChatEvents,
  ) {}

  /**
   * 409 si ya no se puede escribir: C2 por pedido cuyo chofer cambió (y se
   * cierra en ese momento) o persona que ya no es de la empresa.
   */
  async assertSePuedeEscribir(c: Conversation): Promise<void> {
    const manager = this.dataSource.manager;
    if (await this.cambioElChofer(manager, c)) {
      await this.cerrar(c.conversationId);
      throw new ConversacionCerradaError();
    }
    if (!(await this.personaDeLaEmpresa(manager, c))) {
      throw new ChatNoEscribibleError();
    }
  }

  /** Al reasignar el pedido: cierra las C2 abiertas de ese pedido que no son del chofer actual. */
  @OnEvent(EVENTO_CHOFER_DEL_PEDIDO_CAMBIADO, { async: true })
  async alCambiarElChofer(evento: ChoferDelPedidoCambiado): Promise<void> {
    try {
      await this.cerrarLasDeOtrosChoferes(evento.orderId, evento.distributorId);
    } catch (error) {
      this.logger.warn(
        `No se pudieron cerrar las conversaciones del chofer anterior del pedido ${evento.orderId}: ${errorMessage(error)}`,
      );
    }
  }

  /** Cierra las C2 abiertas del pedido de un chofer que ya no es el suyo. Devuelve cuántas. */
  async cerrarLasDeOtrosChoferes(
    orderId: string,
    distributorId: string,
  ): Promise<number> {
    const filas: Array<{ conversation_id: string }> =
      await this.dataSource.query(
        `SELECT c."conversation_id" FROM "conversation" c
           JOIN "order" o ON o."order_id" = c."order_id" AND o."distributor_id" = c."distributor_id"
           LEFT JOIN "delivery" d ON d."delivery_id" = o."delivery_id"
          WHERE c."order_id" = $1 AND c."distributor_id" = $2
            AND c."channel" = 'staff_driver' AND c."subject_type" = 'order'
            AND c."status" = 'open' AND c."deleted_at" IS NULL
            AND c."driver_user_id" IS DISTINCT FROM d."user_id"`,
        [orderId, distributorId],
      );
    for (const f of filas) await this.cerrar(f.conversation_id);
    return filas.length;
  }

  private async cambioElChofer(
    manager: EntityManager,
    c: Conversation,
  ): Promise<boolean> {
    if (
      c.channel !== Channel.STAFF_DRIVER ||
      c.subjectType !== SubjectType.ORDER ||
      c.status !== ConversationStatus.OPEN ||
      !c.orderId
    ) {
      return false;
    }
    const [fila]: Array<{ chofer: string | null }> = await manager.query(
      `SELECT d."user_id" AS chofer FROM "order" o
         LEFT JOIN "delivery" d ON d."delivery_id" = o."delivery_id"
        WHERE o."order_id" = $1 AND o."distributor_id" = $2`,
      [c.orderId, c.distributorId],
    );
    return (fila?.chofer ?? null) !== c.driverUserId;
  }

  private personaDeLaEmpresa(
    manager: EntityManager,
    c: Conversation,
  ): Promise<boolean> {
    if (c.channel === Channel.STAFF_CUSTOMER && c.customerUserId) {
      return clienteDeLaEmpresa(manager, c.customerUserId, c.distributorId);
    }
    if (c.channel === Channel.STAFF_DRIVER && c.driverUserId) {
      return choferDeLaEmpresa(manager, c.driverUserId, c.distributorId);
    }
    return Promise.resolve(true);
  }

  /** Cierra con `driver_changed` y un mensaje de sistema; si ya estaba cerrada, nada. */
  private async cerrar(conversationId: string): Promise<void> {
    const efectos = new Efectos();
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Conversation);
      const c = await repo.findOne({
        where: { conversationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!c || c.status !== ConversationStatus.OPEN) return;
      const r = await this.writer.escribir(manager, {
        conversationId: c.conversationId,
        distributorId: c.distributorId,
        senderParty: Party.SYSTEM,
        senderUserId: null,
        clientMessageId: null,
        kind: MessageKind.SYSTEM,
        visibility: MessageVisibility.ALL,
        body: null,
        payload: null,
        systemCode: SystemCode.DRIVER_CHANGED,
        templateKey: null,
      });
      efectos.mensaje(r.conversation, r.message);
      const actual = await repo.findOneByOrFail({ conversationId });
      actual.status = ConversationStatus.CLOSED;
      actual.closedAt = new Date();
      actual.closedReason = ConversationClosedReason.DRIVER_CHANGED;
      actual.closedByUserId = null;
      efectos.conversacion(await repo.save(actual), 'closed');
    });
    this.eventos.publicar(efectos);
  }
}
