// src/order/order.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { User } from '../users/entities/user.entity';
import { Delivery } from '../delivery/entities/delivery.entity';
import { UserAddress } from '../user-addres/entities/user-addres.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Customer } from '../customer/entities/customer.entity';

import { GatewaysModule } from '../gateways/gateways.module';
import { RedisModule } from '../redis/redis.module'; // 👈 Importar
import { DispatchService } from './dispatch.service';
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      GasCylinder,
      User,
      Delivery,
      UserAddress,
      Customer,
    ]),
    NotificationsModule,
    GatewaysModule,
    RedisModule, // 👈 AGREGAR ESTO AQUÍ
  ],
  controllers: [OrderController],
  providers: [OrderService, DispatchService],
  exports: [OrderService],
})
export class OrderModule { }
