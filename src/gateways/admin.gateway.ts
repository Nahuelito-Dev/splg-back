import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { SentryWsExceptionFilter } from '../common/filters/sentry-ws-exception.filter';
import type { Namespace } from 'socket.io';
import { Logger, UseFilters } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  EVENTO_PERMISOS_CAMBIADOS,
  PermisosCambiadosEvent,
} from '../common/events/permisos-cambiados.event';
import { StaffPermissionsService } from '../admin/staff-permissions.service';
import { RoleType } from '../common/constants/role-type.enum';
import { errorMessage } from '../common/errors/error-message';
import { PermisosDePlataformaService } from '../common/permisos/catalogo-de-plataforma';
import { SocketIdentityService } from './socket-identity.service';
import type { Permiso } from '../common/permisos/catalogo';
import {
  esCanalConSala,
  ParticipacionEnConversaciones,
  PERMISO_DE_LA_SALA,
  PERMISO_PARA_ESCRIBIR,
} from './participacion-en-conversaciones.service';
import {
  salaDeUsuario,
  type DatosDeSocket,
  type SocketDeSplg,
} from './socket-data';

/**
 * Canal de tiempo real del PANEL ADMIN. A diferencia de customers/drivers (salas
 * por usuario), acá los admins de una misma distribuidora comparten una sala
 * (aislamiento entre tenants, H-77..H-84 también en vivo) y reciben los eventos
 * del ciclo de vida de los pedidos (creado/aceptado/en camino/entregado/
 * cancelado) DE SU distribuidora, para el dashboard y la campana de
 * notificaciones. El super admin es de la plataforma (modo soporte, §4.8 y D5):
 * entra sólo a la sala `platform`, que recibe los eventos de plataforma, nunca
 * los de una empresa — ni siquiera en una sesión de soporte (sin tiempo real
 * de empresa en soporte: el panel consulta por sondeo). Al terminar su sesión de
 * soporte recibe `support:ended` en su sala personal.
 *
 * Eventos del despacho (además de los `order:*` del ciclo de vida):
 *  - `order:no-drivers` `{ orderId, distributorId, reason, at }`: un pedido
 *    PENDING se quedó sin choferes a quién ofrecérselo. `reason` es
 *    `no_drivers_in_range` (no hay choferes elegibles cerca) o
 *    `all_drivers_exhausted` (los que había rechazaron o están en espera de
 *    re-oferta). Se emite una vez por agotamiento, no en cada reintento.
 *
 * Chat con la plataforma y tickets (C1, diseño de comunicación §7.2): el admin
 * con `soporte.ver` entra además a `chat:soporte:<distributorId>` (su chat con
 * la plataforma y sus tickets); el super admin, a `chat:plataforma` (los de
 * todas las empresas: es su lado de C1). Nunca a la sala de chat de una
 * empresa. Bandeja de la empresa (CH3): el admin con `mensajes.clientes` entra
 * a `chat:clientes:<distributorId>` y con `mensajes.choferes` a
 * `chat:choferes:<distributorId>` (listas y contadores); el super admin nunca.
 * Las emisiones del panel al servidor son `chat:join`, `chat:leave` y
 * `chat:typing` (`{ conversationId, internal? }`: con `internal: true` quien
 * escribe está redactando una nota interna y el «escribiendo…» NO se reenvía a
 * la otra punta, 4a).
 *
 * El join lo decide el SERVIDOR a partir de la identidad resuelta del token
 * (`SocketIdentityService`), nunca el cliente: el panel no manda nada especial
 * al conectar, sigue siendo `io(url + '/admin', { auth: { token } })`.
 */
/** Evento del socket del panel cuando termina la sesión de soporte del super admin. */
export const EVENTO_FIN_DE_SOPORTE = 'support:ended';

/** Pedido de «escribiendo…» del panel, para que el chat lo valide y lo reenvíe. */
export const EVENTO_ESCRIBIENDO_DEL_PANEL = 'panel.escribiendo';

/**
 * Una conexión del equipo de soporte de la plataforma (`plataforma.tickets.ver`)
 * entró o salió: el chat lleva la presencia del equipo (D-C26).
 */
export const EVENTO_SOPORTE_CONECTADO = 'panel.soporte.conectado';
export const EVENTO_SOPORTE_DESCONECTADO = 'panel.soporte.desconectado';

/** Una conexión del panel del equipo de la plataforma: quién y cuál. */
export interface ConexionDelSoporte {
  userId: string;
  socketId: string;
}

/** Un «escribiendo…» cada 3 segundos por conexión, como mucho. */
export const ESCRIBIENDO_CADA_MS = 3000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Punta de quien está conectado al panel: la empresa o la plataforma. */
export type PuntaDelPanel = 'company' | 'platform';

/** Respuesta (ack) de `chat:join` / `chat:leave`. */
export type RespuestaDeSala =
  | { ok: true }
  | { ok: false; code: string; message: string };

/** Los canales en que la plataforma tiene lado (C1). */
const CANALES_DE_LA_PLATAFORMA: ReadonlySet<string> = new Set([
  'platform_chat',
  'platform_ticket',
]);

const SALA_DENEGADA: RespuestaDeSala = {
  ok: false,
  code: 'CHAT_JOIN_DENIED',
  message: 'No existe esa conversación',
};

/** El panel avisa que escribe una nota interna (4a): `internal: true`. */
function esNotaInterna(cuerpo: unknown): boolean {
  return (
    typeof cuerpo === 'object' &&
    cuerpo !== null &&
    'internal' in cuerpo &&
    cuerpo.internal === true
  );
}

function idDelCuerpo(cuerpo: unknown): string | null {
  const id =
    typeof cuerpo === 'object' && cuerpo !== null && 'conversationId' in cuerpo
      ? cuerpo.conversationId
      : undefined;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

/** Lo que el chat necesita saber de un «escribiendo…». */
export interface EscribiendoDelPanel {
  conversationId: string;
  userId: string;
  /** La del admin; nula para el administrador general. */
  distributorId: string | null;
  esPlataforma: boolean;
  /**
   * Está escribiendo una nota interna (4a): no se le avisa a la otra punta
   * (el cliente, el chofer o, en un ticket, la empresa).
   */
  internal: boolean;
}

@UseFilters(SentryWsExceptionFilter)
@WebSocketGateway({
  namespace: 'admin',
})
export class AdminGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Namespace;
  private readonly logger = new Logger('AdminGateway');

  /** Sala de los super admin: sólo eventos de plataforma (no de una empresa). */
  static readonly SALA_PLATAFORMA = 'platform';

  /** Chat con las empresas y tickets, del lado de la plataforma. */
  static readonly SALA_CHAT_PLATAFORMA = 'chat:plataforma';

  constructor(
    private readonly identidades: SocketIdentityService,
    private readonly permisos: StaffPermissionsService,
    private readonly permisosDePlataforma: PermisosDePlataformaService,
    private readonly events: EventEmitter2,
    private readonly participacion: ParticipacionEnConversaciones,
  ) {}

  async handleConnection(client: SocketDeSplg): Promise<void> {
    const identidad = await this.identidades.identificar(client);

    if (!identidad) {
      this.logger.warn(`🚫 Admin rechazado (sin identidad): ${client.id}`);
      client.disconnect();
      return;
    }

    if (
      identidad.role !== RoleType.ADMIN &&
      identidad.role !== RoleType.SUPER_ADMIN
    ) {
      this.logger.warn(
        `🚫 ${identidad.email} quiso entrar al panel con rol ${identidad.role}`,
      );
      client.disconnect();
      return;
    }

    if (identidad.role === RoleType.ADMIN) {
      // Mismo criterio que `AuthGuard.resolveDistributor` en HTTP: un admin
      // SIN distribuidora en su perfil es un dato inconsistente, y no se
      // degrada a "ve todo" (eso sería fuga cross-tenant) — se rechaza, igual
      // que el guard HTTP lo rechaza con 401 (segunda revisión, punto 4).
      if (!identidad.distributorId) {
        this.logger.warn(
          `🚫 Admin sin distribuidora en su perfil: ${identidad.email}`,
        );
        client.disconnect();
        return;
      }
      await client.join(
        AdminGateway.salaDeDistribuidora(identidad.distributorId),
      );
      for (const sala of AdminGateway.salasDeListas(
        identidad.distributorId,
        await this.permisosDelPersonal(identidad.userId),
      )) {
        await client.join(sala);
      }
    } else {
      // super_admin: la plataforma. Nada de una empresa por el socket.
      await client.join(AdminGateway.SALA_PLATAFORMA);
      if (await this.veTicketsDePlataforma(identidad.userId)) {
        await client.join(AdminGateway.SALA_CHAT_PLATAFORMA);
        const conexion: ConexionDelSoporte = {
          userId: identidad.userId,
          socketId: client.id,
        };
        this.events.emit(EVENTO_SOPORTE_CONECTADO, conexion);
      }
    }

    await client.join(salaDeUsuario(identidad.userId));
    this.logger.log(`🛠️ Admin conectado: ${identidad.email} (${client.id})`);
    client.emit('server:ack', { message: 'Conectado al panel en vivo' });
  }

  /**
   * Las salas se liberan solas. Si era alguien de la plataforma, el chat saca
   * su conexión de la presencia del equipo (sacar una que no estaba no hace nada).
   */
  handleDisconnect(client: SocketDeSplg): void {
    const identidad = client.data?.identidad;
    if (identidad?.role !== RoleType.SUPER_ADMIN) return;
    const conexion: ConexionDelSoporte = {
      userId: identidad.userId,
      socketId: client.id,
    };
    this.events.emit(EVENTO_SOPORTE_DESCONECTADO, conexion);
  }

  /**
   * Las conexiones del equipo de la plataforma que atiende ESTA instancia (cada
   * una renueva las suyas en la presencia; las de una instancia caída vencen).
   */
  conexionesLocalesDelSoporte(): ConexionDelSoporte[] {
    const ids = this.server?.adapter?.rooms.get(
      AdminGateway.SALA_CHAT_PLATAFORMA,
    );
    if (!ids) return [];
    const conexiones: ConexionDelSoporte[] = [];
    for (const socketId of ids) {
      const socket = this.server.sockets.get(socketId) as
        | SocketDeSplg
        | undefined;
      const userId = socket?.data.identidad?.userId;
      if (userId) conexiones.push({ userId, socketId });
    }
    return conexiones;
  }

  /** Un mismo evento a la sala de soporte de cada una de esas empresas, en una sola emisión. */
  emitirAlSoporteDeEmpresas(
    distributorIds: readonly string[],
    event: string,
    payload: unknown,
  ): void {
    if (distributorIds.length === 0) return;
    this.server
      .to(distributorIds.map((id) => AdminGateway.salaDeSoporteDeEmpresa(id)))
      .emit(event, payload);
  }

  /**
   * Emite un evento a los admins DE esa distribuidora (y sólo a ellos: el super
   * admin no recibe la operación de las empresas). Sin `distributorId` (evento
   * que no es de un tenant en particular) va a la sala de plataforma.
   */
  notifyAdmins(
    event: string,
    payload: unknown,
    distributorId?: string | null,
  ): void {
    if (distributorId) {
      this.server
        .to(AdminGateway.salaDeDistribuidora(distributorId))
        .emit(event, payload);
      return;
    }
    this.notifyPlatform(event, payload);
  }

  /** Un evento de plataforma: sólo a los super admin. */
  notifyPlatform(event: string, payload: unknown): void {
    this.server.to(AdminGateway.SALA_PLATAFORMA).emit(event, payload);
  }

  /**
   * La sesión de soporte del super admin terminó (revocada, vencida, finalizada):
   * el panel sale del modo al instante (el sondeo de `current` cubre si no llega).
   */
  avisarFinDeSoporte(
    userId: string,
    payload: { sessionId: string; status: string; endReason: string | null },
  ): void {
    this.server.to(salaDeUsuario(userId)).emit(EVENTO_FIN_DE_SOPORTE, payload);
  }

  /** Un evento del chat con la plataforma o de un ticket, a la empresa (sólo quien tiene `soporte.ver`). */
  emitirAlSoporteDeEmpresa(
    distributorId: string,
    event: string,
    payload: unknown,
  ): void {
    this.server
      .to(AdminGateway.salaDeSoporteDeEmpresa(distributorId))
      .emit(event, payload);
  }

  /** Un evento a todas las conexiones del panel de una persona (sus otras pestañas). */
  emitirAUsuario(userId: string, event: string, payload: unknown): void {
    this.server.to(salaDeUsuario(userId)).emit(event, payload);
  }

  /** Un evento del chat con las empresas o de un ticket, a la plataforma. */
  emitirAlSoporteDePlataforma(event: string, payload: unknown): void {
    this.server.to(AdminGateway.SALA_CHAT_PLATAFORMA).emit(event, payload);
  }

  /**
   * «Escribiendo…» (diseño §7.6): no se persiste. El gateway sólo controla la
   * forma y el ritmo (uno cada 3 s por conexión); que la conversación sea de
   * quien escribe lo valida el chat antes de reenviarlo a la otra punta.
   */
  @SubscribeMessage('chat:typing')
  async handleTyping(
    @MessageBody() cuerpo: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ): Promise<void> {
    const conversationId = idDelCuerpo(cuerpo);
    if (!conversationId) return;
    const ahora = Date.now();
    const ultimo = client.data.ultimoEscribiendo ?? 0;
    if (ahora - ultimo < ESCRIBIENDO_CADA_MS) return;
    client.data.ultimoEscribiendo = ahora;
    const identidad = await this.identidades.obtener(client);
    if (!identidad) return;
    const esPlataforma = identidad.role === RoleType.SUPER_ADMIN;
    if (!esPlataforma && identidad.role !== RoleType.ADMIN) return;
    if (esPlataforma && !(await this.veTicketsDePlataforma(identidad.userId))) {
      return;
    }
    // Sólo desde la sala de esa conversación (D-C28): quien no entró por
    // `chat:join` (validado contra la base) no «escribe» en ella.
    const punta: PuntaDelPanel = esPlataforma ? 'platform' : 'company';
    if (
      !client.rooms.has(AdminGateway.salaDeConversacion(conversationId, punta))
    ) {
      return;
    }
    // Quien no puede escribir en esa conversación no «escribe»: el chat con
    // la plataforma pide `soporte.gestionar`; la bandeja, el permiso del canal.
    if (!esPlataforma) {
      const c = await this.participacion.deConversacion(conversationId);
      if (!c || !esCanalConSala(c.channel)) return;
      if (
        !(await this.tienePermiso(
          identidad.userId,
          PERMISO_PARA_ESCRIBIR[c.channel],
        ))
      ) {
        return;
      }
    }
    const pedido: EscribiendoDelPanel = {
      conversationId,
      userId: identidad.userId,
      distributorId: esPlataforma ? null : identidad.distributorId,
      esPlataforma,
      internal: esNotaInterna(cuerpo),
    };
    this.events.emit(EVENTO_ESCRIBIENDO_DEL_PANEL, pedido);
  }

  /**
   * Entrar a la sala de una conversación (D-C28). El servidor decide: la
   * conversación tiene que existir, ser de C1 y, para un admin, de SU empresa
   * con `soporte.ver`; para el super admin, con `plataforma.tickets.ver`. Si
   * no, error sin revelar si existe. Cada punta tiene su mitad de la sala
   * (`conv:<id>:company` y `conv:<id>:platform`): la empresa nunca recibe una
   * nota interna ni la versión de la plataforma de un mensaje.
   */
  @SubscribeMessage('chat:join')
  async handleJoin(
    @MessageBody() cuerpo: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ): Promise<RespuestaDeSala> {
    const conversationId = idDelCuerpo(cuerpo);
    if (!conversationId) {
      return {
        ok: false,
        code: 'INVALID_ID',
        message: 'El identificador no es válido',
      };
    }
    const punta = await this.puntaAdmitida(client, conversationId);
    if (!punta) return SALA_DENEGADA;
    await client.join(AdminGateway.salaDeConversacion(conversationId, punta));
    return { ok: true };
  }

  /** Salir de la sala de una conversación (al cerrar su pantalla). */
  @SubscribeMessage('chat:leave')
  async handleLeave(
    @MessageBody() cuerpo: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ): Promise<RespuestaDeSala> {
    const conversationId = idDelCuerpo(cuerpo);
    if (!conversationId) return SALA_DENEGADA;
    for (const punta of ['company', 'platform'] as const) {
      await client.leave(
        AdminGateway.salaDeConversacion(conversationId, punta),
      );
    }
    return { ok: true };
  }

  /** La punta con la que entra a la sala, o `null` si no puede. Falla cerrado. */
  private async puntaAdmitida(
    client: SocketDeSplg,
    conversationId: string,
  ): Promise<PuntaDelPanel | null> {
    try {
      const identidad = await this.identidades.obtener(client);
      if (!identidad) return null;
      const c = await this.participacion.deConversacion(conversationId);
      if (!c || !esCanalConSala(c.channel)) return null;
      if (identidad.role === RoleType.SUPER_ADMIN) {
        // La plataforma sólo tiene lado en C1: nunca en la bandeja de una empresa.
        if (!CANALES_DE_LA_PLATAFORMA.has(c.channel)) return null;
        return (await this.veTicketsDePlataforma(identidad.userId))
          ? 'platform'
          : null;
      }
      if (identidad.role !== RoleType.ADMIN) return null;
      if (c.distributorId !== identidad.distributorId) return null;
      // La bandeja es del módulo `chat`: apagado, nadie entra a sus salas.
      if (
        !CANALES_DE_LA_PLATAFORMA.has(c.channel) &&
        !(await this.participacion.chatHabilitado(c.distributorId))
      ) {
        return null;
      }
      return (await this.tienePermiso(
        identidad.userId,
        PERMISO_DE_LA_SALA[c.channel],
      ))
        ? 'company'
        : null;
    } catch (error) {
      this.logger.warn(
        `No se pudo validar la sala de ${conversationId}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /** Un evento a la mitad de la sala de una conversación de esa punta. */
  emitirAConversacion(
    conversationId: string,
    punta: PuntaDelPanel,
    event: string,
    payload: unknown,
  ): void {
    this.server
      .to(AdminGateway.salaDeConversacion(conversationId, punta))
      .emit(event, payload);
  }

  static salaDeConversacion(
    conversationId: string,
    punta: PuntaDelPanel,
  ): string {
    return `conv:${conversationId}:${punta}`;
  }

  /**
   * Cambiaron los permisos de estas personas: sus conexiones abiertas vuelven a
   * evaluar las salas de lista de la empresa (soporte, clientes, choferes):
   * entran a las que ganaron y salen de las que perdieron, y de las salas de
   * conversación de la empresa cuyo canal ya no atienden. No se corta la
   * conexión: el resto del panel sigue en vivo.
   */
  @OnEvent(EVENTO_PERMISOS_CAMBIADOS)
  async reevaluarSalas({ userIds }: PermisosCambiadosEvent): Promise<void> {
    if (!this.server) return;
    for (const userId of userIds) {
      const permisos = await this.permisosDelPersonal(userId);
      const conexiones = await this.server
        .in(salaDeUsuario(userId))
        .fetchSockets();
      for (const conexion of conexiones) {
        const { identidad } = conexion.data as DatosDeSocket;
        if (identidad?.role !== RoleType.ADMIN || !identidad.distributorId) {
          continue;
        }
        const d = identidad.distributorId;
        const debe = new Set(AdminGateway.salasDeListas(d, permisos));
        for (const sala of AdminGateway.salasDeListas(d, [
          'soporte.ver',
          'mensajes.clientes',
          'mensajes.choferes',
        ])) {
          if (debe.has(sala)) conexion.join(sala);
          else conexion.leave(sala);
        }
        for (const otra of conexion.rooms) {
          if (!otra.startsWith('conv:') || !otra.endsWith(':company')) continue;
          const id = otra.slice('conv:'.length, -':company'.length);
          const c = await this.participacion.deConversacion(id);
          const sigue =
            !!c &&
            esCanalConSala(c.channel) &&
            permisos.includes(PERMISO_DE_LA_SALA[c.channel]);
          if (!sigue) conexion.leave(otra);
        }
      }
      this.logger.log(
        `🔁 Salas del panel reevaluadas para ${userId} (${[...permisos].filter((p) => p.startsWith('soporte.') || p.startsWith('mensajes.')).join(', ') || 'sin soporte ni mensajes'})`,
      );
    }
  }

  /**
   * Las salas de lista de la empresa que corresponden a esos permisos: el chat
   * con la plataforma y los tickets (`soporte.ver`), y la bandeja de clientes y
   * de choferes (`mensajes.clientes`, `mensajes.choferes`).
   */
  static salasDeListas(
    distributorId: string,
    permisos: readonly string[],
  ): string[] {
    const salas: string[] = [];
    if (permisos.includes('soporte.ver')) {
      salas.push(AdminGateway.salaDeSoporteDeEmpresa(distributorId));
    }
    if (permisos.includes('mensajes.clientes')) {
      salas.push(AdminGateway.salaDeLaBandeja(distributorId, 'staff_customer'));
    }
    if (permisos.includes('mensajes.choferes')) {
      salas.push(AdminGateway.salaDeLaBandeja(distributorId, 'staff_driver'));
    }
    return salas;
  }

  /** Sala de lista de la bandeja de la empresa, por canal. */
  static salaDeLaBandeja(
    distributorId: string,
    canal: 'staff_customer' | 'staff_driver',
  ): string {
    return canal === 'staff_customer'
      ? `chat:clientes:${distributorId}`
      : `chat:choferes:${distributorId}`;
  }

  /** Un aviso de la bandeja a quienes atienden ese canal en esa empresa. */
  emitirALaBandeja(
    distributorId: string,
    canal: 'staff_customer' | 'staff_driver',
    event: string,
    payload: unknown,
  ): void {
    this.server
      .to(AdminGateway.salaDeLaBandeja(distributorId, canal))
      .emit(event, payload);
  }

  /** Los permisos del personal. Falla cerrado: sin permisos. */
  private async permisosDelPersonal(userId: string): Promise<Permiso[]> {
    try {
      return (await this.permisos.deUsuario(userId, RoleType.ADMIN)).permisos;
    } catch (error) {
      this.logger.warn(
        `No se pudieron leer los permisos de ${userId}: ${errorMessage(error)}`,
      );
      return [];
    }
  }

  /** Un permiso del personal de la empresa. Falla cerrado. */
  private async tienePermiso(
    userId: string,
    permiso: Permiso,
  ): Promise<boolean> {
    try {
      const { permisos } = await this.permisos.deUsuario(
        userId,
        RoleType.ADMIN,
      );
      return permisos.includes(permiso);
    } catch (error) {
      this.logger.warn(
        `No se pudieron leer los permisos de ${userId}: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  /** Si el administrador general ve el chat con las empresas y los tickets. Falla cerrado. */
  private async veTicketsDePlataforma(userId: string): Promise<boolean> {
    try {
      const permisos = await this.permisosDePlataforma.deUsuario(
        userId,
        RoleType.SUPER_ADMIN,
      );
      return permisos.includes('plataforma.tickets.ver');
    } catch (error) {
      this.logger.warn(
        `No se pudieron leer los permisos de plataforma de ${userId}: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  private static salaDeDistribuidora(distributorId: string): string {
    return `admins:${distributorId}`;
  }

  static salaDeSoporteDeEmpresa(distributorId: string): string {
    return `chat:soporte:${distributorId}`;
  }
}
