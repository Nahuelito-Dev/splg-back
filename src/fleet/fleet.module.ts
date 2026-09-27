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
import { StorageModule } from '../storage/storage.module';
import { FleetPlanController } from './fleet-plan.controller';
import { FleetTaskController } from './fleet-task.controller';
import { FleetExpirationsController } from './fleet-expirations.controller';
import { CarDocumentsController } from './car-documents.controller';
import { DeliveryDocumentsController } from './delivery-documents.controller';
import { FleetPlanService } from './fleet-plan.service';
import { FleetTaskService } from './fleet-task.service';
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
    StorageModule, // dónde viven los adjuntos (disco local o S3)
  ],
  controllers: [
    FleetPlanController,
    FleetTaskController,
    FleetExpirationsController,
    CarDocumentsController,
    DeliveryDocumentsController,
  ],
  providers: [
    FleetPlanService,
    FleetTaskService,
    FleetAttachmentService,
    FleetExpirationsService,
    FleetPlanSeedListener,
    FleetAlertsCron,
  ],
  // FleetTaskService: para cuando `order`/`delivery` apliquen el bloqueo al
  // despacho (ver el informe de esta tarea para el punto de enganche exacto).
  exports: [FleetTaskService],
})
export class FleetModule {}
