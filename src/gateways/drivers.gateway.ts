import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import type { Namespace } from 'socket.io';
import { RedisService } from '../redis/redis.service';
import { Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RoleType } from '../common/constants/role-type.enum';
import { SocketIdentityService } from './socket-identity.service';
import { CustomersGateway } from './customers.gateway';
import { AdminGateway } from './admin.gateway';
import { errorMessage } from '../common/errors/error-message';
import { salaDeUsuario, type SocketDeSplg } from './socket-data';
import { ParticipacionEnConversaciones } from './participacion-en-conversaciones.service';
import {
  pedirEscribiendo,
  type RespuestaDeSalaDeLaApp,
  salaDeConversacionDeLaApp,
  salirDeLaConversacion,
  unirseALaConversacion,
} from './salas-de-las-apps';

/**
 * Posición nueva de un chofer (después de guardarla en el radar). La escucha
 * la hoja de ruta en curso para recalcular la hora estimada (F34 E5); el
 * gateway no conoce la hoja.
 */
export const EVENTO_POSICION_DEL_CHOFER = 'chofer.posicion';
export interface PosicionDelChofer {
  userId: string;
  lat: number;
  lng: number;
}

@WebSocketGateway({
  namespace: 'drivers',
})
export class DriversGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Namespace;
  private readonly logger = new Logger('DriversGateway');

  constructor(
    private readonly redisService: RedisService,
    private readonly identidades: SocketIdentityService,
    private readonly customersGateway: CustomersGateway,
    private readonly adminGateway: AdminGateway,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() private readonly participacion?: ParticipacionEnConversaciones,
  ) {}

  async handleConnection(client: SocketDeSplg): Promise<void> {
    const identidad = await this.identidades.identificar(client);

    if (!identidad) {
      this.logger.warn(`🚫 Conexión rechazada (sin identidad): ${client.id}`);
      client.disconnect();
      return;
    }

    // Este namespace es el de los choferes: un cliente no tiene nada que hacer
    // acá, ni siquiera mirando.
    if (
      identidad.role !== RoleType.DELIVERY &&
      identidad.role !== RoleType.ADMIN &&
      identidad.role !== RoleType.SUPER_ADMIN
    ) {
      this.logger.warn(
        `🚫 ${identidad.email} quiso entrar al namespace de choferes con rol ${identidad.role}`,
      );
      client.disconnect();
      return;
    }

    await client.join(salaDeUsuario(identidad.userId));
    this.logger.log(`🔌 Chofer conectado: ${identidad.email} (${client.id})`);
  }

  async handleDisconnect(client: SocketDeSplg): Promise<void> {
    // Al desconectarse, sacamos al chofer del radar GEO para que el dispatch no
    // le ofrezca pedidos y espere 30s a que expire (choferes fantasma). El
    // member del GEO es el userId (ver handleDriverLocation).
    const id = client.data.choferId;
    if (id) {
      try {
        await this.redisService.removeDriver(id);
        this.logger.log(`❌ Chofer ${id} desconectado y sacado del radar`);
      } catch (err) {
        this.logger.warn(
          `No se pudo sacar del radar al chofer ${id}: ${errorMessage(err)}`,
        );
      }
    }
  }

  /**
   * El chofer entra a su sala personal. El identificador sale de la identidad
   * que se resolvió en el handshake, NO del cuerpo del mensaje: si se le creyera
   * al cliente, cualquiera podría unirse a la sala de otro y quedarse
   * escuchando sus ofertas y su entrega en vivo.
   *
   * El cuerpo se sigue aceptando por compatibilidad con las apps publicadas,
   * pero se ignora.
   */
  @SubscribeMessage('driver:join')
  async handleDriverJoin(
    @MessageBody() _cuerpoIgnorado: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ) {
    const identidad = await this.identidades.obtener(client);
    if (!identidad) {
      client.disconnect();
      return;
    }

    await client.join(`driver_${identidad.userId}`);
    client.data.choferId = identidad.userId;
    this.logger.log(`🚚 Chofer ${identidad.userId} unido a sala personal`);
    client.emit('server:ack', { message: 'Conectado al despacho' });
  }

  /**
   * El chofer reporta su posición. Igual que en `driver:join`, de quién es la
   * posición lo decide el token y no el cuerpo: si no, cualquiera podría mover
   * a otro chofer por el mapa y desviarle los pedidos.
   */
  @SubscribeMessage('driver:update-location')
  async handleDriverLocation(
    @MessageBody() data: { lat: number; lng: number },
    @ConnectedSocket() client: SocketDeSplg,
  ) {
    const identidad = await this.identidades.obtener(client);
    if (!identidad) {
      client.disconnect();
      return;
    }

    // `== null` (no `!`) para no descartar lat/lng = 0 (ecuador/meridiano).
    if (data?.lat == null || data?.lng == null) {
      this.logger.error('❌ Datos de ubicación inválidos:', data);
      return;
    }

    const userId = identidad.userId;

    // Recordamos el userId en el socket para poder sacarlo del radar al desconectar.
    client.data.choferId = userId;

    await this.redisService.updateDriverLocation(userId, data.lat, data.lng);
    const posicion: PosicionDelChofer = {
      userId,
      lat: Number(data.lat),
      lng: Number(data.lng),
    };
    this.events?.emit(EVENTO_POSICION_DEL_CHOFER, posicion);

    // Tracking en vivo: si el chofer está entregando un pedido, reenviamos su
    // posición al cliente de ESE pedido y al panel admin. El mapping chofer→pedido
    // lo setea updateStatus al pasar a ON_THE_WAY y lo limpia al entregar.
    const active = await this.redisService.getDriverActiveOrder(userId);
    if (active) {
      const payload = {
        orderId: active.orderId,
        driverId: userId,
        lat: data.lat,
        lng: data.lng,
        at: new Date().toISOString(),
      };
      this.customersGateway.notifyCustomer(
        active.customerId,
        'order:driver-location',
        payload,
      );
      this.adminGateway.notifyAdmins(
        'order:driver-location',
        payload,
        active.distributorId,
      );
    }
  }

  /**
   * Entrar a la sala de una conversación propia con la empresa (C2, D-C28):
   * sólo un chofer y sólo las suyas (validado contra la base).
   */
  @SubscribeMessage('chat:join')
  async handleChatJoin(
    @MessageBody() cuerpo: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ): Promise<RespuestaDeSalaDeLaApp> {
    const identidad = await this.identidades.obtener(client);
    if (!identidad || identidad.role !== RoleType.DELIVERY) {
      return {
        ok: false,
        code: 'CHAT_JOIN_DENIED',
        message: 'No existe esa conversación',
      };
    }
    return unirseALaConversacion(
      client,
      cuerpo,
      identidad.userId,
      'driver',
      this.participacion,
      this.logger,
    );
  }

  @SubscribeMessage('chat:leave')
  handleChatLeave(
    @MessageBody() cuerpo: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ): Promise<RespuestaDeSalaDeLaApp> {
    return salirDeLaConversacion(client, cuerpo, 'driver');
  }

  /** «Escribiendo…» del chofer: sólo desde una conversación en la que entró. */
  @SubscribeMessage('chat:typing')
  async handleChatTyping(
    @MessageBody() cuerpo: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ): Promise<void> {
    const identidad = await this.identidades.obtener(client);
    if (!identidad || identidad.role !== RoleType.DELIVERY) return;
    pedirEscribiendo(client, cuerpo, identidad.userId, 'driver', this.events);
  }

  /** Un evento del chat a la sala de una conversación del chofer. */
  emitirAConversacion(
    conversationId: string,
    event: string,
    payload: unknown,
  ): void {
    this.server
      .to(salaDeConversacionDeLaApp(conversationId, 'driver'))
      .emit(event, payload);
  }

  /** Un aviso a todas las conexiones de la app de ese chofer. */
  emitirAUsuario(userId: string, event: string, payload: unknown): void {
    this.server.to(salaDeUsuario(userId)).emit(event, payload);
  }

  notifyNewOrder(driverId: string, orderPayload: unknown): boolean {
    this.logger.log(
      `📡 Enviando pedido ${idDelPedido(orderPayload)} al chofer ${driverId}`,
    );
    this.server
      .to(`driver_${driverId}`)
      .emit('server:new-order-request', orderPayload);
    return true;
  }

  notifyOrderCancelled(driverId: string, payload: unknown): void {
    this.logger.log(`🚫 Avisando cancelación a chofer ${driverId}`);
    this.server.to(`driver_${driverId}`).emit('order:cancelled', payload);
  }

  /** Evento de la planificación de flota (CU-105): propuesta nueva, cerrada o ventana confirmada. */
  notifyMaintenance(
    driverId: string,
    evento:
      | 'maintenance:proposal'
      | 'maintenance:proposal-closed'
      | 'maintenance:case-escalated'
      | 'maintenance:window-confirmed',
    payload: unknown,
  ): void {
    this.logger.log(`🔧 ${evento} para el chofer ${driverId}`);
    this.server.to(`driver_${driverId}`).emit(evento, payload);
  }

  /**
   * Eventos del recorrido agrupado (CU-107): oferta del lote, oferta cerrada y
   * lote asignado; y de la hoja de ruta en curso (F34): iniciada, cambió (cayó o
   * se agregó una parada, se reordenó) y cerrada.
   */
  notifyRouteBatch(
    driverId: string,
    evento:
      | 'route-batch:offer'
      | 'route-batch:offer-closed'
      | 'route-batch:assigned'
      | 'route-sheet:assigned'
      | 'route-sheet:started'
      | 'route-sheet:changed'
      | 'route-sheet:wait-expired'
      | 'route-sheet:closed',
    payload: unknown,
  ): void {
    this.logger.log(`🧭 ${evento} para el chofer ${driverId}`);
    this.server.to(`driver_${driverId}`).emit(evento, payload);
  }

  notifyOrderAddressChanged(driverId: string, payload: unknown): void {
    this.logger.log(
      `📍 Avisando cambio de dirección del pedido ${idDelPedido(payload)} a chofer ${driverId}`,
    );
    this.server.to(`driver_${driverId}`).emit('order:address-changed', payload);
  }

  notifyDeliveryCode(
    driverId: string,
    evento: 'order:delivery-code-failed' | 'order:delivery-code-blocked',
    payload: unknown,
  ): void {
    this.logger.log(
      `🔐 ${evento} del pedido ${idDelPedido(payload)} para el chofer ${driverId}`,
    );
    this.server.to(`driver_${driverId}`).emit(evento, payload);
  }
}

function idDelPedido(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'orderId' in payload) {
    return String(payload.orderId);
  }
  return '?';
}
