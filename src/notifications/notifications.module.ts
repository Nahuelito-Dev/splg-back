import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { CustomersModule } from '../customer/customer.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';

@Module({
  // Los tokens push son de clientes y choferes: se leen y guardan por sus
  // servicios. FcmPort llega del FirebaseModule, que es global.
  imports: [CustomersModule, DeliveryModule, OrderLookupModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
