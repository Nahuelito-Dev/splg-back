import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { OrderItem } from '../order/entities/order-item.entity';
import Decimal from 'decimal.js';

@Injectable()
export class ReportsService {
    constructor(
        @InjectRepository(Order)
        private readonly orderRepository: Repository<Order>,
        @InjectRepository(OrderItem)
        private readonly orderItemRepository: Repository<OrderItem>,
    ) { }

    async getSalesByDriver(startDate: Date, endDate: Date) {
        const orders = await this.orderRepository.find({
            where: {
                status: OrderStatus.DELIVERED,
                deliveredAt: Between(startDate, endDate),
            },
            relations: ['delivery', 'delivery.user'],
        });

        const report = {};

        for (const order of orders) {
            if (!order.delivery || !order.delivery.user) continue;

            const driverName = order.delivery.user.full_name;
            const driverId = order.delivery.user_id; // Using user_id as key

            if (!report[driverId]) {
                report[driverId] = {
                    driverId,
                    driverName,
                    totalOrders: 0,
                    totalSales: new Decimal(0),
                };
            }

            report[driverId].totalOrders++;
            report[driverId].totalSales = report[driverId].totalSales.plus(order.totalAmount);
        }

        // Convert Decimals to numbers for JSON response
        return Object.values(report).map((entry: any) => ({
            ...entry,
            totalSales: entry.totalSales.toNumber()
        }));
    }

    async getSalesByProduct(startDate: Date, endDate: Date) {
        // We need to query order items for delivered orders in the range
        const result = await this.orderRepository.createQueryBuilder('order')
            .innerJoinAndSelect('order.items', 'item')
            .innerJoinAndSelect('item.gasCylinder', 'product')
            .where('order.status = :status', { status: OrderStatus.DELIVERED })
            .andWhere('order.deliveredAt BETWEEN :start AND :end', { start: startDate, end: endDate })
            .select([
                'product.type AS productType',
                'product.description AS description',
                'SUM(item.quantity) AS totalQuantity',
                'SUM(item.subtotal) AS totalSales'
            ])
            .groupBy('product.type')
            .addGroupBy('product.description')
            .getRawMany();

        return result.map(row => ({
            productType: row.productType,
            description: row.description,
            totalQuantity: Number(row.totalQuantity),
            totalSales: Number(row.totalSales)
        }));
    }

    async getSalesByPaymentMethod(startDate: Date, endDate: Date) {
        const result = await this.orderRepository.createQueryBuilder('order')
            .select('order.paymentMethod', 'method')
            .addSelect('COUNT(order.order_id)', 'count')
            .addSelect('SUM(order.totalAmount)', 'total')
            .where('order.status = :status', { status: OrderStatus.DELIVERED })
            .andWhere('order.deliveredAt BETWEEN :start AND :end', { start: startDate, end: endDate })
            .groupBy('order.paymentMethod')
            .getRawMany();

        return result.map(row => ({
            method: row.method,
            totalOrders: Number(row.count),
            totalSales: Number(row.total)
        }));
    }
}
