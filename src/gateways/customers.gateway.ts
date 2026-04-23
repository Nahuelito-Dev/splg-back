import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: 'customers',
})
export class CustomersGateway
  implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;
  private readonly logger = new Logger('CustomersGateway');

  constructor(private readonly authService: AuthService) { }

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.split(' ')[1];

      if (!token) {
        this.logger.warn(`🚫 Cliente rechazado (Sin token): ${client.id}`);
        client.disconnect();
        return;
      }

      const decoded = await this.authService.decodeToken(token);
      (client as any).user = decoded;

      this.logger.log(`👤 Cliente conectado: ${decoded.email} (${client.id})`);
    } catch (error) {
      this.logger.error(`🚫 Errorauth socket cliente: ${error.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    // this.logger.log(`❌ Cliente desconectado: ${client.id}`);
  }

  // El cliente se une a su sala con su ID de usuario
  @SubscribeMessage('customer:join')
  handleCustomerJoin(
    @MessageBody() data: { customerId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const roomName = `customer_${data.customerId}`;
    client.join(roomName);
    this.logger.log(`👤 Cliente ${data.customerId} unido a sala ${roomName}`);
    client.emit('server:ack', {
      message: 'Conectado a actualizaciones de pedidos',
    });
  }

  // Método para enviar alertas al cliente
  notifyCustomer(customerId: string, event: string, payload: any) {
    const roomName = `customer_${customerId}`;
    this.logger.log(`🔔 Notificando a Cliente ${customerId}: ${event}`);
    this.server.to(roomName).emit(event, payload);
  }
}
