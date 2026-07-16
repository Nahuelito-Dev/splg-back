// src/notifications/notifications.service.ts - VERSIÓN MEJORADA
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Customer } from '../customer/entities/customer.entity';
import { Delivery } from '../delivery/entities/delivery.entity';
import { Order } from '../order/entities/order.entity';
import { FcmPort } from '../firebase/ports/fcm.port';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('NotificationService');

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,

    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,

    private readonly fcm: FcmPort,
  ) {}

  async sendTestNotification(token: string, title: string, body: string) {
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
      this.logger.error(`Error sending test notification: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async sendOrderConfirmation(
    customerId: string,
    orderId: string,
    token?: string,
  ) {
    try {
      // Buscar al cliente
      const customer = await this.customerRepository.findOne({
        where: { user_id: customerId },
        relations: ['user'],
      });

      if (!customer || !customer.user) {
        this.logger.warn(`Customer not found: ${customerId}`);
        return { success: false, error: 'Customer not found' };
      }

      // Usar token del cliente o el proporcionado
      const notificationToken = token || customer.notification_token;

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
      this.logger.error(`Error sending order confirmation: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async sendOrderStatusUpdate(
    customer: User,
    order: Order,
    notificationToken?: string,
  ) {
    try {
      const token = notificationToken || customer.customer?.notification_token;

      if (!token) {
        return { success: false, error: 'No notification token' };
      }

      const statusMessages = {
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
      this.logger.error(`Error sending status notification: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async getUserNotificationTokens(userId: string) {
    try {
      const customer = await this.customerRepository.findOne({
        where: { user_id: userId },
      });

      if (!customer) {
        return { tokens: [] };
      }

      return {
        tokens: customer.notification_token
          ? [customer.notification_token]
          : [],
      };
    } catch (error) {
      this.logger.error(`Error getting user tokens: ${error.message}`);
      return { tokens: [] };
    }
  }

  /**
   * Guarda el token FCM del dispositivo. El mismo endpoint lo usan la app
   * cliente y la app chofer, así que buscamos el `userId` primero como Customer
   * y, si no está, como Delivery (el chofer). Así el push le puede llegar a
   * cualquiera de los dos lados.
   */
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
      const delivery = await this.deliveryRepository.findOne({
        where: { user_id: driverUserId },
      });
      const token = delivery?.notification_token;
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
    } catch (error: any) {
      this.logger.warn(
        `No se pudo enviar push de oferta al chofer ${driverUserId}: ${error?.message}`,
      );
    }
  }

  async saveNotificationToken(userId: string, token: string, platform: string) {
    try {
      const customer = await this.customerRepository.findOne({
        where: { user_id: userId },
      });

      if (customer) {
        customer.notification_token = token;
        await this.customerRepository.save(customer);
        this.logger.log(
          `Token FCM guardado (cliente ${userId}, ${platform})`,
        );
        return { success: true };
      }

      const delivery = await this.deliveryRepository.findOne({
        where: { user_id: userId },
      });

      if (delivery) {
        delivery.notification_token = token;
        await this.deliveryRepository.save(delivery);
        this.logger.log(
          `Token FCM guardado (chofer ${userId}, ${platform})`,
        );
        return { success: true };
      }

      this.logger.warn(`Usuario no encontrado para token FCM: ${userId}`);
      return { success: false, error: 'User not found' };
    } catch (error) {
      this.logger.error(`Error saving notification token: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
