import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeSlotService } from './time-slot.service';
import { TimeSlotController } from './time-slot.controller';
import { TimeSlot } from './entities/time-slot.entity';
import { Order } from '../order/entities/order.entity';

@Module({
    imports: [TypeOrmModule.forFeature([TimeSlot, Order])],
    controllers: [TimeSlotController],
    providers: [TimeSlotService],
    exports: [TimeSlotService],
})
export class TimeSlotModule { }
