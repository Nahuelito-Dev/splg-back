import { Injectable, Logger } from '@nestjs/common';
import type { User } from '../users/entities/user.entity';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { CustomersService } from '../customer/customer.service';
import { DeliveryService } from '../delivery/delivery.service';
import {
  ResultadoDeEnvioDto,
  TokensDeUsuarioDto,
} from './dto/notification-response.dto';
import { FcmPort } from '../firebase/ports/fcm.port';
import { errorMessage } from '../common/errors/error-message';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('NotificationService');

  constructor(
    private readonly customersService: CustomersService,
    private readonly deliveryService: DeliveryService,
    private readonly fcm: FcmPort,
  ) {}

  async sendTestNotification(
    token: string,
    title: string,
    body: string,
  ): Promise<ResultadoDeEnvioDto> {
    try {
      const message = {
        notification: {
          title,
          body,
        },
        data: {
          type: 'TEST',
          timestamp: new Date().toISOString(),
        },
      };

      const response = await this.fcm.sendToToken(token, message);
      this.logger.log(`Test notification sent: ${response}`);
      return { success: true, messageId: response };
    } catch (error) {
      this.logger.error(
        `Error sending test notification: ${errorMessage(error)}`,
      );
      return { success: false, error: errorMessage(error) };
    }
  }

  async sendOrderConfirmation(
    customerId: string,
    orderId: string,
    token?: string,
  ): Promise<ResultadoDeEnvioDto> {
    try {
      const cliente =
        await this.customersService.findNotificationToken(customerId);

      if (!cliente.esCliente) {
        this.logger.warn(`Customer not found: ${customerId}`);
        return { success: false, error: 'Customer not found' };
      }

      // Usar token del cliente o el proporcionado
      const notificationToken = token || cliente.token;

      if (!notificationToken) {
        this.logger.warn(`No notification token for customer: ${customerId}`);
        return { success: false, error: 'No notification token' };
      }

      const message = {
        notification: {
          title: '¡Pedido Confirmado!',
          body: `Tu pedido #${orderId.substring(0, 8)} ha sido creado exitosamente.`,
        },
        data: {
          orderId,
          type: 'ORDER_CONFIRMATION',
          customerId,
        },
      };

      const response = await this.fcm.sendToToken(notificationToken, message);
      this.logger.log(`Order confirmation sent for order: ${orderId}`);
      return { success: true, messageId: response };
    } catch (error) {
      this.logger.error(
        `Error sending order confirmation: ${errorMessage(error)}`,
      );
      return { success: false, error: errorMessage(error) };
    }
  }

  async sendOrderStatusUpdate(
    customer: User,
    order: Order,
    notificationToken?: string,
  ): Promise<ResultadoDeEnvioDto> {
    try {
      const token = notificationToken || customer.customer?.notification_token;

      if (!token) {
        return { success: false, error: 'No notification token' };
      }

      const statusMessages: Partial<Record<OrderStatus, string>> = {
        pending: 'Tu pedido está pendiente.',
        accepted: '¡Tu pedido ha sido aceptado!',
        on_the_way: '¡Tu pedido está en camino!',
        delivered: '¡Pedido entregado! Gracias por tu compra.',
        cancelled: 'Tu pedido ha sido cancelado.',
      };

      const message = {
        notification: {
          title: 'Actualización de Pedido',
          body:
            statusMessages[order.status] || 'Estado de tu pedido actualizado.',
        },
        data: {
          orderId: order.order_id,
          status: order.status,
          type: 'ORDER_STATUS_UPDATE',
        },
      };

      const response = await this.fcm.sendToToken(token, message);
      this.logger.log(`Order status update sent for order: ${order.order_id}`);
      return { success: true, messageId: response };
    } catch (error) {
      this.logger.error(
        `Error sending status notification: ${errorMessage(error)}`,
      );
      return { success: false, error: errorMessage(error) };
    }
  }

  async getUserNotificationTokens(userId: string): Promise<TokensDeUsuarioDto> {
    try {
      const { token } =
        await this.customersService.findNotificationToken(userId);
      return { tokens: token ? [token] : [] };
    } catch (error) {
      this.logger.error(`Error getting user tokens: ${errorMessage(error)}`);
      return { tokens: [] };
    }
  }

  /**
   * Push de "nueva oferta de pedido" al chofer. Best-effort y complementario al
   * socket: si el chofer tiene la app cerrada/en background, el socket no llega
   * pero el push sí (siempre que haya registrado su token FCM). No-op si el
   * chofer no tiene token. Nunca lanza (no debe romper el dispatch).
   */
  async sendOfferPushToDriver(
    driverUserId: string,
    orderId: string,
  ): Promise<void> {
    try {
      const token =
        await this.deliveryService.findNotificationToken(driverUserId);
      if (!token) return;

      await this.fcm.sendToToken(token, {
        notification: {
          title: '¡Nuevo pedido disponible!',
          body: 'Tenés una oferta de entrega. Abrí la app para aceptarla.',
        },
        data: { event: 'NEW_ORDER', orderId },
        android: { priority: 'high' },
        apns: { headers: { 'apns-priority': '10' } },
      });
      this.logger.log(
        `Push de oferta enviado al chofer ${driverUserId} (pedido ${orderId})`,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar push de oferta al chofer ${driverUserId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Push de "el repartidor llegó" al cliente. Best-effort y complementario al
   * socket `order:arrived`: si el cliente tiene la app cerrada o en segundo
   * plano el socket no llega, y sin este push el aviso se pierde justo en el
   * caso que CU-011 quería cubrir. No-op si el cliente no registró token.
   * Nunca lanza: el aviso de llegada no debe romperse por un fallo de FCM.
   */
  async sendArrivalPushToCustomer(
    customerUserId: string,
    orderId: string,
    driverName: string,
  ): Promise<void> {
    try {
      const { token } =
        await this.customersService.findNotificationToken(customerUserId);
      if (!token) return;

      await this.fcm.sendToToken(token, {
        notification: {
          title: '¡Tu pedido llegó!',
          body: `${driverName} está en la puerta.`,
        },
        data: { event: 'ORDER_ARRIVED', orderId },
        android: { priority: 'high' },
        apns: { headers: { 'apns-priority': '10' } },
      });
      this.logger.log(
        `Push de llegada enviado al cliente ${customerUserId} (pedido ${orderId})`,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar push de llegada al cliente ${customerUserId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Guarda el token FCM del dispositivo. El mismo endpoint lo usan la app
   * cliente y la app chofer: se intenta primero como cliente y, si no lo es,
   * como chofer. Así el push le puede llegar a cualquiera de los dos lados.
   */
  async saveNotificationToken(
    userId: string,
    token: string,
    platform: string,
  ): Promise<ResultadoDeEnvioDto> {
    try {
      if (await this.customersService.saveNotificationToken(userId, token)) {
        this.logger.log(`Token FCM guardado (cliente ${userId}, ${platform})`);
        return { success: true };
      }

      if (await this.deliveryService.saveNotificationToken(userId, token)) {
        this.logger.log(`Token FCM guardado (chofer ${userId}, ${platform})`);
        return { success: true };
      }

      this.logger.warn(`Usuario no encontrado para token FCM: ${userId}`);
      return { success: false, error: 'User not found' };
    } catch (error) {
      this.logger.error(
        `Error saving notification token: ${errorMessage(error)}`,
      );
      return { success: false, error: errorMessage(error) };
    }
  }
}
