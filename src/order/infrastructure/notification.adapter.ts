import { Injectable } from '@nestjs/common';
import { NotificationPort } from '../domain/ports/notification.port';
import { NotificationsService } from '../../notifications/notifications.service';

/**
 * Adapter del puerto NotificationPort: implementa "avisale al cliente"
 * delegando en NotificationsService (importado por OrderModule vía
 * NotificationsModule). Mantiene los use-cases del pedido desacoplados del
 * service concreto de notificaciones (que a su vez conoce Firebase).
 */
@Injectable()
export class NotificationAdapter extends NotificationPort {
  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  sendOrderConfirmation(customerId: string, orderId: string, token?: string) {
    return this.notifications.sendOrderConfirmation(customerId, orderId, token);
  }
}
