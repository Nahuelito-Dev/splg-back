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
import { CustomersGateway } from '../../gateways/customers.gateway';
import { DriversGateway } from '../../gateways/drivers.gateway';
import {
  EVENTO_ESCRIBIENDO_DE_LA_APP,
  type EscribiendoDeLaApp,
} from '../../gateways/salas-de-las-apps';
import {
  type ConversacionCambiada,
  EVENTO_CONVERSACION_CAMBIO,
  EVENTO_LECTURA,
  EVENTO_MENSAJE_ACTUALIZADO,
  EVENTO_MENSAJE_CREADO,
  EVENTO_MENSAJE_BORRADO,
  EVENTO_MENSAJE_EDITADO,
  type LecturaRegistrada,
  type MensajeCreado,
  type MensajeEditado,
} from '../application/chat.events';
import {
  Channel,
  ConversationStatus,
  esCanalDeLaBandeja,
  MessageKind,
  MessageVisibility,
  Party,
} from '../domain/chat.enums';
import { vistaPreviaDelMensaje } from '../domain/reglas-del-mensaje';
import { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import { seqVisibleHasta } from '../infrastructure/bandeja-read-model';
import type { Lector } from '../infrastructure/chat-read-model';
import { BandejaPresenter } from './bandeja.presenter';
import {
  ESCRIBIENDO_DURA_MS,
  EVENTO_SOCKET_BANDEJA,
  EVENTO_SOCKET_CONVERSACION,
  EVENTO_SOCKET_ESCRIBIENDO,
  EVENTO_SOCKET_LEIDO,
  EVENTO_SOCKET_MENSAJE,
} from './chat-realtime.listener';

/** Un mensaje propio editado (D-C22), para la otra punta y las otras pestañas. */
export const EVENTO_SOCKET_MENSAJE_EDITADO = 'chat:message-edited';
/** Un mensaje que su autor borró (D-C23): llega sin texto (`deleted: true`). */
export const EVENTO_SOCKET_MENSAJE_BORRADO = 'chat:message-deleted';

/**
 * «Ana está respondiendo» (8b): alguien del equipo escribe (también una nota
 * interna) y el resto del equipo que tiene abierta la conversación se entera,
 * para no responder dos a la vez. Nunca a quien escribe ni al cliente o al chofer.
 */
export const EVENTO_SOCKET_EQUIPO_ESCRIBIENDO = 'chat:staff-typing';

/** En una sala no hay una persona: la lectura y el «sin leer» no aplican. */
const NADIE = '00000000-0000-0000-0000-000000000000';

type CanalDeLaBandeja = Channel.STAFF_CUSTOMER | Channel.STAFF_DRIVER;

/**
 * Lleva los eventos de la bandeja de la empresa (C3, C2) al socket, después
 * del commit (D-C28: una sala por conversación, decidida por el servidor):
 *
 *  - Panel: el mensaje completo a `conv:<id>:company` (sólo quien entró con el
 *    permiso del canal); a las listas `chat:clientes:<empresa>` o
 *    `chat:choferes:<empresa>`, el aviso liviano `chat:inbox`.
 *  - Apps: al chofer (de una sola empresa) el mensaje completo en
 *    `conv:<id>:driver`; al cliente, en `conv:<id>:customer`, sólo el puntero
 *    `{ conversationId, distributorId, seq }` (D-C10, §7.2: un cliente de dos
 *    empresas tiene dos apps; la app pide el mensaje por HTTP con su
 *    `X-Distributor`). A todas sus conexiones (`usuario:<id>`), el puntero
 *    `chat:inbox` sin texto.
 *
 * Del otro lado del personal se ve la empresa, nunca el operador (D-C5). Las
 * notas internas (4a) van sólo al panel: ni el mensaje, ni el puntero, ni el
 * aviso de la lista llegan a la sala o a las conexiones de la persona. Es un
 * aviso: la verdad está en la base (`afterSeq`).
 */
@Injectable()
export class BandejaRealtimeListener {
  private readonly logger = new Logger(BandejaRealtimeListener.name);

  constructor(
    private readonly panel: AdminGateway,
    private readonly clientes: CustomersGateway,
    private readonly choferes: DriversGateway,
    private readonly presentar: BandejaPresenter,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent(EVENTO_MENSAJE_CREADO, { async: true })
  async mensaje({ conversation, message }: MensajeCreado): Promise<void> {
    if (!esCanalDeLaBandeja(conversation.channel)) return;
    await this.seguro(EVENTO_SOCKET_MENSAJE, async () => {
      await this.mensajeALasSalas(conversation, message, EVENTO_SOCKET_MENSAJE);
      this.avisarALasListas(conversation, 'message', message);
    });
  }

  /** El escaneo del adjunto terminó: las salas reciben el mensaje de nuevo (las listas, no). */
  @OnEvent(EVENTO_MENSAJE_ACTUALIZADO, { async: true })
  async actualizacion({
    conversation,
    message,
  }: MensajeEditado): Promise<void> {
    if (!esCanalDeLaBandeja(conversation.channel)) return;
    await this.seguro(EVENTO_SOCKET_MENSAJE, () =>
      this.mensajeALasSalas(conversation, message, EVENTO_SOCKET_MENSAJE),
    );
  }

  @OnEvent(EVENTO_MENSAJE_EDITADO, { async: true })
  async edicion({ conversation, message }: MensajeEditado): Promise<void> {
    if (!esCanalDeLaBandeja(conversation.channel)) return;
    await this.seguro(EVENTO_SOCKET_MENSAJE_EDITADO, async () => {
      await this.mensajeALasSalas(
        conversation,
        message,
        EVENTO_SOCKET_MENSAJE_EDITADO,
      );
      if (message.seq === conversation.lastMessageSeq) {
        this.avisarALasListas(conversation, 'edited', message);
      }
    });
  }

  @OnEvent(EVENTO_MENSAJE_BORRADO, { async: true })
  async borrado({ conversation, message }: MensajeEditado): Promise<void> {
    if (!esCanalDeLaBandeja(conversation.channel)) return;
    await this.seguro(EVENTO_SOCKET_MENSAJE_BORRADO, async () => {
      await this.mensajeALasSalas(
        conversation,
        message,
        EVENTO_SOCKET_MENSAJE_BORRADO,
      );
      if (message.seq === conversation.lastMessageSeq) {
        this.avisarALasListas(conversation, 'deleted', message);
      }
    });
  }

  @OnEvent(EVENTO_CONVERSACION_CAMBIO, { async: true })
  async conversacion({
    conversation,
    change,
  }: ConversacionCambiada): Promise<void> {
    if (!esCanalDeLaBandeja(conversation.channel)) return;
    await this.seguro(EVENTO_SOCKET_CONVERSACION, async () => {
      const base = {
        conversationId: conversation.conversationId,
        distributorId: conversation.distributorId,
        change,
      };
      const empresa = await this.presentar.conversacion(
        conversation,
        sala(Party.COMPANY),
      );
      this.panel.emitirAConversacion(
        conversation.conversationId,
        'company',
        EVENTO_SOCKET_CONVERSACION,
        { ...base, conversation: empresa },
      );
      // Las etiquetas son del equipo (7c): la persona no se entera.
      if (change === 'labels') {
        this.avisarALasListas(conversation, change, null, {
          soloPanel: true,
          labels: empresa.labels ?? [],
        });
        return;
      }
      // Al cliente, el puntero (D-C10); al chofer, la ficha.
      this.aLaPersona(
        conversation,
        EVENTO_SOCKET_CONVERSACION,
        conversation.channel === Channel.STAFF_CUSTOMER
          ? base
          : {
              ...base,
              conversation: await this.presentar.conversacion(
                conversation,
                sala(Party.DRIVER),
              ),
            },
      );
      this.avisarALasListas(conversation, change, null);
    });
  }

  /**
   * El «leído»: a las otras conexiones de quien leyó y, si subió la lectura de
   * su punta, a la otra punta dentro de la sala de la conversación.
   */
  @OnEvent(EVENTO_LECTURA, { async: true })
  async lectura(evento: LecturaRegistrada): Promise<void> {
    if (!esCanalDeLaBandeja(evento.channel)) return;
    await this.seguro(EVENTO_SOCKET_LEIDO, async () => {
      const payload = {
        conversationId: evento.conversationId,
        party: evento.party,
        lastReadSeq: evento.lastReadSeq,
      };
      const delPersonal = evento.party === Party.COMPANY;
      if (evento.personal) {
        if (delPersonal) {
          this.panel.emitirAUsuario(
            evento.userId,
            EVENTO_SOCKET_LEIDO,
            payload,
          );
        } else if (evento.party === Party.CUSTOMER) {
          this.clientes.emitirAUsuario(
            evento.userId,
            EVENTO_SOCKET_LEIDO,
            payload,
          );
        } else {
          this.choferes.emitirAUsuario(
            evento.userId,
            EVENTO_SOCKET_LEIDO,
            payload,
          );
        }
      }
      if (!evento.deLaParte) return;
      if (!delPersonal) {
        this.panel.emitirAConversacion(
          evento.conversationId,
          'company',
          EVENTO_SOCKET_LEIDO,
          payload,
        );
        return;
      }
      const c = await this.dataSource
        .getRepository(Conversation)
        .findOne({ where: { conversationId: evento.conversationId } });
      // A la persona, el «leído» sobre lo que ella ve: si el personal leyó
      // hasta una nota interna, el último visible antes (4a).
      if (c) {
        this.aLaPersona(c, EVENTO_SOCKET_LEIDO, {
          ...payload,
          lastReadSeq: await seqVisibleHasta(
            this.dataSource,
            c.conversationId,
            evento.lastReadSeq,
          ),
        });
      }
    });
  }

  /**
   * «Escribiendo…» del personal: al cliente o al chofer, sin decir quién
   * (D-C5). Si redacta una nota interna (`internal`, 4a), no se reenvía: la
   * persona no se entera de que escriben algo que no va a ver. Al resto del
   * equipo que tiene abierta la conversación, en cambio, sí y con quién
   * (`chat:staff-typing`, 8b), también con una nota interna.
   */
  @OnEvent(EVENTO_ESCRIBIENDO_DEL_PANEL, { async: true })
  async escribiendoDelPanel(pedido: EscribiendoDelPanel): Promise<void> {
    if (pedido.esPlataforma) return;
    await this.seguro(EVENTO_SOCKET_ESCRIBIENDO, async () => {
      const c = await this.abiertaDeLaBandeja(pedido.conversationId);
      if (!c || c.distributorId !== pedido.distributorId) return;
      const until = hasta();
      // Al resto del equipo con la conversación abierta, con quién (8b).
      this.panel.emitirAConversacionMenosA(
        c.conversationId,
        'company',
        pedido.userId,
        EVENTO_SOCKET_EQUIPO_ESCRIBIENDO,
        {
          conversationId: c.conversationId,
          userId: pedido.userId,
          name: await this.nombreDe(pedido.userId),
          internal: pedido.internal,
          until,
        },
      );
      if (pedido.internal) return;
      this.aLaPersona(c, EVENTO_SOCKET_ESCRIBIENDO, {
        conversationId: c.conversationId,
        party: Party.COMPANY,
        until,
      });
    });
  }

  /** «Escribiendo…» del cliente o del chofer: a quienes tienen abierta la conversación en el panel. */
  @OnEvent(EVENTO_ESCRIBIENDO_DE_LA_APP, { async: true })
  async escribiendoDeLaApp(pedido: EscribiendoDeLaApp): Promise<void> {
    await this.seguro(EVENTO_SOCKET_ESCRIBIENDO, async () => {
      const c = await this.abiertaDeLaBandeja(pedido.conversationId);
      if (!c) return;
      const suya =
        pedido.punta === 'customer'
          ? c.customerUserId === pedido.userId
          : c.driverUserId === pedido.userId;
      if (!suya) return;
      this.panel.emitirAConversacion(
        c.conversationId,
        'company',
        EVENTO_SOCKET_ESCRIBIENDO,
        {
          conversationId: c.conversationId,
          party: pedido.punta === 'customer' ? Party.CUSTOMER : Party.DRIVER,
          until: hasta(),
        },
      );
    });
  }

  /** Cada punta, su versión del mensaje, en la sala de la conversación. */
  private async mensajeALasSalas(
    c: Conversation,
    m: Message,
    evento: string,
  ): Promise<void> {
    const base = {
      conversationId: c.conversationId,
      distributorId: c.distributorId,
      seq: m.seq,
    };
    this.panel.emitirAConversacion(c.conversationId, 'company', evento, {
      ...base,
      message: await this.presentar.mensaje(m, sala(Party.COMPANY)),
    });
    // Una nota interna es sólo del personal: a la sala de la persona, nada.
    if (m.visibility === MessageVisibility.INTERNAL) return;
    // D-C10 (§7.2): al cliente, sólo el puntero; lo pide por HTTP con su
    // `X-Distributor`. Al chofer (de una sola empresa), el mensaje.
    if (c.channel === Channel.STAFF_CUSTOMER) {
      this.aLaPersona(c, evento, base);
      return;
    }
    this.aLaPersona(c, evento, {
      ...base,
      message: await this.presentar.mensaje(m, sala(Party.DRIVER)),
    });
  }

  /**
   * Listas: al personal que atiende el canal, con vista previa; a la persona,
   * en todas sus conexiones, sólo el puntero (D-C10).
   */
  private avisarALasListas(
    c: Conversation,
    change: string,
    m: Message | null,
    extra: { soloPanel?: boolean; labels?: unknown[] } = {},
  ): void {
    const canal = c.channel as CanalDeLaBandeja;
    this.panel.emitirALaBandeja(c.distributorId, canal, EVENTO_SOCKET_BANDEJA, {
      conversationId: c.conversationId,
      distributorId: c.distributorId,
      channel: c.channel,
      status: c.status,
      change,
      assignedToUserId: c.assignedToUserId,
      lastMessage: m
        ? {
            seq: m.seq,
            at: m.createdAt.toISOString(),
            party: m.senderParty,
            kind: m.kind,
            preview:
              m.kind === MessageKind.SYSTEM || m.redactedAt || m.withdrawnAt
                ? null
                : vistaPreviaDelMensaje(m),
            internal: m.visibility === MessageVisibility.INTERNAL,
          }
        : null,
      ...(extra.labels ? { labels: extra.labels } : {}),
    });
    // Una nota interna o un cambio de etiquetas: la persona no se entera de que hubo algo.
    if (extra.soloPanel || m?.visibility === MessageVisibility.INTERNAL) return;
    const puntero = {
      conversationId: c.conversationId,
      distributorId: c.distributorId,
      status: c.status,
      change,
      seq: m?.seq ?? null,
    };
    const persona = personaDe(c);
    if (persona.party === Party.CUSTOMER) {
      this.clientes.emitirAUsuario(
        persona.userId,
        EVENTO_SOCKET_BANDEJA,
        puntero,
      );
    } else {
      this.choferes.emitirAUsuario(
        persona.userId,
        EVENTO_SOCKET_BANDEJA,
        puntero,
      );
    }
  }

  private aLaPersona(c: Conversation, evento: string, payload: unknown): void {
    if (c.channel === Channel.STAFF_CUSTOMER) {
      this.clientes.emitirAConversacion(c.conversationId, evento, payload);
    } else {
      this.choferes.emitirAConversacion(c.conversationId, evento, payload);
    }
  }

  /** El nombre de alguien del equipo, como lo ve el resto del equipo. */
  private async nombreDe(userId: string): Promise<string> {
    const [fila]: Array<{ full_name: string | null }> =
      await this.dataSource.query(
        `SELECT "full_name" FROM "user" WHERE "user_id" = $1`,
        [userId],
      );
    return fila?.full_name ?? 'Alguien del equipo';
  }

  private async abiertaDeLaBandeja(
    conversationId: string,
  ): Promise<Conversation | null> {
    const c = await this.dataSource
      .getRepository(Conversation)
      .findOne({ where: { conversationId } });
    return c &&
      esCanalDeLaBandeja(c.channel) &&
      c.status === ConversationStatus.OPEN
      ? c
      : null;
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

function sala(party: Lector['party']): Lector {
  return { party, userId: NADIE };
}

function personaDe(c: Conversation): {
  party: Party.CUSTOMER | Party.DRIVER;
  userId: string;
} {
  return c.channel === Channel.STAFF_CUSTOMER
    ? { party: Party.CUSTOMER, userId: c.customerUserId as string }
    : { party: Party.DRIVER, userId: c.driverUserId as string };
}

function hasta(): string {
  return new Date(Date.now() + ESCRIBIENDO_DURA_MS).toISOString();
}
