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
import { Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SocketIdentityService } from './socket-identity.service';
import { salaDeUsuario, type SocketDeSplg } from './socket-data';
import { ParticipacionEnConversaciones } from './participacion-en-conversaciones.service';
import {
  pedirEscribiendo,
  type RespuestaDeSalaDeLaApp,
  salaDeConversacionDeLaApp,
  salirDeLaConversacion,
  unirseALaConversacion,
} from './salas-de-las-apps';

@WebSocketGateway({
  namespace: 'customers',
})
export class CustomersGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Namespace;
  private readonly logger = new Logger('CustomersGateway');

  constructor(
    private readonly identidades: SocketIdentityService,
    @Optional() private readonly participacion?: ParticipacionEnConversaciones,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  async handleConnection(client: SocketDeSplg): Promise<void> {
    const identidad = await this.identidades.identificar(client);

    if (!identidad) {
      this.logger.warn(`🚫 Cliente rechazado (sin identidad): ${client.id}`);
      client.disconnect();
      return;
    }

    await client.join(salaDeUsuario(identidad.userId));
    this.logger.log(`👤 Cliente conectado: ${identidad.email} (${client.id})`);
  }

  handleDisconnect(): void {
    // sin estado por-cliente que limpiar (la sala se libera sola)
  }

  /**
   * El cliente entra a su sala. El identificador sale de la identidad resuelta
   * en el handshake, NO del cuerpo del mensaje: creyéndole al cliente,
   * cualquiera que conozca un `user_id` ajeno seguía en vivo la entrega de esa
   * persona, con su posición y su domicilio.
   *
   * El cuerpo se sigue aceptando por compatibilidad con las apps publicadas,
   * pero se ignora.
   */
  @SubscribeMessage('customer:join')
  async handleCustomerJoin(
    @MessageBody() _cuerpoIgnorado: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ) {
    const identidad = await this.identidades.obtener(client);
    if (!identidad) {
      client.disconnect();
      return;
    }

    const roomName = `customer_${identidad.userId}`;
    await client.join(roomName);
    this.logger.log(`👤 Cliente ${identidad.userId} unido a sala ${roomName}`);
    client.emit('server:ack', {
      message: 'Conectado a actualizaciones de pedidos',
    });
  }

  /**
   * Entrar a la sala de una conversación propia con la empresa (C3, D-C28):
   * el servidor valida contra la base que sea del cliente. Si no, el ack es
   * `CHAT_JOIN_DENIED` sin decir si existe.
   */
  @SubscribeMessage('chat:join')
  async handleChatJoin(
    @MessageBody() cuerpo: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ): Promise<RespuestaDeSalaDeLaApp> {
    const identidad = await this.identidades.obtener(client);
    if (!identidad) {
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
      'customer',
      this.participacion,
      this.logger,
    );
  }

  @SubscribeMessage('chat:leave')
  handleChatLeave(
    @MessageBody() cuerpo: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ): Promise<RespuestaDeSalaDeLaApp> {
    return salirDeLaConversacion(client, cuerpo, 'customer');
  }

  /** «Escribiendo…» del cliente: sólo desde una conversación en la que entró. */
  @SubscribeMessage('chat:typing')
  async handleChatTyping(
    @MessageBody() cuerpo: unknown,
    @ConnectedSocket() client: SocketDeSplg,
  ): Promise<void> {
    const identidad = await this.identidades.obtener(client);
    if (!identidad) return;
    pedirEscribiendo(client, cuerpo, identidad.userId, 'customer', this.events);
  }

  /** Un evento del chat a la sala de una conversación del cliente. */
  emitirAConversacion(
    conversationId: string,
    event: string,
    payload: unknown,
  ): void {
    this.server
      .to(salaDeConversacionDeLaApp(conversationId, 'customer'))
      .emit(event, payload);
  }

  /** Un aviso a todas las conexiones de la app de esa persona. */
  emitirAUsuario(userId: string, event: string, payload: unknown): void {
    this.server.to(salaDeUsuario(userId)).emit(event, payload);
  }

  // Método para enviar alertas al cliente
  notifyCustomer(customerId: string, event: string, payload: unknown): void {
    const roomName = `customer_${customerId}`;
    this.logger.log(`🔔 Notificando a Cliente ${customerId}: ${event}`);
    this.server.to(roomName).emit(event, payload);
  }
}
