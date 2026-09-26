import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { errorMessage } from '../common/errors/error-message';
import { SocketDeSplg, tokenDelHandshake } from './socket-data';

/**
 * Canal de tiempo real del PANEL ADMIN. A diferencia de customers/drivers (salas
 * por usuario), acá todos los admins conectados comparten una sala global
 * `admins` y reciben los eventos del ciclo de vida de los pedidos
 * (creado/aceptado/en camino/entregado/cancelado) para el dashboard y la campana
 * de notificaciones.
 */
@WebSocketGateway({
  cors: { origin: '*' },
  namespace: 'admin',
})
export class AdminGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;
  private readonly logger = new Logger('AdminGateway');

  /** Sala única donde viven todos los admins conectados. */
  private static readonly ROOM = 'admins';

  constructor(private readonly authService: AuthService) {}

  async handleConnection(client: SocketDeSplg): Promise<void> {
    try {
      const token = tokenDelHandshake(client);

      if (!token) {
        this.logger.warn(`🚫 Admin rechazado (sin token): ${client.id}`);
        client.disconnect();
        return;
      }

      const decoded = await this.authService.decodeToken(token);
      client.data.admin = decoded;
      await client.join(AdminGateway.ROOM);
      this.logger.log(`🛠️ Admin conectado: ${decoded.email} (${client.id})`);
      client.emit('server:ack', { message: 'Conectado al panel en vivo' });
    } catch (error) {
      this.logger.error(`🚫 Error auth socket admin: ${errorMessage(error)}`);
      client.disconnect();
    }
  }

  handleDisconnect(): void {
    // sin estado por-cliente que limpiar (la sala se libera sola)
  }

  /** Emite un evento del ciclo de vida del pedido a TODOS los admins. */
  notifyAdmins(event: string, payload: unknown): void {
    this.server.to(AdminGateway.ROOM).emit(event, payload);
  }
}
