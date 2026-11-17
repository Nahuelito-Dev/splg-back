import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MaintenancePlan } from './entities/maintenance-plan.entity';
import { MaintenanceTask } from './entities/maintenance-task.entity';
import { MaintenanceWindowProposal } from './entities/maintenance-window-proposal.entity';
import { MaintenancePlanningCase } from './entities/maintenance-planning-case.entity';
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
import { FleetTaskV2Controller } from './fleet-task-v2.controller';
import { CashModule } from '../cash/cash.module';
import { FleetExpirationsController } from './fleet-expirations.controller';
import { CarDocumentsController } from './car-documents.controller';
import { DeliveryDocumentsController } from './delivery-documents.controller';
import { DeliveryVehicleController } from './delivery-vehicle.controller';
import { CarAssignmentsController } from './car-assignments.controller';
import { FleetPlanService } from './fleet-plan.service';
import { FleetTaskService } from './fleet-task.service';
import { FleetTaskBoardService } from './fleet-task-board.service';
import { FleetTaskBoardReader } from './fleet-task-board.reader';
import { FleetTaskBoardNotifier } from './fleet-task-board.notifier';
import { FleetDispatchLockService } from './fleet-dispatch-lock.service';
import { FleetAttachmentService } from './fleet-attachment.service';
import { FleetExpirationsService } from './fleet-expirations.service';
import { FleetPlanSeedListener } from './fleet-plan-seed.listener';
import { FleetAlertsCron } from './fleet-alerts.cron';
import { FleetCostSourceService } from './fleet-cost-source.service';
import { FleetInsuranceSyncService } from './fleet-insurance-sync.service';
import { FleetVehicleStatusService } from './fleet-vehicle-status.service';
import { CarReactivationController } from './car-reactivation.controller';
import { GatewaysModule } from '../gateways/gateways.module';
import { MaintenanceForecastService } from './planner/maintenance-forecast.service';
import { PlannerContextService } from './planner/planner-context.service';
import { MaintenancePlannerService } from './planner/maintenance-planner.service';
import { MaintenancePlannerNotifier } from './planner/maintenance-planner-notifier';
import { MaintenancePlannerCron } from './planner/maintenance-planner.cron';
import { VehicleUsageFeedService } from './planner/vehicle-usage-feed.service';
import { VehicleUsageCron } from './planner/vehicle-usage.cron';
import { PlanningCaseCloser } from './planner/planning-case-closer.service';
import { MaintenancePlannerController } from './planner/maintenance-planner.controller';
import { DriverMaintenanceProposalsController } from './planner/driver-maintenance-proposals.controller';
import { AttachmentModule } from '../attachment/attachment.module';
import { CarDocumentsV2Controller } from './car-documents-v2.controller';
import {
  CarDocumentsService,
  TOPE_DEL_ESCANEO,
  TOPE_DEL_ESCANEO_MS,
} from './car-documents.service';
import { CarDocumentAttachmentOwnerResolver } from './car-document-attachment-owner';

/**
 * Flota: planes de mantenimiento/habilitación y sus tareas (CU-136 a CU-142),
 * y la documentación del personal que cuelga de ellos (CU-183 a CU-185, CU-187,
 * CU-188, CU-246).
 *
 * Planificador de taller (CU-105, módulo inteligente M2) en `planner/`: proyecta
 * los vencimientos con el uso real de cada vehículo, propone al chofer una
 * ventana de taller por vez (`maintenance_window_proposal`, dentro de un
 * `maintenance_planning_case`) y escala al administrador si no hay acuerdo.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MaintenancePlan,
      MaintenanceTask,
      MaintenanceWindowProposal,
      MaintenancePlanningCase,
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
    CashModule, // el pago de una tarea hecha sale de una caja
    GatewaysModule, // la propuesta de ventana le llega al chofer por el socket
    AttachmentModule, // documentos de vehículo y su lectura M6
  ],
  controllers: [
    FleetPlanController,
    FleetTaskController,
    FleetTaskV2Controller,
    FleetExpirationsController,
    CarDocumentsController,
    DeliveryDocumentsController,
    DeliveryVehicleController,
    CarAssignmentsController,
    EmployeeDocumentsController,
    CarReactivationController,
    MaintenancePlannerController,
    DriverMaintenanceProposalsController,
    CarDocumentsV2Controller,
  ],
  providers: [
    FleetPlanService,
    FleetTaskService,
    FleetTaskBoardReader,
    FleetTaskBoardNotifier,
    FleetTaskBoardService,
    FleetDispatchLockService,
    FleetAttachmentService,
    FleetExpirationsService,
    FleetPlanSeedListener,
    FleetAlertsCron,
    EmployeeDocumentsService,
    FleetCostSourceService,
    FleetVehicleStatusService,
    FleetInsuranceSyncService,
    MaintenanceForecastService,
    PlannerContextService,
    MaintenancePlannerService,
    MaintenancePlannerNotifier,
    MaintenancePlannerCron,
    VehicleUsageFeedService,
    VehicleUsageCron,
    PlanningCaseCloser,
    CarDocumentsService,
    { provide: TOPE_DEL_ESCANEO, useValue: TOPE_DEL_ESCANEO_MS },
    CarDocumentAttachmentOwnerResolver,
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
