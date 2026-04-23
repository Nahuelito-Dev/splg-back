// src/notifications/notifications.service.ts - VERSIÓN MEJORADA
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as firebase from 'firebase-admin';
import { serviceAccount } from '../auth/service-account';
import { User } from '../users/entities/user.entity';
import { Customer } from '../customer/entities/customer.entity';
import { Order } from '../order/entities/order.entity';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('NotificationService');
  private adminApp: firebase.app.App;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {
    this.adminApp = firebase.initializeApp(
      {
        credential: firebase.credential.cert(serviceAccount),
      },
      'notification-service',
    );
  }

  async sendTestNotification(token: string, title: string, body: string) {
    try {
      const message = {
        token,
        notification: {
          title,
          body,
        },
        data: {
          type: 'TEST',
          timestamp: new Date().toISOString(),
        },
      };

      const response = await firebase.messaging().send(message);
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
        token: notificationToken,
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

      const response = await firebase.messaging().send(message);
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
        token,
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

      const response = await firebase.messaging().send(message);
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

  async saveNotificationToken(userId: string, token: string, platform: string) {
    try {
      const customer = await this.customerRepository.findOne({
        where: { user_id: userId },
      });

      if (!customer) {
        return { success: false, error: 'Customer not found' };
      }

      customer.notification_token = token;
      await this.customerRepository.save(customer);

      this.logger.log(
        `Notification token saved for user: ${userId}, platform: ${platform}`,
      );
      return { success: true };
    } catch (error) {
      this.logger.error(`Error saving notification token: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
