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
import { CustomersGateway } from './customers.gateway';
import { AdminGateway } from './admin.gateway';

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
    private readonly customersGateway: CustomersGateway,
    private readonly adminGateway: AdminGateway,
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
    // Al desconectarse, sacamos al chofer del radar GEO para que el dispatch no
    // le ofrezca pedidos y espere 30s a que expire (choferes fantasma). El
    // member del GEO es el userId (ver handleDriverLocation).
    const id = (client as any).userId ?? (client as any).driverId;
    if (id) {
      try {
        await this.redisService.removeDriver(id);
        this.logger.log(`❌ Chofer ${id} desconectado y sacado del radar`);
      } catch (err) {
        this.logger.warn(
          `No se pudo sacar del radar al chofer ${id}: ${(err as Error).message}`,
        );
      }
    }
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
    // `== null` (no `!`) para no descartar lat/lng = 0 (ecuador/meridiano).
    if (!data.userId || data.lat == null || data.lng == null) {
      this.logger.error('❌ Datos de ubicación inválidos:', data);
      return;
    }

    // Recordamos el userId en el socket para poder sacarlo del radar al desconectar.
    (client as any).userId = data.userId;

    await this.redisService.updateDriverLocation(
      data.userId,
      data.lat,
      data.lng,
    );

    // Tracking en vivo: si el chofer está entregando un pedido, reenviamos su
    // posición al cliente de ESE pedido y al panel admin. El mapping chofer→pedido
    // lo setea updateStatus al pasar a ON_THE_WAY y lo limpia al entregar.
    const active = await this.redisService.getDriverActiveOrder(data.userId);
    if (active) {
      const payload = {
        orderId: active.orderId,
        driverId: data.userId,
        lat: data.lat,
        lng: data.lng,
        at: new Date().toISOString(),
      };
      this.customersGateway.notifyCustomer(
        active.customerId,
        'order:driver-location',
        payload,
      );
      this.adminGateway.notifyAdmins('order:driver-location', payload);
    }
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
