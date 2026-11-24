import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { OrderModule } from '../order/order.module';
import { RouteBatchModule } from '../route-batch/route-batch.module';
import {
  FailedDeliveryV3Controller,
  FailedVisitsV3Controller,
} from './failed-delivery-v3.controller';
import { FailedVisitCoreModule } from './failed-visit-core.module';
import { ReportFailedDeliveryUseCase } from './report-failed-delivery.use-case';

/**
 * Entrega fallida y nueva visita (C5): el «No pude entregar» único del chofer
 * para pedidos sueltos, express y hojas de ruta, la respuesta del cliente y
 * las acciones del admin.
 */
@Module({
  imports: [
    FailedVisitCoreModule,
    OrderModule, // liberación del pedido por la máquina de estados y aislamiento por distribuidora
    RouteBatchModule, // la parada de una hoja en curso sigue el circuito de la hoja
    DeliveryModule, // el chofer que informa
  ],
  controllers: [FailedDeliveryV3Controller, FailedVisitsV3Controller],
  providers: [ReportFailedDeliveryUseCase],
})
export class FailedVisitModule {}
