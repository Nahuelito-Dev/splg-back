import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DeliveryService } from '../../delivery/delivery.service';
import { OrderItem } from '../entities/order-item.entity';
import { Order, OrderStatus } from '../entities/order.entity';
import { DeclareEmptiesDto } from '../dto/declare-empties.dto';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';

/** Declara las vacías que el chofer recibió antes de confirmar una entrega. */
@Injectable()
export class DeclareEmptiesUseCase {
  constructor(
    private readonly dataSource: DataSource,
    private readonly deliveries: DeliveryService,
    private readonly orders: OrderRepositoryPort,
  ) {}

  async execute(
    orderId: string,
    driverUserId: string,
    distributorId: string | null,
    body: DeclareEmptiesDto,
  ): Promise<Order> {
    await this.dataSource.transaction(async (manager) => {
      const order = await manager
        .createQueryBuilder(Order, 'ord')
        .setLock('pessimistic_write')
        .where('ord.orderId = :orderId', { orderId })
        .getOne();
      if (!order || (distributorId && order.distributorId !== distributorId)) {
        throw new NotFoundException('Pedido no encontrado');
      }
      const driver = await this.deliveries.buscarPorIdOUsuario(driverUserId);
      if (!driver || driver.deliveryId !== order.deliveryId) {
        throw new ForbiddenException(
          'Este pedido no está asignado a tu usuario',
        );
      }
      if (order.status !== OrderStatus.ON_THE_WAY) {
        throw new ConflictException('El pedido no está en camino');
      }

      const items = await manager.find(OrderItem, { where: { orderId } });
      const byCylinder = new Map(
        items.map((item) => [item.gasCylinderId, item]),
      );
      for (const declared of body.items) {
        const item = byCylinder.get(declared.gasCylinderId);
        if (!item) {
          throw new BadRequestException(
            'El tipo de envase no está en el pedido',
          );
        }
        const expected = item.quantity - item.containersCharged;
        if (declared.emptiesReceived > expected) {
          throw new BadRequestException(
            'Las vacías recibidas están fuera de rango',
          );
        }
        item.emptiesReceived = declared.emptiesReceived;
      }
      await manager.save(items);
    });
    const complete = await this.orders.findByIdFull(orderId);
    if (!complete) throw new NotFoundException('Pedido no encontrado');
    return complete;
  }
}
