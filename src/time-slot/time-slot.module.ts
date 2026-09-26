import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeSlotService } from './time-slot.service';
import { TimeSlotController } from './time-slot.controller';
import { TimeSlot } from './entities/time-slot.entity';
import { Order } from '../order/entities/order.entity';

@Module({
  // Order: el cupo de una franja se cuenta sobre los pedidos, dentro de la
  // transacción del alta de pedido. Pasa a order en la tanda 3 (ver
  // DONDE-QUEDAMOS): order cuenta sus pedidos y time-slot aporta la franja.
  imports: [TypeOrmModule.forFeature([TimeSlot, Order])],
  controllers: [TimeSlotController],
  providers: [TimeSlotService],
  exports: [TimeSlotService],
})
export class TimeSlotModule {}
