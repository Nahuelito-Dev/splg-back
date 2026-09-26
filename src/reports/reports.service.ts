import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { OrderItem } from '../order/entities/order-item.entity';
import Decimal from 'decimal.js';
import {
  EvolucionDeVentasDto,
  VentasPorChoferDto,
  VentasPorMedioDePagoDto,
  VentasPorProductoDto,
} from './dto/report-response.dto';

/** Una fila de getRawMany: las claves son las que devuelve Postgres. */
type Fila = Record<string, unknown>;

/** Number() de un valor de fila; NaN sale como null en el JSON. */
function numero(valor: unknown): number {
  return Number(valor);
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
  ) {}

  /**
   * `distributorId` opcional: si viene (admin de distribuidora), acota el
   * reporte a SUS pedidos. `null`/`undefined` (super_admin sin header) →
   * sin filtro, ve todas las distribuidoras.
   */
  async getSalesByDriver(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ): Promise<VentasPorChoferDto[]> {
    const orders = await this.orderRepository.find({
      where: {
        status: OrderStatus.DELIVERED,
        deliveredAt: Between(startDate, endDate),
        ...(distributorId ? { distributorId } : {}),
      },
      // Historial: el chofer, el cliente o la dirección dados de baja siguen
      // apareciendo en lo que ya pasó (H-74).
      withDeleted: true,
      relations: ['delivery', 'delivery.user'],
    });

    const report: Record<
      string,
      {
        driverId: string;
        driverName: string | undefined;
        totalOrders: number;
        totalSales: Decimal;
      }
    > = {};

    for (const order of orders) {
      if (!order.delivery || !order.delivery.user) continue;

      const driverName = order.delivery.user.fullName;
      const driverId = order.delivery.userId; // Using user_id as key

      if (!report[driverId]) {
        report[driverId] = {
          driverId,
          driverName,
          totalOrders: 0,
          totalSales: new Decimal(0),
        };
      }

      report[driverId].totalOrders++;
      report[driverId].totalSales = report[driverId].totalSales.plus(
        order.totalAmount,
      );
    }

    // Los Decimal se convierten a número para el JSON.
    return Object.values(report).map((entry) => ({
      ...entry,
      totalSales: entry.totalSales.toNumber(),
    }));
  }

  async getSalesByProduct(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ): Promise<VentasPorProductoDto[]> {
    // We need to query order items for delivered orders in the range
    const query = this.orderRepository
      .createQueryBuilder('order')
      .innerJoinAndSelect('order.items', 'item')
      .innerJoinAndSelect('item.gasCylinder', 'product')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('order.deliveredAt BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      });

    // Sólo filtramos por tenant si vino distributorId (super_admin ve todo).
    if (distributorId) {
      query.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }

    // select(expresión, alias) entrecomilla el alias: sin eso Postgres lo pasa
    // a minúsculas y productType, totalQuantity y totalSales llegaban vacíos
    // (H-56).
    const result = await query
      .select('product.type', 'productType')
      .addSelect('product.description', 'description')
      .addSelect('SUM(item.quantity)', 'totalQuantity')
      .addSelect('SUM(item.subtotal)', 'totalSales')
      .groupBy('product.type')
      .addGroupBy('product.description')
      .getRawMany<Fila>();

    return result.map((row) => ({
      productType: String(row['productType']),
      description: (row['description'] as string | undefined) ?? null,
      totalQuantity: numero(row['totalQuantity']),
      totalSales: numero(row['totalSales']),
    }));
  }

  async getSalesByPaymentMethod(
    startDate: Date,
    endDate: Date,
    distributorId?: string | null,
  ): Promise<VentasPorMedioDePagoDto[]> {
    const query = this.orderRepository
      .createQueryBuilder('order')
      .select('order.paymentMethod', 'method')
      .addSelect('COUNT(order.orderId)', 'count')
      .addSelect('SUM(order.totalAmount)', 'total')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('order.deliveredAt BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      });

    if (distributorId) {
      query.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }

    const result = await query
      .groupBy('order.paymentMethod')
      .getRawMany<Fila>();

    return result.map((row) => ({
      method: String(row['method']),
      totalOrders: numero(row['count']),
      totalSales: numero(row['total']),
    }));
  }

  /**
   * Evolución temporal de ventas (pedidos entregados) agrupada por día o mes,
   * usando `date_trunc` de Postgres sobre `deliveredAt`. Devuelve los períodos
   * ordenados cronológicamente, listos para un gráfico de líneas/barras en el
   * panel. `granularity` = 'day' | 'month'.
   */
  async getSalesEvolution(
    startDate: Date,
    endDate: Date,
    granularity: 'day' | 'month',
    distributorId?: string | null,
  ): Promise<EvolucionDeVentasDto[]> {
    const trunc = granularity === 'month' ? 'month' : 'day';

    const query = this.orderRepository
      .createQueryBuilder('order')
      .select(`date_trunc('${trunc}', order.deliveredAt)`, 'period')
      .addSelect('COUNT(order.orderId)', 'count')
      .addSelect('SUM(order.totalAmount)', 'total')
      .where('order.status = :status', { status: OrderStatus.DELIVERED })
      .andWhere('order.deliveredAt BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      });

    if (distributorId) {
      query.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }

    const result = await query
      .groupBy('period')
      .orderBy('period', 'ASC')
      .getRawMany<Fila>();

    return result.map((row) => ({
      period: row['period'] as Date,
      totalOrders: numero(row['count']),
      totalSales: numero(row['total']),
    }));
  }
}
