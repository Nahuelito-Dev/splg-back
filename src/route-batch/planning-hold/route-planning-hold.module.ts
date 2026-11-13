import { Module } from '@nestjs/common';
import { RoutePlanningHoldService } from './route-planning-hold.service';
import { RouteSheetStopReleaseSubscriber } from './route-sheet-stop-release.subscriber';

/**
 * La consulta de retención de la hoja de ruta y la baja de la parada de un
 * pedido cancelado o entregado, solas en su módulo: el despacho individual
 * (`OrderModule`) lo importa sin depender de `RouteBatchModule`, que a su vez
 * importa `OrderModule`.
 */
@Module({
  providers: [RoutePlanningHoldService, RouteSheetStopReleaseSubscriber],
  exports: [RoutePlanningHoldService],
})
export class RoutePlanningHoldModule {}
