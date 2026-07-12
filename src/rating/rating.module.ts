import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RatingService } from './rating.service';
import { RatingController } from './rating.controller';
import { Rating } from './entities/rating.entity';
import { Order } from '../order/entities/order.entity';
import { Delivery } from '../delivery/entities/delivery.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Rating, Order, Delivery])],
  controllers: [RatingController],
  providers: [RatingService],
  exports: [RatingService],
})
export class RatingModule {}
