import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CarController } from './car.controller';
import { CarService } from './car.service';
import { VehicleAssignmentService } from './vehicle-assignment.service';
import { VehicleReleaseOnBajaListener } from './vehicle-release-on-baja.listener';
import { Car } from './entities/car.entity';
import { VehicleAssignment } from './entities/vehicle-assignment.entity';
import { DeliveryModule } from '../delivery/delivery.module';

@Module({
  // DeliveryService: el dueño del vehículo es un chofer de la misma
  // distribuidora, y a quién se le asigna/libera un vehículo en uso.
  imports: [TypeOrmModule.forFeature([Car, VehicleAssignment]), DeliveryModule],
  controllers: [CarController],
  providers: [
    CarService,
    VehicleAssignmentService,
    VehicleReleaseOnBajaListener,
  ],
  // VehicleAssignmentService: lo usa `fleet` (gate de despacho por vehículo
  // en uso, y las fachadas HTTP de `/delivery/:id/vehicle*` y
  // `/car/:id/assignments`, que viven ahí igual que las de documentos).
  exports: [CarService, VehicleAssignmentService],
})
export class CarModule {}
