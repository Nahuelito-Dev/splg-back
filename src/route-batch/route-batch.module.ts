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
  ],
  controllers: [
    RouteBatchController,
    DriverRouteBatchesController,
    RoutePlansController,
    RouteSheetsController,
    RoutePlanningSettingsController,
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
    RouteSheetEditingService,
    RouteSheetLifecycleService,
    RouteSheetQueryService,
    RouteSheetPdfService,
    PdfBrandingService, // membrete del PDF (el de `pdf/`, que no lo exporta)
    RoutePlanningCron,
  ],
})
export class RouteBatchModule {}
