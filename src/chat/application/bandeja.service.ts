import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  ambitoValido,
  assertSePuedeBorrar,
  assertSePuedeConsultarPorElPedido,
  assertSePuedeEditar,
  type AtadurasDelMensaje,
  type CanalDeLaBandeja,
  completarPlantilla,
} from '../domain/bandeja';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SubjectType,
} from '../domain/chat.enums';
import {
  ConversacionCerradaError,
  PedidoSinChoferError,
} from '../domain/chat.errors';
import { vistaPrevia } from '../domain/reglas-del-mensaje';
import { Conversation } from '../entities/conversation.entity';
import { MessageEdit } from '../entities/message-edit.entity';
import { Message } from '../entities/message.entity';
import type { MessagesQueryDto } from '../presentation/dto/chat-input.dto';
import type {
  OpenMyConversationDto,
  OpenStaffConversationDto,
  SendCustomerActionDto,
  SendInboxMessageDto,
  SendStaffMessageDto,
} from '../presentation/dto/bandeja-input.dto';
import {
  type ActorDeLaBandeja,
  BandejaAcceso,
  esDelPersonal,
  lectorDe,
} from './bandeja-acceso';
import {
  accionesHabilitadas,
  accionParaMandar,
  type AccionDelCliente,
} from '../domain/acciones-del-cliente';
import {
  borradoNoPermitido,
  soloDelCliente,
  chatDeClientesApagado,
  mensajeAjeno,
  noExisteElChofer,
  noExisteElCliente,
  noExisteElMensaje,
  noExisteElPedido,
  sinRelacionConLaEmpresa,
} from './bandeja.errors';
import { AsistenteDelChat, dejaDeEsperarPersona } from './asistente-del-chat';
import { marcarMencionesLeidas } from './bandeja-notas.service';
import { ChatEvents, Efectos } from './chat.events';
import { RespuestasFijas } from './respuestas-fijas';
import { ChatRateLimit } from './chat-rate-limit';
import { ChatThreadsService } from './chat-threads.service';
import { CompanyChatSettingsService } from './company-chat-settings.service';
import { CompanyTemplatesService } from './company-templates.service';
import { ConversationFactory } from './conversation-factory';
import { ConversacionVigente } from './conversacion-vigente';
import { choferDeLaEmpresa, clienteDeLaEmpresa } from './bandeja-personas';
import { MensajeEscrito, MessageWriter } from './message-writer';
import { valoresDePlantilla } from './valores-de-plantilla';

/** Lo que cambia un envío del cliente: con «hablar con una persona» (4e), la pasa a una persona. */
export interface OpcionesDelEnvio {
  pedirPersona?: boolean;
}

/**
 * El cliente pidió hablar con una persona (4e): si nadie la atiende, queda
 * «esperando persona» (como cuando deriva el asistente) y el equipo se entera
 * por el aviso de la bandeja. Con la conversación bloqueada por el envío, y
 * antes de decidir la respuesta automática: así el asistente con IA no la
 * toma y salen las fijas (recibido, fuera de horario).
 */
export async function pedirUnaPersona(
  manager: EntityManager,
  c: Conversation,
  efectos: Efectos,
  ahora: Date,
): Promise<void> {
  if (c.assignedToUserId || c.awaitingHumanSince) return;
  await manager.query(
    `UPDATE "conversation" SET "awaiting_human_since" = $2
      WHERE "conversation_id" = $1 AND "awaiting_human_since" IS NULL
        AND "assigned_to_user_id" IS NULL`,
    [c.conversationId, ahora],
  );
  c.awaitingHumanSince = ahora;
  efectos.conversacion(c, 'status');
}

/** Con quién y de qué es la conversación que se abre o se sigue. */
export interface DestinoDeLaBandeja {
  channel: CanalDeLaBandeja;
  subjectType: SubjectType.GENERAL | SubjectType.ORDER;
  orderId: string | null;
  customerUserId: string | null;
  driverUserId: string | null;
}

/** Lo que se sabe de un pedido para abrir una conversación por él. */
interface PedidoDeLaEmpresa {
  orderId: string;
  status: string;
  customerId: string;
  driverUserId: string | null;
  terminadoEn: Date | null;
}

/** Lo que escribe quien manda: texto (o respuesta guardada) y, si responde, a qué. */
type MensajeEntrante = SendInboxMessageDto | SendStaffMessageDto;

export interface ConversacionAbierta extends MensajeEscrito {
  /** Se creó la conversación (201); si ya estaba abierta, 200. */
  conversationCreated: boolean;
}

/**
 * La bandeja de la empresa (C3 con clientes, C2 con choferes; diseño §4.3,
 * §4.4, §7.4, §8.4 y §21): abrir o seguir una conversación, escribir (con
 * idempotencia por `clientMessageId` y número por conversación del núcleo),
 * responder a un mensaje, editar uno propio, leer y marcar leído, con las
 * respuestas automáticas de la empresa. Los avisos por el socket salen después
 * del commit.
 */
@Injectable()
export class BandejaService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly acceso: BandejaAcceso,
    private readonly writer: MessageWriter,
    private readonly fabrica: ConversationFactory,
    private readonly hilos: ChatThreadsService,
    private readonly ajustes: CompanyChatSettingsService,
    private readonly plantillas: CompanyTemplatesService,
    private readonly cupos: ChatRateLimit,
    private readonly eventos: ChatEvents,
    private readonly vigente: ConversacionVigente,
    private readonly fijas: RespuestasFijas,
    private readonly asistente: AsistenteDelChat,
  ) {}

  /**
   * El cliente o el chofer abre (o sigue) una conversación con la empresa,
   * con un primer mensaje o (sólo el cliente, 4e) tocando un botón de acción:
   * se manda su texto y `talk_to_person` además la deja esperando a una
   * persona.
   */
  async abrirDeLaPersona(
    actor: ActorDeLaBandeja,
    dto: OpenMyConversationDto,
    ahora: Date = new Date(),
  ): Promise<ConversacionAbierta> {
    if ((dto.firstMessage === undefined) === (dto.firstAction === undefined)) {
      throw new BadRequestException(
        'Escribí el primer mensaje o tocá una opción, una de las dos cosas',
      );
    }
    if (!ambitoValido(dto.subjectType, dto.orderId)) {
      throw new BadRequestException(
        'Una conversación general no lleva pedido; una por pedido, sí',
      );
    }
    if (dto.firstAction && actor.party !== Party.CUSTOMER) {
      throw soloDelCliente();
    }
    const canal = actor.canales[0];
    let primer = dto.firstMessage;
    let opciones: OpcionesDelEnvio = {};
    if (canal === Channel.STAFF_CUSTOMER) {
      const ajustes = await this.ajustes.leer(actor.distributorId);
      if (!ajustes.customerChatEnabled) throw chatDeClientesApagado();
      if (dto.firstAction) {
        const accion = accionParaMandar(
          dto.firstAction.key,
          ajustes.customerActions,
        );
        primer = {
          clientMessageId: dto.firstAction.clientMessageId,
          body: accion.text,
        };
        opciones = { pedirPersona: accion.kind === 'handoff' };
      }
    }
    const destino = await this.dataSource.transaction((manager) =>
      this.destinoDeLaPersona(manager, actor, canal, dto, ahora),
    );
    return this.abrir(
      actor,
      destino,
      primer as MensajeEntrante,
      ahora,
      opciones,
    );
  }

  /** El personal abre (o sigue) una conversación con un cliente o un chofer. */
  async abrirDelPersonal(
    actor: ActorDeLaBandeja,
    dto: OpenStaffConversationDto,
    ahora: Date = new Date(),
  ): Promise<ConversacionAbierta> {
    this.acceso.assertAtiende(actor, dto.channel);
    if (!ambitoValido(dto.subjectType, dto.orderId)) {
      throw new BadRequestException(
        'Una conversación general no lleva pedido; una por pedido, sí',
      );
    }
    if (dto.channel === Channel.STAFF_CUSTOMER) {
      await this.assertClientesPrendido(actor);
    }
    const destino = await this.dataSource.transaction((manager) =>
      this.destinoDelPersonal(manager, actor, dto, ahora),
    );
    return this.abrir(actor, destino, dto.firstMessage, ahora);
  }

  /**
   * Los botones de acción que la empresa muestra en el chat (4e), para abrir
   * un chat nuevo. Sólo el cliente (chofer → 403); si la empresa no atiende
   * por chat, ninguno.
   */
  async acciones(actor: ActorDeLaBandeja): Promise<AccionDelCliente[]> {
    if (actor.party !== Party.CUSTOMER) throw soloDelCliente();
    const a = await this.ajustes.leer(actor.distributorId);
    return a.customerChatEnabled ? accionesHabilitadas(a.customerActions) : [];
  }

  /**
   * El cliente toca un botón de acción (4e): se manda el mensaje
   * predefinido como cualquier mensaje suyo (idempotente por
   * `clientMessageId`; lo atiende el asistente o el equipo). «Hablar con una
   * persona» además pasa la conversación a «esperando persona» (el asistente
   * no contesta). Chofer → 403; una acción que la empresa no muestra o que es
   * de la app → 400.
   */
  async accion(
    actor: ActorDeLaBandeja,
    conversationId: string,
    dto: SendCustomerActionDto,
    ahora: Date = new Date(),
  ): Promise<MensajeEscrito> {
    if (actor.party !== Party.CUSTOMER) throw soloDelCliente();
    const ajustes = await this.ajustes.leer(actor.distributorId);
    if (!ajustes.customerChatEnabled) throw chatDeClientesApagado();
    const accion = accionParaMandar(dto.key, ajustes.customerActions);
    return this.enviar(
      actor,
      conversationId,
      { clientMessageId: dto.clientMessageId, body: accion.text },
      ahora,
      { pedirPersona: accion.kind === 'handoff' },
    );
  }

  /** Escribir en una conversación abierta. */
  async enviar(
    actor: ActorDeLaBandeja,
    conversationId: string,
    dto: MensajeEntrante,
    ahora: Date = new Date(),
    opciones: OpcionesDelEnvio = {},
  ): Promise<MensajeEscrito> {
    const conversacion = await this.acceso.buscar(actor, conversationId);
    if (actor.party === Party.CUSTOMER)
      await this.assertClientesPrendido(actor);
    await this.vigente.assertSePuedeEscribir(conversacion);
    await this.cupos.mensaje({
      ambito: actor.distributorId,
      userId: actor.userId,
      clientMessageId: dto.clientMessageId,
      conversacion: esDelPersonal(actor)
        ? undefined
        : conversacion.conversationId,
    });
    const efectos = new Efectos();
    const escrito = await this.dataSource.transaction((manager) =>
      this.escribirDentro(
        manager,
        actor,
        conversacion,
        dto,
        efectos,
        ahora,
        opciones,
      ),
    );
    this.eventos.publicar(efectos);
    return escrito;
  }

  /**
   * Editar el texto de un mensaje propio (D-C22): del autor (no de su
   * equipo), texto, hasta 15 minutos después y con la conversación abierta.
   * El texto anterior queda en `message_edit` (auditado sin el texto, D-C11).
   */
  async editar(
    actor: ActorDeLaBandeja,
    conversationId: string,
    messageId: string,
    body: string,
    ahora: Date = new Date(),
  ): Promise<Message> {
    if (actor.party === Party.CUSTOMER)
      await this.assertClientesPrendido(actor);
    await this.vigente.assertSePuedeEscribir(
      await this.acceso.buscar(actor, conversationId),
    );
    const efectos = new Efectos();
    const editado = await this.dataSource.transaction(async (manager) => {
      const c = await this.acceso.buscar(actor, conversationId, manager, {
        bloquear: true,
      });
      const repo = manager.getRepository(Message);
      const m = await repo.findOne({
        where: { messageId, conversationId: c.conversationId },
      });
      if (!m) throw noExisteElMensaje();
      if (m.senderUserId !== actor.userId) throw mensajeAjeno();
      if (c.status !== ConversationStatus.OPEN) {
        throw new ConversacionCerradaError();
      }
      assertSePuedeEditar(
        { ...m, ...(await this.ataduras(manager, c, m)) },
        ahora,
      );
      if (m.body === body) return m;
      await manager.getRepository(MessageEdit).insert({
        messageId: m.messageId,
        distributorId: m.distributorId,
        previousBody: m.body,
        editedByUserId: actor.userId,
      });
      m.body = body;
      m.editedAt = ahora;
      await repo.update({ messageId: m.messageId }, { body, editedAt: ahora });
      await recalcularVistaPrevia(manager, c.conversationId);
      efectos.edicion(c, m);
      return m;
    });
    this.eventos.publicar(efectos);
    return editado;
  }

  /**
   * Borrar un mensaje propio (D-C23): sólo el cliente, en C3, su texto, hasta
   * 15 minutos después y si no quedó atado a un pedido, un reclamo, un ticket
   * o una respuesta que lo cita. Lógico: queda en su lugar sin texto para
   * nadie (tampoco para la empresa). Borrar otra vez devuelve lo mismo.
   */
  async borrar(
    actor: ActorDeLaBandeja,
    conversationId: string,
    messageId: string,
    ahora: Date = new Date(),
  ): Promise<Message> {
    if (actor.party !== Party.CUSTOMER) throw borradoNoPermitido();
    await this.assertClientesPrendido(actor);
    const efectos = new Efectos();
    const borrado = await this.dataSource.transaction(async (manager) => {
      const c = await this.acceso.buscar(actor, conversationId, manager, {
        bloquear: true,
      });
      const repo = manager.getRepository(Message);
      const m = await repo.findOne({
        where: { messageId, conversationId: c.conversationId },
      });
      if (!m) throw noExisteElMensaje();
      if (m.senderUserId !== actor.userId) throw mensajeAjeno();
      if (m.withdrawnAt) return m;
      assertSePuedeBorrar(
        {
          kind: m.kind,
          createdAt: m.createdAt,
          redactedAt: m.redactedAt,
          ...(await this.ataduras(manager, c, m)),
        },
        ahora,
      );
      if (c.status !== ConversationStatus.OPEN) {
        throw new ConversacionCerradaError();
      }
      await repo.update(
        { messageId: m.messageId },
        { withdrawnAt: ahora, withdrawnByUserId: actor.userId },
      );
      m.withdrawnAt = ahora;
      m.withdrawnByUserId = actor.userId;
      await recalcularVistaPrevia(manager, c.conversationId);
      efectos.borrado(c, m);
      return m;
    });
    this.eventos.publicar(efectos);
    return borrado;
  }

  async conversacion(
    actor: ActorDeLaBandeja,
    conversationId: string,
  ): Promise<Conversation> {
    return this.acceso.buscar(actor, conversationId);
  }

  async mensajes(
    actor: ActorDeLaBandeja,
    conversationId: string,
    query: MessagesQueryDto,
  ): Promise<{ items: Message[]; hasMore: boolean }> {
    const c = await this.acceso.buscar(actor, conversationId);
    return this.hilos.mensajes(c, lectorDe(actor), query);
  }

  async leer(
    actor: ActorDeLaBandeja,
    conversationId: string,
    seq: number,
  ): Promise<void> {
    const c = await this.acceso.buscar(actor, conversationId);
    await this.hilos.leer(c, lectorDe(actor), seq);
    // Leer hasta una nota es haberla visto: sus menciones a quien lee, leídas.
    if (esDelPersonal(actor)) {
      await marcarMencionesLeidas(
        this.dataSource,
        c.conversationId,
        actor.userId,
        actor.distributorId,
        seq,
      );
    }
  }

  private async assertClientesPrendido(actor: ActorDeLaBandeja): Promise<void> {
    const a = await this.ajustes.leer(actor.distributorId);
    if (!a.customerChatEnabled) throw chatDeClientesApagado();
  }

  /**
   * A qué quedó atado el mensaje (D-C22, D-C23): conversación por pedido,
   * anterior al reclamo creado desde el hilo o citado en un ticket, o citado
   * en una respuesta.
   */
  private async ataduras(
    manager: EntityManager,
    c: Conversation,
    m: Message,
  ): Promise<AtadurasDelMensaje> {
    const [fila]: Array<{ reclamo: boolean; citado: boolean }> =
      await manager.query(
        `SELECT (EXISTS (SELECT 1 FROM "claims" cl
                          WHERE cl."claim_id" = $3 AND cl."createdAt" >= $4)
                 OR EXISTS (SELECT 1 FROM "support_ticket_message_link" l
                             WHERE l."message_id" = $1)) AS reclamo,
                EXISTS (SELECT 1 FROM "message" r
                         WHERE r."conversation_id" = $2 AND r."reply_to_seq" = $5) AS citado`,
        [m.messageId, c.conversationId, c.linkedClaimId, m.createdAt, m.seq],
      );
    return {
      deUnPedido: c.subjectType === SubjectType.ORDER,
      enUnReclamo: fila?.reclamo ?? false,
      citado: fila?.citado ?? false,
    };
  }

  /**
   * Busca la abierta del mismo tema o crea una, y escribe el primer mensaje.
   * Un «buscar o crear» a la vez por tema (cerrojo de la transacción): dos
   * primeros mensajes simultáneos no abren dos conversaciones. El mismo
   * `clientMessageId` repetido devuelve el mensaje ya escrito.
   */
  private async abrir(
    actor: ActorDeLaBandeja,
    destino: DestinoDeLaBandeja,
    primer: MensajeEntrante,
    ahora: Date,
    opciones: OpcionesDelEnvio = {},
  ): Promise<ConversacionAbierta> {
    if (esDelPersonal(actor)) {
      await this.cupos.mensaje({
        ambito: actor.distributorId,
        userId: actor.userId,
        clientMessageId: primer.clientMessageId,
      });
    }
    const efectos = new Efectos();
    const r = await this.dataSource.transaction(async (manager) => {
      const previo = await this.yaEscrito(manager, actor, destino, primer);
      if (previo) return { ...previo, conversationCreated: false };
      await bloquearElTema(manager, actor.distributorId, destino);
      let c = await this.abiertaDelTema(manager, actor.distributorId, destino);
      let creada = false;
      if (!c) {
        c = await this.fabrica.crear(manager, {
          distributorId: actor.distributorId,
          channel: destino.channel,
          subject: null,
          createdByUserId: actor.userId,
          subjectType: destino.subjectType,
          orderId: destino.orderId,
          customerUserId: destino.customerUserId,
          driverUserId: destino.driverUserId,
        });
        creada = true;
        efectos.conversacion(c, 'created');
      }
      // El cliente y el chofer, además, con el cupo de ESA conversación (la
      // misma clave que al escribir en ella después). Si se pasa, la
      // conversación recién creada vuelve atrás con la transacción.
      if (!esDelPersonal(actor)) {
        await this.cupos.mensaje({
          ambito: actor.distributorId,
          userId: actor.userId,
          clientMessageId: primer.clientMessageId,
          conversacion: c.conversationId,
        });
      }
      const escrito = await this.escribirDentro(
        manager,
        actor,
        c,
        primer,
        efectos,
        ahora,
        opciones,
      );
      return { ...escrito, conversationCreated: creada };
    });
    this.eventos.publicar(efectos);
    return r;
  }

  /** Escribe un mensaje de quien manda y lo que dispara (primera respuesta, respuesta automática). */
  private async escribirDentro(
    manager: EntityManager,
    actor: ActorDeLaBandeja,
    c: Conversation,
    dto: MensajeEntrante,
    efectos: Efectos,
    ahora: Date,
    opciones: OpcionesDelEnvio = {},
  ): Promise<MensajeEscrito> {
    const { body, templateKey } = await this.textoDelMensaje(
      manager,
      actor,
      c,
      dto,
      ahora,
    );
    const r = await this.writer.escribir(manager, {
      conversationId: c.conversationId,
      distributorId: c.distributorId,
      senderParty: actor.party,
      senderUserId: actor.userId,
      clientMessageId: dto.clientMessageId,
      kind: MessageKind.TEXT,
      visibility: MessageVisibility.ALL,
      body,
      payload: null,
      systemCode: null,
      templateKey,
      replyToSeq: dto.replyToSeq ?? null,
    });
    if (!r.created) return r;
    efectos.mensaje(r.conversation, r.message);
    if (actor.party === Party.COMPANY) {
      await this.registrarPrimeraRespuesta(manager, r.conversation);
      await dejaDeEsperarPersona(manager, r.conversation);
    } else if (actor.party === Party.CUSTOMER) {
      if (opciones.pedirPersona) {
        await pedirUnaPersona(manager, r.conversation, efectos, ahora);
      }
      await this.responderAutomaticamente(
        manager,
        r.conversation,
        r.message,
        efectos,
        ahora,
      );
    }
    return r;
  }

  /** El texto: el escrito o la respuesta guardada completada con sus variables. */
  private async textoDelMensaje(
    manager: EntityManager,
    actor: ActorDeLaBandeja,
    c: Conversation,
    dto: MensajeEntrante,
    ahora: Date,
  ): Promise<{ body: string; templateKey: string | null }> {
    const templateId = 'templateId' in dto ? dto.templateId : undefined;
    if (templateId === undefined) {
      if (dto.body === undefined) {
        throw new BadRequestException(
          'Escribí el mensaje o elegí una respuesta guardada',
        );
      }
      return { body: dto.body, templateKey: null };
    }
    if (dto.body !== undefined || !esDelPersonal(actor)) {
      throw new BadRequestException(
        'Escribí el mensaje o elegí una respuesta guardada, no las dos',
      );
    }
    const plantilla = await this.plantillas.paraEnviar(
      manager,
      actor.distributorId,
      templateId,
      c.channel,
    );
    const ajustes = await this.ajustes.leer(c.distributorId, manager);
    const body = completarPlantilla(
      plantilla.body,
      await valoresDePlantilla(manager, c, ajustes, ahora),
    );
    if (body.length === 0) {
      throw new BadRequestException(
        'La respuesta guardada quedó vacía en esta conversación',
      );
    }
    return { body: body.slice(0, 2000), templateKey: plantilla.key };
  }

  /**
   * La primera respuesta de la empresa: su primer mensaje después del primero
   * del cliente o del chofer (si la empresa abrió la conversación, la
   * respuesta cuenta desde que la persona escribió).
   */
  private async registrarPrimeraRespuesta(
    manager: EntityManager,
    c: Conversation,
  ): Promise<void> {
    await manager.query(
      `UPDATE "conversation" SET "first_response_at" = now()
        WHERE "conversation_id" = $1 AND "first_response_at" IS NULL
          AND EXISTS (SELECT 1 FROM "message" WHERE "conversation_id" = $1
                         AND "sender_party" IN ('customer', 'driver'))`,
      [c.conversationId],
    );
  }

  /**
   * Respuesta automática al mensaje del cliente (§8.4, D-C29): la de la IA
   * si el asistente con IA se encarga de este mensaje (corre después del
   * commit y reemplaza a las fijas); si no, las fijas de siempre (fuera de
   * horario, aviso de recibido). La conversación está bloqueada por el envío.
   */
  private async responderAutomaticamente(
    manager: EntityManager,
    c: Conversation,
    m: Message,
    efectos: Efectos,
    ahora: Date,
  ): Promise<void> {
    if (await this.asistente.seEncarga(manager, c, m, ahora)) return;
    await this.fijas.deLaEmpresa(manager, c, efectos, ahora);
  }

  /** El mensaje de ese autor con ese `clientMessageId` en alguna conversación del mismo canal de la empresa. */
  private async yaEscrito(
    manager: EntityManager,
    actor: ActorDeLaBandeja,
    destino: DestinoDeLaBandeja,
    primer: MensajeEntrante,
  ): Promise<MensajeEscrito | null> {
    const message = await manager
      .getRepository(Message)
      .createQueryBuilder('m')
      .innerJoin(Conversation, 'c', 'c.conversationId = m.conversationId')
      .where('m.distributorId = :distributorId', {
        distributorId: actor.distributorId,
      })
      .andWhere('c.channel = :canal', { canal: destino.channel })
      .andWhere('m.senderUserId = :userId', { userId: actor.userId })
      .andWhere('m.clientMessageId = :cmid', { cmid: primer.clientMessageId })
      .getOne();
    if (!message) return null;
    const conversation = await manager
      .getRepository(Conversation)
      .findOneByOrFail({ conversationId: message.conversationId });
    return { message, created: false, conversation };
  }

  private abiertaDelTema(
    manager: EntityManager,
    distributorId: string,
    d: DestinoDeLaBandeja,
  ): Promise<Conversation | null> {
    return manager.getRepository(Conversation).findOne({
      where: {
        distributorId,
        channel: d.channel,
        status: ConversationStatus.OPEN,
        subjectType: d.subjectType,
        ...(d.subjectType === SubjectType.ORDER
          ? {
              orderId: d.orderId as string,
              // C2 por pedido: la del pedido Y del chofer (si el pedido pasa
              // a otro, el nuevo tiene la suya).
              ...(d.channel === Channel.STAFF_DRIVER
                ? { driverUserId: d.driverUserId as string }
                : {}),
            }
          : d.channel === Channel.STAFF_CUSTOMER
            ? { customerUserId: d.customerUserId as string }
            : { driverUserId: d.driverUserId as string }),
      },
    });
  }

  private async destinoDeLaPersona(
    manager: EntityManager,
    actor: ActorDeLaBandeja,
    canal: CanalDeLaBandeja,
    dto: OpenMyConversationDto,
    ahora: Date,
  ): Promise<DestinoDeLaBandeja> {
    const base = {
      channel: canal,
      subjectType: dto.subjectType,
      orderId: null,
      customerUserId: canal === Channel.STAFF_CUSTOMER ? actor.userId : null,
      driverUserId: canal === Channel.STAFF_DRIVER ? actor.userId : null,
    };
    if (dto.subjectType === SubjectType.GENERAL) {
      const relacionado =
        canal === Channel.STAFF_CUSTOMER
          ? await clienteDeLaEmpresa(manager, actor.userId, actor.distributorId)
          : await choferDeLaEmpresa(manager, actor.userId, actor.distributorId);
      if (!relacionado) throw sinRelacionConLaEmpresa();
      return base;
    }
    const pedido = await pedidoDeLaEmpresa(
      manager,
      dto.orderId as string,
      actor.distributorId,
    );
    const suyo =
      canal === Channel.STAFF_CUSTOMER
        ? pedido?.customerId === actor.userId
        : pedido?.driverUserId === actor.userId;
    if (!pedido || !suyo) throw noExisteElPedido();
    assertSePuedeConsultarPorElPedido(pedido, ahora);
    return { ...base, orderId: pedido.orderId };
  }

  private async destinoDelPersonal(
    manager: EntityManager,
    actor: ActorDeLaBandeja,
    dto: OpenStaffConversationDto,
    ahora: Date,
  ): Promise<DestinoDeLaBandeja> {
    const clientes = dto.channel === Channel.STAFF_CUSTOMER;
    if (clientes ? dto.driverId : dto.customerId) {
      throw new BadRequestException(
        clientes
          ? 'Una conversación con un cliente no lleva chofer'
          : 'Una conversación con un chofer no lleva cliente',
      );
    }
    const base = {
      channel: dto.channel,
      subjectType: dto.subjectType,
      orderId: null,
      customerUserId: null,
      driverUserId: null,
    };
    if (dto.subjectType === SubjectType.GENERAL) {
      const persona = clientes ? dto.customerId : dto.driverId;
      if (!persona) {
        throw new BadRequestException(
          clientes ? 'Elegí el cliente' : 'Elegí el chofer',
        );
      }
      if (clientes) {
        if (
          !(await clienteDeLaEmpresa(manager, persona, actor.distributorId))
        ) {
          throw noExisteElCliente();
        }
        return { ...base, customerUserId: persona };
      }
      if (!(await choferDeLaEmpresa(manager, persona, actor.distributorId))) {
        throw noExisteElChofer();
      }
      return { ...base, driverUserId: persona };
    }
    const pedido = await pedidoDeLaEmpresa(
      manager,
      dto.orderId as string,
      actor.distributorId,
    );
    if (!pedido) throw noExisteElPedido();
    assertSePuedeConsultarPorElPedido(pedido, ahora);
    if (clientes) {
      if (dto.customerId && dto.customerId !== pedido.customerId) {
        throw new BadRequestException('El pedido no es de ese cliente');
      }
      return {
        ...base,
        orderId: pedido.orderId,
        customerUserId: pedido.customerId,
      };
    }
    if (!pedido.driverUserId) throw new PedidoSinChoferError();
    if (dto.driverId && dto.driverId !== pedido.driverUserId) {
      throw new BadRequestException('El pedido no lo lleva ese chofer');
    }
    return {
      ...base,
      orderId: pedido.orderId,
      driverUserId: pedido.driverUserId,
    };
  }
}

/** La clave del tema: una conversación abierta por persona (general) o por pedido. */
export function claveDelTema(d: DestinoDeLaBandeja): string {
  return d.subjectType === SubjectType.ORDER
    ? `${d.channel}:order:${d.orderId}:${d.driverUserId ?? 'cliente'}`
    : `${d.channel}:general:${d.customerUserId ?? d.driverUserId}`;
}

/** Cerrojo de la transacción por empresa y tema. */
export async function bloquearElTema(
  manager: EntityManager,
  distributorId: string,
  d: DestinoDeLaBandeja,
): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `bandeja:${distributorId}:${claveDelTema(d)}`,
  ]);
}

/** El pedido de la empresa con su cliente, su chofer y cuándo terminó. */
async function pedidoDeLaEmpresa(
  manager: EntityManager,
  orderId: string,
  distributorId: string,
): Promise<PedidoDeLaEmpresa | null> {
  const filas: Array<{
    order_id: string;
    status: string;
    customer_id: string;
    driver_user_id: string | null;
    terminado_en: Date | null;
  }> = await manager.query(
    `SELECT o."order_id", o."status"::text AS status, o."customer_id",
            d."user_id" AS driver_user_id,
            CASE o."status"
              WHEN 'delivered' THEN o."deliveredAt"
              WHEN 'cancelled' THEN COALESCE(
                (SELECT max(h."changed_at") FROM "order_status_history" h
                  WHERE h."order_id" = o."order_id" AND h."to_status" = 'cancelled'),
                o."updatedAt")
            END AS terminado_en
       FROM "order" o
       LEFT JOIN "delivery" d ON d."delivery_id" = o."delivery_id"
      WHERE o."order_id" = $1 AND o."distributor_id" = $2`,
    [orderId, distributorId],
  );
  const f = filas[0];
  if (!f) return null;
  return {
    orderId: f.order_id,
    status: f.status,
    customerId: f.customer_id,
    driverUserId: f.driver_user_id,
    terminadoEn: f.terminado_en ? new Date(f.terminado_en) : null,
  };
}

/**
 * La vista previa de la bandeja sale del último mensaje con texto visible: al
 * editar o borrar, el texto viejo no queda en la lista ni se encuentra con `q`.
 */
export async function recalcularVistaPrevia(
  manager: EntityManager,
  conversationId: string,
): Promise<void> {
  const [ultimo]: Array<{ body: string; visibility: MessageVisibility }> =
    await manager.query(
      `SELECT "body", "visibility" FROM "message"
        WHERE "conversation_id" = $1 AND "body" IS NOT NULL AND "visibility" = 'all'
          AND "withdrawn_at" IS NULL AND "redacted_at" IS NULL AND "deleted_at" IS NULL
        ORDER BY "seq" DESC LIMIT 1`,
      [conversationId],
    );
  await manager.query(
    `UPDATE "conversation" SET "last_message_preview" = $2 WHERE "conversation_id" = $1`,
    [
      conversationId,
      ultimo ? vistaPrevia(ultimo.body, ultimo.visibility) : null,
    ],
  );
}
