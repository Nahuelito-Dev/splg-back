import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CarController } from './car.controller';
import { CarService } from './car.service';
import { Car } from './entities/car.entity';
import { DeliveryModule } from '../delivery/delivery.module';

@Module({
  // DeliveryService: el dueño del vehículo es un chofer de la misma
  // distribuidora.
  imports: [TypeOrmModule.forFeature([Car]), DeliveryModule],
  controllers: [CarController],
  providers: [CarService],
  exports: [CarService],
})
export class CarModule {}
