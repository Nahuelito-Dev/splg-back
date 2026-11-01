import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Order } from '../entities/order.entity';

/**
 * Libera la retención de un pedido por una alerta de fraude de Mercado Pago
 * (`order.payment_fraud_hold`). Decide un administrador, con motivo obligatorio; el
 * cambio lo asientan los triggers de auditoría (el actor sale del request) y quedan
 * quién, cuándo y por qué en el propio pedido. Una reserva liberada vuelve a poder
 * activarse el día agendado; un pedido, a ofrecerse a los choferes.
 */
@Injectable()
export class OrderFraudHoldService {
  private readonly logger = new Logger(OrderFraudHoldService.name);

  constructor(private readonly dataSource: DataSource) {}

  async liberar(
    orderId: string,
    distributorId: string,
    userId: string,
    reason: string,
  ): Promise<{ orderId: string; paymentFraudHold: false }> {
    const motivo = reason.trim();
    await this.dataSource.transaction(async (manager) => {
      const pedido = await manager
        .createQueryBuilder(Order, 'order')
        .setLock('pessimistic_write')
        .where('order.orderId = :id', { id: orderId })
        .andWhere('order.distributorId = :distributorId', { distributorId })
        .getOne();
      if (!pedido) {
        throw new NotFoundException(`Order with ID: ${orderId} not found`);
      }
      if (!pedido.paymentFraudHold) {
        throw new ConflictException('El pedido no está retenido por fraude');
      }
      pedido.paymentFraudHold = false;
      pedido.paymentFraudReleasedAt = new Date();
      pedido.paymentFraudReleasedBy = userId;
      pedido.paymentFraudReleasedReason = motivo;
      await manager.save(pedido);
    });
    this.logger.warn(
      `Retención por fraude del pedido ${orderId} liberada por ${userId}`,
    );
    return { orderId, paymentFraudHold: false };
  }
}
