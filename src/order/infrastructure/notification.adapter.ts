import { Injectable } from '@nestjs/common';
import {
  DesgloseDelEfectivo,
  EfectivoDeSalida,
} from '../domain/efectivo-a-cobrar';
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

  sendOrderConfirmation(
    customerId: string,
    orderId: string,
    token?: string,
    efectivo?: DesgloseDelEfectivo | null,
  ) {
    return this.notifications.sendOrderConfirmation(
      customerId,
      orderId,
      token,
      efectivo,
    );
  }

  sendCashReadyPush(
    customerId: string,
    orderId: string,
    efectivo: EfectivoDeSalida,
  ) {
    return this.notifications.sendCashReadyPush(customerId, orderId, efectivo);
  }

  sendArrivalPushToCustomer(
    customerId: string,
    orderId: string,
    driverName: string,
  ) {
    return this.notifications.sendArrivalPushToCustomer(
      customerId,
      orderId,
      driverName,
    );
  }

  sendPaymentApprovedPush(customerId: string, orderId: string, esSena = false) {
    return this.notifications.sendPaymentApprovedPush(
      customerId,
      orderId,
      esSena,
    );
  }

  sendOrderNoticePush(
    customerId: string,
    orderId: string,
    aviso: { title: string; body: string; event: string },
  ) {
    return this.notifications.sendOrderNoticePush(customerId, orderId, aviso);
  }
}
