import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { Order } from '../order/entities/order.entity';
import { OrderItem } from '../order/entities/order-item.entity';

@Module({
    imports: [TypeOrmModule.forFeature([Order, OrderItem])],
    controllers: [ReportsController],
    providers: [ReportsService],
})
export class ReportsModule { }
