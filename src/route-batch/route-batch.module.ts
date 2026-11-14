import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CarModule } from '../car/car.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { DistributorModule } from '../distributor/distributor.module';
import { FleetModule } from '../fleet/fleet.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { RouteBatch } from '../order/entities/route-batch.entity';
import { RoutePlan } from '../order/entities/route-plan.entity';
import { RouteBatchOffer } from '../order/entities/route-batch-offer.entity';
import { RouteBatchStop } from '../order/entities/route-batch-stop.entity';
import { OrderModule } from '../order/order.module';
import { RedisModule } from '../redis/redis.module';
import { DriverRouteBatchesController } from './driver-route-batches.controller';
import { RouteBatchQueryService } from './route-batch-query.service';
import { RouteBatchController } from './route-batch.controller';
import { RouteBatchCron } from './route-batch.cron';
import { RouteBatchNotifier } from './route-batch.notifier';
import { RouteBatchService } from './route-batch.service';
import { DocumentSequenceModule } from '../document-sequence/document-sequence.module';
import { RoutesModule } from '../routes/routes.module';
import { RoutePlanAutoConfirmService } from './application/route-plan-auto-confirm.service';
import { RoutePlanProposalService } from './application/route-plan-proposal.service';
import { RoutePlanService } from './application/route-plan.service';
import { RouteSheetCalculator } from './application/route-sheet-calculator.service';
import { RouteSheetDataService } from './application/route-sheet-data.service';
import { RouteSheetEditingService } from './application/route-sheet-editing.service';
import { RouteSheetLifecycleService } from './application/route-sheet-lifecycle.service';
import { RouteSheetLocks } from './application/route-sheet-locks.service';
import { RouteSheetQueryService } from './application/route-sheet-query.service';
import { RouteSheetPdfService } from './application/route-sheet-pdf.service';
import { PdfBrandingService } from '../pdf/pdf-branding.service';
import { S3Module } from '../s3/s3.module';
import { RouteSheetWriter } from './application/route-sheet-writer.service';
import {
  RoutePlansController,
  RoutePlanningSettingsController,
} from './presentation/route-plans.controller';
import { RouteSheetsController } from './presentation/route-sheets.controller';
import { RoutePlanningCron } from './route-planning.cron';
import { NotificationsModule } from '../notifications/notifications.module';
import { TruckLoadModule } from '../truck-load/truck-load.module';
import { RouteSheetAssignmentService } from './application/route-sheet-assignment.service';
import { RouteSheetCloseService } from './application/route-sheet-close.service';
import { RouteSheetEtaService } from './application/route-sheet-eta.service';
import { RouteSheetExecutionQueryService } from './application/route-sheet-execution-query.service';
import { RouteSheetInProgressEditingService } from './application/route-sheet-in-progress-editing.service';
import { RouteSheetInProgress } from './application/route-sheet-in-progress.service';
import { RouteSheetNotifier } from './application/route-sheet-notifier.service';
import { RouteSheetProgress } from './application/route-sheet-progress.service';
import { RouteSheetStartService } from './application/route-sheet-start.service';
import { RouteSheetStopsService } from './application/route-sheet-stops.service';
import { RouteSheetWatchService } from './application/route-sheet-watch.service';
import { DriverRouteSheetsController } from './presentation/driver-route-sheets.controller';
import { OrderEtaController } from './presentation/order-eta.controller';
import { RoutePlanningHolidaysController } from './presentation/route-planning-holidays.controller';
import { RoutePlanningCalendarService } from './application/route-planning-calendar.service';
import { RoutePlanningHoliday } from '../order/entities/route-planning-holiday.entity';

/**
 * Agrupación inteligente de pedidos por recorrido (CU-107, módulo M4). Arma
 * lotes de pedidos programados, los ofrece completos a un chofer por vez y,
 * si nadie los toma, los devuelve al despacho individual (M1, `OrderModule`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RouteBatch,
      RouteBatchStop,
      RouteBatchOffer,
      RoutePlan, // la clave compuesta (distribuidora, día) del lote la referencia
      RoutePlanningHoliday, // feriados de la hoja de ruta
    ]),
    OrderModule, // asignar los pedidos del lote y devolverlos al despacho individual
    DeliveryModule, // el chofer y su pertenencia
    CarModule, // la capacidad de carga del vehículo
    FleetModule, // vehículo en uso del chofer y gate de habilitación
    DistributorModule, // los parámetros de la agrupación
    GatewaysModule, // la oferta le llega al chofer por el socket
    RedisModule, // cerrojos del proceso y de cada lote
    RoutesModule, // matriz de tiempos de la hoja de ruta (OSRM o línea recta)
    DocumentSequenceModule, // número de la hoja al confirmarla
    S3Module, // el logo de la distribuidora en el PDF de la hoja
    TruckLoadModule, // la carga abierta del chofer al iniciar la hoja (E4)
    NotificationsModule, // push al cliente con su franja estimada (E5)
  ],
  controllers: [
    RouteBatchController,
    DriverRouteBatchesController,
    RoutePlansController,
    RouteSheetsController,
    RoutePlanningSettingsController,
    DriverRouteSheetsController,
    OrderEtaController,
    RoutePlanningHolidaysController,
  ],
  providers: [
    RouteBatchService,
    RouteBatchQueryService,
    RouteBatchNotifier,
    RouteBatchCron,
    // Hoja de ruta (F34, E3): planificación, edición y propuesta.
    RouteSheetDataService,
    RouteSheetCalculator,
    RouteSheetWriter,
    RouteSheetLocks,
    RoutePlanService,
    RoutePlanProposalService,
    RoutePlanAutoConfirmService, // confirmación automática al vencer la revisión
    RouteSheetEditingService,
    RouteSheetLifecycleService,
    RouteSheetQueryService,
    RouteSheetPdfService,
    PdfBrandingService, // membrete del PDF (el de `pdf/`, que no lo exporta)
    RoutePlanningCron,
    // Hoja de ruta (F34, E4 y E5): ejecución en la calle y hora estimada.
    RouteSheetNotifier,
    RouteSheetProgress,
    RouteSheetEtaService,
    RouteSheetInProgress,
    RouteSheetAssignmentService,
    RouteSheetStartService,
    RouteSheetStopsService,
    RouteSheetInProgressEditingService,
    RouteSheetCloseService,
    RouteSheetWatchService,
    RouteSheetExecutionQueryService,
    RoutePlanningCalendarService, // días hábiles y feriados
  ],
})
export class RouteBatchModule {}
