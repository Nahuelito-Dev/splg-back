import { Module, OnModuleInit } from '@nestjs/common';
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
import { EmployeeModule } from '../employee/employee.module';
import { EmployeeRulesRegistry } from '../employee/employee-rules.registry';
import { LeaveModule } from '../leave/leave.module';
import { EmployeeDocumentsController } from './employee-documents.controller';
import { EmployeeDocumentsService } from './employee-documents.service';
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
import { FleetCostSourceService } from './fleet-cost-source.service';
import { FleetInsuranceSyncService } from './fleet-insurance-sync.service';
import { FleetVehicleStatusService } from './fleet-vehicle-status.service';
import { CarReactivationController } from './car-reactivation.controller';

/**
 * Flota: planes de mantenimiento/habilitación y sus tareas (CU-136 a CU-142),
 * y la documentación del personal que cuelga de ellos (CU-183 a CU-185, CU-187,
 * CU-188, CU-246).
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
    EmployeeModule, // el dueño de la documentación del personal (CU-183 a CU-185)
    LeaveModule, // licencias aprobadas: inhabilitan al chofer (CU-246)
  ],
  controllers: [
    FleetPlanController,
    FleetTaskController,
    FleetExpirationsController,
    CarDocumentsController,
    DeliveryDocumentsController,
    DeliveryVehicleController,
    CarAssignmentsController,
    EmployeeDocumentsController,
    CarReactivationController,
  ],
  providers: [
    FleetPlanService,
    FleetTaskService,
    FleetDispatchLockService,
    FleetAttachmentService,
    FleetExpirationsService,
    FleetPlanSeedListener,
    FleetAlertsCron,
    EmployeeDocumentsService,
    FleetCostSourceService,
    FleetVehicleStatusService,
    FleetInsuranceSyncService,
  ],
  // FleetTaskService: fachadas de sólo lectura de la flota (`/cars/:id/documents`,
  // `/fleet/*`). FleetDispatchLockService: el gate único de bloqueo que usa
  // `OrderModule` en los tres caminos de asignación (CU-136 a CU-138).
  exports: [
    FleetTaskService,
    FleetDispatchLockService,
    EmployeeDocumentsService, // el tablero de personal cuenta los documentos por estado
    FleetCostSourceService,
    FleetInsuranceSyncService, // el alta de una póliza deja el seguro del vehículo con su vencimiento
  ],
})
export class FleetModule implements OnModuleInit {
  constructor(private readonly rules: EmployeeRulesRegistry) {}

  /** Un legajo con documentación cargada no es un alta errónea: corresponde el egreso. */
  onModuleInit(): void {
    this.rules.alDarDeBaja(async (manager, empleado) =>
      (await manager
        .getRepository(MaintenanceTask)
        .exists({ where: { employeeId: empleado.employeeId } }))
        ? ['tiene documentación cargada']
        : [],
    );
  }
}
