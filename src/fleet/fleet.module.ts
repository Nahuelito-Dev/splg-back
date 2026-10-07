import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MaintenancePlan } from './entities/maintenance-plan.entity';
import { MaintenanceTask } from './entities/maintenance-task.entity';
import { MaintenanceWindowProposal } from './entities/maintenance-window-proposal.entity';
import { VehicleUsageLog } from './entities/vehicle-usage-log.entity';
import { MaintenanceTaskAttachment } from './entities/maintenance-task-attachment.entity';
import { CarModule } from '../car/car.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { AdminModule } from '../admin/admin.module';
import { EmailModule } from '../email/email.module';
import { S3Module } from '../s3/s3.module';
import { FleetPlanController } from './fleet-plan.controller';
import { FleetTaskController } from './fleet-task.controller';
import { FleetExpirationsController } from './fleet-expirations.controller';
import { CarDocumentsController } from './car-documents.controller';
import { DeliveryDocumentsController } from './delivery-documents.controller';
import { DeliveryVehicleController } from './delivery-vehicle.controller';
import { CarAssignmentsController } from './car-assignments.controller';
import { FleetPlanService } from './fleet-plan.service';
import { FleetTaskService } from './fleet-task.service';
import { FleetDispatchLockService } from './fleet-dispatch-lock.service';
import { FleetAttachmentService } from './fleet-attachment.service';
import { FleetExpirationsService } from './fleet-expirations.service';
import { FleetPlanSeedListener } from './fleet-plan-seed.listener';
import { FleetAlertsCron } from './fleet-alerts.cron';

/**
 * Flota: planes de mantenimiento/habilitación y sus tareas (CU-136 a CU-142).
 * `maintenance_window_proposal` es del módulo inteligente M1 (no
 * implementado todavía: sólo la entidad, sin servicio ni controller).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MaintenancePlan,
      MaintenanceTask,
      MaintenanceWindowProposal,
      VehicleUsageLog,
      MaintenanceTaskAttachment,
    ]),
    CarModule, // el dueño de "el vehículo existe y es de esta distribuidora"
    DeliveryModule, // ídem para "el chofer existe y es de esta distribuidora"
    AdminModule, // a quién avisar (FleetAlertsCron)
    EmailModule, // cómo avisar (FleetAlertsCron, vía EmailSenderPort)
    S3Module, // dónde viven los adjuntos
  ],
  controllers: [
    FleetPlanController,
    FleetTaskController,
    FleetExpirationsController,
    CarDocumentsController,
    DeliveryDocumentsController,
    DeliveryVehicleController,
    CarAssignmentsController,
  ],
  providers: [
    FleetPlanService,
    FleetTaskService,
    FleetDispatchLockService,
    FleetAttachmentService,
    FleetExpirationsService,
    FleetPlanSeedListener,
    FleetAlertsCron,
  ],
  // FleetTaskService: fachadas de sólo lectura de la flota (`/cars/:id/documents`,
  // `/fleet/*`). FleetDispatchLockService: el gate único de bloqueo que usa
  // `OrderModule` en los tres caminos de asignación (CU-136 a CU-138).
  exports: [FleetTaskService, FleetDispatchLockService],
})
export class FleetModule {}
