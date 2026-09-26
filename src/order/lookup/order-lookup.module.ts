import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../entities/order.entity';
import { OrderLookupService } from './order-lookup.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order])],
  providers: [OrderLookupService],
  exports: [OrderLookupService],
})
export class OrderLookupModule {}
