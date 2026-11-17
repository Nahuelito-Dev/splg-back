import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { StaffPermissionsService } from '../../admin/staff-permissions.service';
import { ClaimsService } from '../../claims/claims.service';
import { Claim } from '../../claims/entities/claim.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import { atiendeElCanal, type CanalDeLaBandeja } from '../domain/bandeja';
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
  AsignadoSinPermisoError,
  ConversacionCerradaError,
  ConversacionConReclamoError,
  ConversacionNoReabribleError,
} from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import { BandejaReadModel } from '../infrastructure/bandeja-read-model';
import type {
  BroadcastDriversDto,
  CreateClaimFromConversationDto,
  QueryInboxDto,
  QueryMyConversationsDto,
} from '../presentation/dto/bandeja-input.dto';
import { type ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import {
  anularEncuestasPendientes,
  BandejaEncuestaService,
} from './bandeja-encuesta.service';
import {
  choferesAjenos,
  noExisteLaPersonaDelPersonal,
  sinPermiso,
} from './bandeja.errors';
import { bloquearElTema, type DestinoDeLaBandeja } from './bandeja.service';
import { ChatEvents, Efectos } from './chat.events';
import { filtrarPorEspera, primeroLasQueEsperan } from './cola-de-espera';
import { ChatRateLimit } from './chat-rate-limit';
import { ConversationFactory } from './conversation-factory';
import { MessageWriter } from './message-writer';

const UNICO_VIOLADO = '23505';

export interface ConteosDeLaBandeja {
  unassigned: number;
  mine: number;
  open: number;
}

/**
 * La gestión de la bandeja del lado de la empresa (§4.3, §4.4, §14.3):
 * listar con filtros (sólo los canales que atiende quien pide), asignar,
 * cerrar, reabrir, crear un reclamo desde el hilo y el mensaje a varios
 * choferes. Y la lista de «mis conversaciones» del cliente y el chofer.
 */
@Injectable()
export class BandejaGestionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly acceso: BandejaAcceso,
    private readonly lectura: BandejaReadModel,
    private readonly permisos: StaffPermissionsService,
    private readonly writer: MessageWriter,
    private readonly fabrica: ConversationFactory,
    private readonly claims: ClaimsService,
    private readonly cupos: ChatRateLimit,
    private readonly eventos: ChatEvents,
    private readonly encuesta: BandejaEncuestaService,
  ) {}

  /** La bandeja del personal: sólo los canales que atiende (uno que no atiende → 403). */
  async listar(
    actor: ActorDeLaBandeja,
    query: QueryInboxDto,
  ): Promise<{
    items: Conversation[];
    total: number;
    counts: ConteosDeLaBandeja;
  }> {
    if (query.channel) this.acceso.assertAtiende(actor, query.channel);
    const canales = query.channel ? [query.channel] : [...actor.canales];
    const qb = this.dataSource
      .getRepository(Conversation)
      .createQueryBuilder('c')
      .where('c.distributorId = :distributorId', {
        distributorId: actor.distributorId,
      })
      .andWhere('c.channel IN (:...canales)', { canales });
    if (query.status)
      qb.andWhere('c.status = :status', { status: query.status });
    if (query.assigned === 'me') {
      qb.andWhere('c.assignedToUserId = :yo', { yo: actor.userId });
    } else if (query.assigned === 'none') {
      qb.andWhere('c.assignedToUserId IS NULL');
    } else if (query.assigned) {
      qb.andWhere('c.assignedToUserId = :asignado', {
        asignado: query.assigned,
      });
    }
    if (query.customerId) {
      qb.andWhere('c.customerUserId = :cliente', { cliente: query.customerId });
    }
    if (query.driverId) {
      qb.andWhere('c.driverUserId = :chofer', { chofer: query.driverId });
    }
    if (query.orderId) {
      qb.andWhere('c.orderId = :pedido', { pedido: query.orderId });
    }
    if (query.updatedSince) {
      qb.andWhere('c.updatedAt > :desde', { desde: query.updatedSince });
    }
    if (query.q) {
      qb.andWhere(
        `(c.lastMessagePreview ILIKE :q OR EXISTS (
            SELECT 1 FROM "user" u
             WHERE u."user_id" = COALESCE(c.customer_user_id, c.driver_user_id)
               AND u."full_name" ILIKE :q))`,
        { q: `%${escaparLike(query.q)}%` },
      );
    }
    if (query.mentioned) {
      // «Me mencionaron»: notas de esta empresa que mencionan a quien pide.
      qb.andWhere(
        `EXISTS (SELECT 1 FROM "message_mention" mm
                  WHERE mm."conversation_id" = c.conversation_id
                    AND mm."distributor_id" = :distributorId
                    AND mm."mentioned_user_id" = :mencionado
                    ${query.mentioned === 'unread' ? 'AND mm."read_at" IS NULL' : ''})`,
        { mencionado: actor.userId },
      );
    }
    if (query.labelId) {
      // Por etiqueta (7c): vigente, de esta empresa y puesta en la conversación.
      qb.andWhere(
        `EXISTS (SELECT 1 FROM "conversation_label_link" k
                   JOIN "conversation_label" l ON l."label_id" = k."label_id"
                                              AND l."distributor_id" = k."distributor_id"
                  WHERE k."conversation_id" = c.conversation_id
                    AND k."distributor_id" = :distributorId
                    AND k."label_id" = :etiqueta
                    AND k."deleted_at" IS NULL AND l."deleted_at" IS NULL)`,
        { etiqueta: query.labelId },
      );
    }
    filtrarPorEspera(qb, query.awaiting);
    primeroLasQueEsperan(qb, query.assigned === 'none');
    const [items, total] = await qb
      .addOrderBy('c.lastMessageAt', 'DESC', 'NULLS LAST')
      .addOrderBy('c.createdAt', 'DESC')
      .addOrderBy('c.conversationId', 'ASC')
      .take(query.limit)
      .skip(query.offset)
      .getManyAndCount();
    const [fila]: Array<Record<string, string>> = await this.dataSource.query(
      `SELECT count(*) FILTER (WHERE "assigned_to_user_id" IS NULL) AS unassigned,
              count(*) FILTER (WHERE "assigned_to_user_id" = $3) AS mine,
              count(*) AS open
         FROM "conversation"
        WHERE "distributor_id" = $1 AND "channel" = ANY($2::text[])
          AND "status" = 'open' AND "deleted_at" IS NULL`,
      [actor.distributorId, canales, actor.userId],
    );
    return {
      items,
      total,
      counts: {
        unassigned: Number(fila?.unassigned ?? 0),
        mine: Number(fila?.mine ?? 0),
        open: Number(fila?.open ?? 0),
      },
    };
  }

  /** Las conversaciones del cliente o del chofer con la empresa de la request. */
  async misConversaciones(
    actor: ActorDeLaBandeja,
    query: QueryMyConversationsDto,
  ): Promise<{ items: Conversation[]; total: number }> {
    const qb = this.dataSource
      .getRepository(Conversation)
      .createQueryBuilder('c')
      .where('c.distributorId = :distributorId', {
        distributorId: actor.distributorId,
      })
      .andWhere('c.channel = :canal', { canal: actor.canales[0] })
      .andWhere(
        actor.party === Party.CUSTOMER
          ? 'c.customerUserId = :yo'
          : 'c.driverUserId = :yo',
        { yo: actor.userId },
      );
    if (query.status)
      qb.andWhere('c.status = :status', { status: query.status });
    if (query.updatedSince) {
      qb.andWhere('c.updatedAt > :desde', { desde: query.updatedSince });
    }
    const [items, total] = await qb
      .orderBy('c.lastMessageAt', 'DESC', 'NULLS LAST')
      .addOrderBy('c.createdAt', 'DESC')
      .addOrderBy('c.conversationId', 'ASC')
      .take(query.limit)
      .skip(query.offset)
      .getManyAndCount();
    return { items, total };
  }

  /**
   * Asignar a alguien del personal de ESTA empresa que atienda el canal
   * (alguien de otra empresa no existe: 404; uno sin el permiso: 400), o
   * devolverla a la cola (`null`).
   */
  async asignar(
    actor: ActorDeLaBandeja,
    conversationId: string,
    userId: string | null,
  ): Promise<Conversation> {
    const efectos = new Efectos();
    const c = await this.dataSource.transaction(async (manager) => {
      const c = await this.acceso.buscar(actor, conversationId, manager, {
        bloquear: true,
      });
      if (c.status !== ConversationStatus.OPEN) {
        throw new ConversacionCerradaError();
      }
      if (userId !== null) {
        await this.assertPuedeAtender(
          userId,
          actor.distributorId,
          c.channel as CanalDeLaBandeja,
        );
      }
      return this.asignarDentro(manager, c, userId, efectos);
    });
    this.eventos.publicar(efectos);
    return c;
  }

  /**
   * El paso común de la asignación a mano y la automática (8b), dentro de la
   * transacción de quien llama, con la conversación abierta, bloqueada y la
   * persona ya validada: queda asignada (o en la cola), deja de esperar a una
   * persona y sale el mismo aviso (`assigned`). La automática queda marcada
   * (`assignedAutomatically`); una a mano o devolverla a la cola la desmarca.
   */
  async asignarDentro(
    manager: EntityManager,
    c: Conversation,
    userId: string | null,
    efectos: Efectos,
    automatica = false,
  ): Promise<Conversation> {
    if (c.assignedToUserId === userId) return c;
    const anterior = c.assignedToUserId;
    c.assignedToUserId = userId;
    c.assignedAutomatically = automatica && userId !== null;
    // Alguien la tomó: deja de esperar a una persona (y su motivo).
    if (userId !== null) {
      c.awaitingHumanSince = null;
      c.awaitingHumanReason = null;
    }
    const guardada = await manager.getRepository(Conversation).save(c);
    efectos.conversacion(guardada, 'assigned', anterior);
    return guardada;
  }

  /**
   * Cerrar a mano. Queda en lectura; un mensaje nuevo abre otra (o se
   * reabre). Con un cliente, sale la encuesta de satisfacción (4b) si la
   * empresa la tiene prendida.
   */
  async cerrar(
    actor: ActorDeLaBandeja,
    conversationId: string,
    ahora: Date = new Date(),
  ): Promise<Conversation> {
    const efectos = new Efectos();
    const c = await this.dataSource.transaction(async (manager) => {
      const c = await this.acceso.buscar(actor, conversationId, manager, {
        bloquear: true,
      });
      if (c.status !== ConversationStatus.OPEN) {
        throw new ConversacionCerradaError();
      }
      return this.cerrarDentro(
        manager,
        c,
        ConversationClosedReason.MANUAL,
        actor.userId,
        efectos,
        ahora,
      );
    });
    this.eventos.publicar(efectos);
    return c;
  }

  /**
   * El cierre, dentro de la transacción de quien llama y con la conversación
   * abierta y bloqueada: el mensaje de sistema del motivo, la encuesta (4b,
   * con un cliente y si la empresa la tiene prendida) y el estado. A mano
   * (`manual`, con quién) o por inactividad (`inactivity`, sin persona).
   */
  async cerrarDentro(
    manager: EntityManager,
    c: Conversation,
    motivo:
      | ConversationClosedReason.MANUAL
      | ConversationClosedReason.INACTIVITY,
    userId: string | null,
    efectos: Efectos,
    ahora: Date,
  ): Promise<Conversation> {
    const r = await this.writer.escribir(
      manager,
      deSistema(
        c,
        motivo === ConversationClosedReason.INACTIVITY
          ? SystemCode.CLOSED_INACTIVITY
          : SystemCode.CLOSED_MANUAL,
      ),
    );
    efectos.mensaje(r.conversation, r.message);
    // Con un cliente, la encuesta de satisfacción de este cierre (4b).
    await this.encuesta.pedirAlCerrar(manager, r.conversation, efectos, ahora);
    const repo = manager.getRepository(Conversation);
    const actual = await repo.findOneByOrFail({
      conversationId: c.conversationId,
    });
    actual.status = ConversationStatus.CLOSED;
    actual.closedAt = ahora;
    actual.closedReason = motivo;
    actual.closedByUserId = userId;
    // Cerrada, ya no espera a una persona (el asistente con IA la había derivado).
    actual.awaitingHumanSince = null;
    const cerrada = await repo.save(actual);
    efectos.conversacion(cerrada, 'closed');
    return cerrada;
  }

  /**
   * Volver a abrir una cerrada. 409 si ya hay otra abierta del mismo tema (la
   * general de esa persona o la de ese pedido). Una abierta queda igual (200).
   */
  async reabrir(
    actor: ActorDeLaBandeja,
    conversationId: string,
  ): Promise<Conversation> {
    const efectos = new Efectos();
    const c = await this.dataSource.transaction(async (manager) => {
      const c = await this.acceso.buscar(actor, conversationId, manager, {
        bloquear: true,
      });
      if (c.status === ConversationStatus.OPEN) return c;
      await bloquearElTema(manager, c.distributorId, destinoDe(c));
      const repo = manager.getRepository(Conversation);
      c.status = ConversationStatus.OPEN;
      c.closedAt = null;
      c.closedReason = null;
      c.closedByUserId = null;
      // Reabierta por alguien del equipo: no arrastra una espera vieja.
      c.awaitingHumanSince = null;
      let abierta: Conversation;
      try {
        abierta = await repo.save(c);
      } catch (error) {
        if (codigoSqlDelError(error) === UNICO_VIOLADO) {
          throw new ConversacionNoReabribleError();
        }
        throw error;
      }
      // La encuesta pendiente de ese cierre ya no se responde (4b).
      await anularEncuestasPendientes(
        manager,
        abierta.conversationId,
        abierta.distributorId,
        new Date(),
      );
      const r = await this.writer.escribir(
        manager,
        deSistema(abierta, SystemCode.REOPENED),
      );
      efectos.mensaje(r.conversation, r.message);
      efectos.conversacion(r.conversation, 'reopened');
      return r.conversation;
    });
    this.eventos.publicar(efectos);
    return c;
  }

  /**
   * Crear un reclamo desde una conversación con un cliente (§4.3), en UNA
   * transacción con la conversación: el reclamo (servicio de reclamos de
   * siempre, que sigue su propia máquina), el vínculo y el mensaje de sistema
   * se confirman juntos o nada; el aviso a los admins sale después del commit.
   * Uno por conversación: repetir lo mismo devuelve el ya creado (200); otro
   * distinto → 409. Pide además `reclamos.gestionar`.
   */
  async crearReclamo(
    actor: ActorDeLaBandeja,
    conversationId: string,
    dto: CreateClaimFromConversationDto,
  ): Promise<{
    claimId: string;
    conversation: Conversation;
    created: boolean;
  }> {
    if (!actor.permisos.includes('reclamos.gestionar')) {
      throw sinPermiso('reclamos.gestionar');
    }
    const efectos = new Efectos();
    let creado: Claim | null = null;
    const r = await this.dataSource.transaction(async (manager) => {
      const c = await this.acceso.buscar(actor, conversationId, manager, {
        bloquear: true,
        canales: [Channel.STAFF_CUSTOMER],
      });
      if (c.orderId && dto.orderId && dto.orderId !== c.orderId) {
        throw new BadRequestException(
          'La conversación es de otro pedido: el reclamo va por ése',
        );
      }
      const orderId = c.orderId ?? dto.orderId;
      if (c.linkedClaimId) {
        const previo = await manager
          .getRepository(Claim)
          .findOne({ where: { claimId: c.linkedClaimId } });
        const mismo =
          previo &&
          (!orderId || previo.orderId === orderId) &&
          previo.reason === dto.reason &&
          previo.description === dto.description;
        if (!mismo) throw new ConversacionConReclamoError();
        return { claimId: c.linkedClaimId, conversation: c, created: false };
      }
      if (c.status !== ConversationStatus.OPEN) {
        throw new ConversacionCerradaError();
      }
      if (!orderId) {
        throw new BadRequestException('Elegí el pedido del reclamo');
      }
      // Valida que el pedido sea de la empresa y de ese cliente.
      const claim = await this.claims.crearDentro(
        manager,
        {
          orderId,
          customerId: c.customerUserId as string,
          reason: dto.reason,
          description: dto.description,
        },
        actor.distributorId,
      );
      await manager.query(
        `UPDATE "conversation" SET "linked_claim_id" = $2, "updated_at" = now() WHERE "conversation_id" = $1`,
        [c.conversationId, claim.claimId],
      );
      const escrito = await this.writer.escribir(manager, {
        ...deSistema(c, SystemCode.CLAIM_CREATED),
        payload: { claimId: claim.claimId },
      });
      efectos.mensaje(escrito.conversation, escrito.message);
      const vinculada = await manager
        .getRepository(Conversation)
        .findOneByOrFail({ conversationId: c.conversationId });
      efectos.conversacion(vinculada, 'status');
      creado = claim;
      return { claimId: claim.claimId, conversation: vinculada, created: true };
    });
    this.eventos.publicar(efectos);
    if (creado) this.claims.avisarCreado(creado);
    return r;
  }

  /**
   * Un mismo mensaje a varios choferes (§4.4): uno en la conversación general
   * de cada uno (la abierta o una nueva), en una sola transacción. Si alguno no
   * es de la empresa, 404 y no se manda a ninguno. Repetir el `clientBatchId`
   * no duplica: cada mensaje lleva un `clientMessageId` que sale del lote y del
   * chofer.
   */
  async difundir(
    actor: ActorDeLaBandeja,
    dto: BroadcastDriversDto,
  ): Promise<{ sent: number; conversationIds: string[] }> {
    this.acceso.assertAtiende(actor, Channel.STAFF_DRIVER);
    const validos: Array<{ user_id: string }> = await this.dataSource.query(
      `SELECT d."user_id" FROM "delivery" d JOIN "user" u ON u."user_id" = d."user_id"
        WHERE d."user_id" = ANY($1::uuid[]) AND d."distributor_id" = $2
          AND d."deletedAt" IS NULL AND u."deletedAt" IS NULL`,
      [dto.driverIds, actor.distributorId],
    );
    if (new Set(validos.map((v) => v.user_id)).size !== dto.driverIds.length) {
      throw choferesAjenos();
    }
    await this.cupos.mensaje({
      ambito: actor.distributorId,
      userId: actor.userId,
      clientMessageId: dto.clientBatchId,
    });
    const efectos = new Efectos();
    const r = await this.dataSource.transaction(async (manager) => {
      const porChofer = new Map<string, string>();
      let enviados = 0;
      // En orden fijo: dos envíos con choferes en común toman los cerrojos igual.
      for (const chofer of [...dto.driverIds].sort()) {
        const destino: DestinoDeLaBandeja = {
          channel: Channel.STAFF_DRIVER,
          subjectType: SubjectType.GENERAL,
          orderId: null,
          customerUserId: null,
          driverUserId: chofer,
        };
        await bloquearElTema(manager, actor.distributorId, destino);
        const c = await this.generalAbierta(manager, actor, destino, efectos);
        const escrito = await this.writer.escribir(manager, {
          conversationId: c.conversationId,
          distributorId: c.distributorId,
          senderParty: Party.COMPANY,
          senderUserId: actor.userId,
          clientMessageId: idDelMensajeDelLote(dto.clientBatchId, chofer),
          kind: MessageKind.TEXT,
          visibility: MessageVisibility.ALL,
          body: dto.body,
          payload: null,
          systemCode: null,
          templateKey: null,
        });
        if (escrito.created) {
          enviados += 1;
          efectos.mensaje(escrito.conversation, escrito.message);
        }
        porChofer.set(chofer, c.conversationId);
      }
      return {
        sent: enviados,
        conversationIds: dto.driverIds.map((d) => porChofer.get(d) as string),
      };
    });
    this.eventos.publicar(efectos);
    return r;
  }

  private async generalAbierta(
    manager: EntityManager,
    actor: ActorDeLaBandeja,
    d: DestinoDeLaBandeja,
    efectos: Efectos,
  ): Promise<Conversation> {
    const abierta = await manager.getRepository(Conversation).findOne({
      where: {
        distributorId: actor.distributorId,
        channel: d.channel,
        subjectType: SubjectType.GENERAL,
        status: ConversationStatus.OPEN,
        driverUserId: d.driverUserId as string,
      },
    });
    if (abierta) return abierta;
    const nueva = await this.fabrica.crear(manager, {
      distributorId: actor.distributorId,
      channel: d.channel,
      subject: null,
      createdByUserId: actor.userId,
      subjectType: SubjectType.GENERAL,
      driverUserId: d.driverUserId,
    });
    efectos.conversacion(nueva, 'created');
    return nueva;
  }

  private async assertPuedeAtender(
    userId: string,
    distributorId: string,
    canal: CanalDeLaBandeja,
  ): Promise<void> {
    if (!(await this.lectura.adminDeLaEmpresa(userId, distributorId))) {
      throw noExisteLaPersonaDelPersonal();
    }
    const { todos, permisos } = await this.permisos.deUsuario(
      userId,
      RoleType.ADMIN,
    );
    if (!atiendeElCanal({ todos, permisos: new Set(permisos) }, canal)) {
      throw new AsignadoSinPermisoError();
    }
  }
}

/** El tema de una conversación existente (para el cerrojo al reabrir). */
function destinoDe(c: Conversation): DestinoDeLaBandeja {
  return {
    channel: c.channel as CanalDeLaBandeja,
    subjectType:
      c.subjectType === SubjectType.ORDER
        ? SubjectType.ORDER
        : SubjectType.GENERAL,
    orderId: c.orderId,
    customerUserId: c.customerUserId,
    driverUserId: c.driverUserId,
  };
}

function deSistema(c: Conversation, codigo: SystemCode) {
  return {
    conversationId: c.conversationId,
    distributorId: c.distributorId,
    senderParty: Party.SYSTEM,
    senderUserId: null,
    clientMessageId: null,
    kind: MessageKind.SYSTEM,
    visibility: MessageVisibility.ALL,
    body: null,
    payload: null,
    systemCode: codigo,
    templateKey: null,
  };
}

/**
 * La versión del uuid de los mensajes de un lote (`idDelMensajeDelLote`). Los
 * `clientMessageId` que mandan el panel y las apps son uuid v4 (lo exige el
 * DTO): así se reconoce un mensaje masivo a choferes en la base, por ejemplo
 * para que no arranque el cierre por inactividad.
 */
export const VERSION_DEL_ID_DEL_LOTE = '5';

/**
 * El `clientMessageId` de cada mensaje de un lote: un uuid que sale del lote y
 * del chofer (sha-256 con la forma de un uuid), así el mismo lote repetido no
 * duplica.
 */
export function idDelMensajeDelLote(lote: string, chofer: string): string {
  const h = createHash('sha256').update(`${lote}:${chofer}`).digest('hex');
  const variante = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${VERSION_DEL_ID_DEL_LOTE}${h.slice(13, 16)}-${variante}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}
