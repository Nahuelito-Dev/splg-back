import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeSlotService } from './time-slot.service';
import { TimeSlotController } from './time-slot.controller';
import { TimeSlot } from './entities/time-slot.entity';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';

@Module({
  // El cupo de una franja se cuenta sobre los pedidos, dentro de la
  // transacción del alta de pedido. Se leen por OrderLookupModule y no por
  // OrderModule, que importa a time-slot para reservar la franja.
  imports: [TypeOrmModule.forFeature([TimeSlot]), OrderLookupModule],
  controllers: [TimeSlotController],
  providers: [TimeSlotService],
  exports: [TimeSlotService],
})
export class TimeSlotModule {}
