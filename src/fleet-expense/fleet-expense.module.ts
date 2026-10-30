import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { AttachmentModule } from '../attachment/attachment.module';
import { CarModule } from '../car/car.module';
import { CashModule } from '../cash/cash.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { DistributorModule } from '../distributor/distributor.module';
import { EmailModule } from '../email/email.module';
import { EmployeeModule } from '../employee/employee.module';
import { FleetModule } from '../fleet/fleet.module';
import { CarFleetController } from './car-fleet.controller';
import { DriverContextService } from './driver-context.service';
import { FineDueAlertsCron } from './fine-due-alerts.cron';
import { FleetCostService } from './fleet-cost.service';
import {
  FuelLoadAttachmentOwnerResolver,
  TrafficFineAttachmentOwnerResolver,
  TrafficFinePaymentAttachmentOwnerResolver,
  VehicleAccidentAttachmentOwnerResolver,
} from './fleet-expense-attachment-owners';
import { FleetExpenseNotifierListener } from './fleet-expense-notifier.listener';
import { FuelLoad } from './entities/fuel-load.entity';
import { FuelLoadController } from './fuel-load.controller';
import { FuelLoadService } from './fuel-load.service';
import { TireEvent } from './entities/tire-event.entity';
import { Tire } from './entities/tire.entity';
import { TireController } from './tire.controller';
import { TireService } from './tire.service';
import { TrafficFine } from './entities/traffic-fine.entity';
import { TrafficFineController } from './traffic-fine.controller';
import { TrafficFinePaymentService } from './traffic-fine-payment.service';
import { TrafficFineV2Controller } from './traffic-fine-v2.controller';
import { TrafficFineService } from './traffic-fine.service';
import { VehicleAccident } from './entities/vehicle-accident.entity';
import { VehicleAccidentController } from './vehicle-accident.controller';
import { VehicleAccidentService } from './vehicle-accident.service';

/**
 * Flota ampliada (iteración C-18): combustible, multas, siniestros,
 * neumáticos y el costo total por vehículo. Aparte de `fleet`, que es
 * mantenimiento y habilitaciones: este módulo registra lo que cuesta mantener
 * la flota y se apoya en `fleet` sólo para leer sus costos.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      FuelLoad,
      TrafficFine,
      VehicleAccident,
      Tire,
      TireEvent,
    ]),
    CarModule, // vehículos, kilometraje, estado de flota y asignaciones
    FleetModule, // costos de mantenimiento y seguros
    EmployeeModule, // legajo del responsable
    DeliveryModule, // el chofer detrás de una cuenta
    AdminModule, // a quién avisa el aviso de siniestros y combustible
    EmailModule, // cómo avisa
    DistributorModule, // a qué hora avisa cada distribuidora
    AttachmentModule, // dueños de adjuntos: comprobante, acta, fotos
    CashModule, // el pago en efectivo de combustible y multas sale de una caja
  ],
  controllers: [
    FuelLoadController,
    TrafficFineController,
    TrafficFineV2Controller,
    VehicleAccidentController,
    TireController,
    CarFleetController,
  ],
  providers: [
    DriverContextService,
    FuelLoadService,
    TrafficFineService,
    TrafficFinePaymentService,
    VehicleAccidentService,
    TireService,
    FleetCostService,
    FineDueAlertsCron,
    FleetExpenseNotifierListener,
    FuelLoadAttachmentOwnerResolver,
    TrafficFineAttachmentOwnerResolver,
    TrafficFinePaymentAttachmentOwnerResolver,
    VehicleAccidentAttachmentOwnerResolver,
  ],
  exports: [
    FuelLoadService,
    TrafficFineService,
    VehicleAccidentService,
    TireService,
    FleetCostService,
  ],
})
export class FleetExpenseModule {}
