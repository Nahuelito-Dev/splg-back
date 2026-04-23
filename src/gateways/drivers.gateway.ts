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
import { RedisService } from '../redis/redis.service';
import { Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: 'drivers',
})
export class DriversGateway
  implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;
  private readonly logger = new Logger('DriversGateway');

  constructor(
    private readonly redisService: RedisService,
    private readonly authService: AuthService,
  ) { }

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.split(' ')[1];

      if (!token) {
        this.logger.warn(`🚫 Conexión rechazada (Sin token): ${client.id}`);
        client.disconnect();
        return;
      }

      const decoded = await this.authService.decodeToken(token);
      (client as any).user = decoded;

      this.logger.log(`🔌 Chofer conectado: ${decoded.email} (${client.id})`);
    } catch (error) {
      this.logger.error(`🚫 Error de auth socket: ${error.message}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    // this.logger.log(`❌ Chofer desconectado: ${client.id}`);
  }

  @SubscribeMessage('driver:join')
  handleDriverJoin(
    @MessageBody() data: { driverId: string },
    @ConnectedSocket() client: Socket,
  ) {
    client.join(`driver_${data.driverId}`);
    (client as any).driverId = data.driverId;
    this.logger.log(`🚚 Chofer ${data.driverId} unido a sala personal`);
    client.emit('server:ack', { message: 'Conectado al despacho' });
  }

  // 👇 CORREGIDO: Acepta userId para coincidir con tu Postman
  @SubscribeMessage('driver:update-location')
  async handleDriverLocation(
    @MessageBody() data: { userId: string; lat: number; lng: number },
    @ConnectedSocket() client: Socket,
  ) {
    if (!data.userId || !data.lat || !data.lng) {
      this.logger.error('❌ Datos de ubicación inválidos:', data);
      return;
    }

    await this.redisService.updateDriverLocation(
      data.userId,
      data.lat,
      data.lng,
    );

    this.logger.log(
      `📍 Radar actualizado: Chofer ${data.userId} en [${data.lat}, ${data.lng}]`,
    );
  }

  notifyNewOrder(driverId: string, orderPayload: any) {
    this.logger.log(
      `📡 Enviando pedido ${orderPayload.orderId} al chofer ${driverId}`,
    );
    this.server
      .to(`driver_${driverId}`)
      .emit('server:new-order-request', orderPayload);
    return true;
  }

  notifyOrderCancelled(driverId: string, payload: any) {
    this.logger.log(`🚫 Avisando cancelación a chofer ${driverId}`);
    this.server.to(`driver_${driverId}`).emit('order:cancelled', payload);
  }
}
