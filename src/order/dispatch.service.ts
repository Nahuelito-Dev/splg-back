import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderService } from './order.service';
import { OrderStatus } from './entities/order.entity';
import { RedisService } from '../redis/redis.service';
import { DriversGateway } from '../gateways/drivers.gateway';

@Injectable()
export class DispatchService {
    private readonly logger = new Logger(DispatchService.name);

    constructor(
        private readonly orderService: OrderService,
        private readonly redisService: RedisService,
        private readonly driversGateway: DriversGateway,
    ) { }

    @Cron(CronExpression.EVERY_MINUTE)
    async handlePendingOrders() {
        // Distributed lock: en multi-instancia (varios pods), solo uno
        // ejecuta el cron por intervalo. TTL = 55s, menor al período de
        // 60s, para que si crashea sin liberar, expire antes del próximo tick.
        const lock = await this.redisService.acquireLock('dispatch:pending', 55000);
        if (!lock) {
            this.logger.debug('🔒 Otra instancia tiene el lock — skip ciclo');
            return;
        }

        try {
            this.logger.debug('🔎 Buscando pedidos pendientes para reprocesar...');

            const { orders } = await this.orderService.findAvailableOrders({ limit: 50, offset: 0 });
            const now = new Date();
            const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);

            for (const order of orders) {
                // Ignorar pedidos creados hace menos de 2 minutos (para no spammear al inicio)
                if (new Date(order.createdAt) > twoMinutesAgo) {
                    continue;
                }

                this.logger.log(`🔄 Procesando Pedido Pendiente (Retry): ${order.order_id}`);

                // 2. Buscar choferes nuevamente - Radio expandido a 15km
                const nearbyDrivers = await this.redisService.getNearbyDrivers(
                    Number(order.deliveryLatitude),
                    Number(order.deliveryLongitude),
                    15
                );

                if (nearbyDrivers.length > 0) {
                    this.logger.log(`Found ${nearbyDrivers.length} drivers for retry of order ${order.order_id}`);
                    const driverPayload = {
                        event: 'NEW_ORDER_RETRY',
                        orderId: order.order_id,
                        totalAmount: order.totalAmount,
                        paymentMethod: order.paymentMethod,
                        distance: 'Reintento de asignación (Zona ampliada)',
                        items: order.items,
                    };

                    for (const driverId of nearbyDrivers) {
                        this.driversGateway.notifyNewOrder(driverId, driverPayload);
                    }
                }
            }
        } finally {
            // Liberar el lock. Si ya expiró por TTL, release() lanza —
            // lo ignoramos porque el efecto deseado (no overlap) está garantizado.
            await lock.release().catch(() => undefined);
        }
    }
}
