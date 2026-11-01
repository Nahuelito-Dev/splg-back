import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { dec } from '../../common/utils/dinero';
import { CustomerPurchaseStatsDto } from '../dto/customer-purchase-stats.dto';

interface FilaDeEstadisticas {
  total_purchased: string;
  orders_count: number;
  delivered_count: number;
  average_ticket: string | null;
  last_delivered_at: Date | null;
}

/**
 * Estadísticas de compra de un cliente en una distribuidora (panel, ficha del
 * cliente). Las suma y promedia la base sobre TODOS sus pedidos de esa
 * distribuidora, no sobre la página que se haya traído.
 */
@Injectable()
export class CustomerPurchaseStatsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** `customerId` es el `user_id` del cliente, igual que `order.customer_id`. */
  async estadisticas(
    customerId: string,
    distributorId: string,
  ): Promise<CustomerPurchaseStatsDto> {
    const [fila]: FilaDeEstadisticas[] = await this.dataSource.query(
      `SELECT COALESCE(SUM("totalAmount") FILTER (WHERE "status" = 'delivered'), 0)::text AS total_purchased,
              COUNT(*)::int AS orders_count,
              (COUNT(*) FILTER (WHERE "status" = 'delivered'))::int AS delivered_count,
              ROUND(AVG("totalAmount") FILTER (WHERE "status" = 'delivered'), 2)::text AS average_ticket,
              MAX("deliveredAt") FILTER (WHERE "status" = 'delivered') AS last_delivered_at
       FROM "order"
       WHERE "customer_id" = $1 AND "distributor_id" = $2`,
      [customerId, distributorId],
    );
    const dto = new CustomerPurchaseStatsDto();
    dto.totalPurchased = dec(fila.total_purchased).toNumber();
    dto.ordersCount = fila.orders_count;
    dto.deliveredCount = fila.delivered_count;
    dto.averageTicket =
      fila.average_ticket === null ? null : dec(fila.average_ticket).toNumber();
    dto.lastDeliveredAt = fila.last_delivered_at;
    return dto;
  }
}
