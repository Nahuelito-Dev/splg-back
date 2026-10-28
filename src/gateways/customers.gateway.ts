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
import { Logger } from '@nestjs/common';
import { SocketIdentityService } from './socket-identity.service';
import { salaDeUsuario, type SocketDeSplg } from './socket-data';

@WebSocketGateway({
  namespace: 'customers',
})
export class CustomersGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Namespace;
  private readonly logger = new Logger('CustomersGateway');

  constructor(private readonly identidades: SocketIdentityService) {}

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

  // Método para enviar alertas al cliente
  notifyCustomer(customerId: string, event: string, payload: unknown): void {
    const roomName = `customer_${customerId}`;
    this.logger.log(`🔔 Notificando a Cliente ${customerId}: ${event}`);
    this.server.to(roomName).emit(event, payload);
  }
}
