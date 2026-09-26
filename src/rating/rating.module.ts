import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RatingService } from './rating.service';
import { RatingController } from './rating.controller';
import { Rating } from './entities/rating.entity';
import { OrderModule } from '../order/order.module';
import { DeliveryModule } from '../delivery/delivery.module';

@Module({
  // OrderService para el pedido calificado y DeliveryService para el chofer y
  // su promedio: el módulo sólo es dueño de las calificaciones.
  imports: [TypeOrmModule.forFeature([Rating]), OrderModule, DeliveryModule],
  controllers: [RatingController],
  providers: [RatingService],
  exports: [RatingService],
})
export class RatingModule {}
