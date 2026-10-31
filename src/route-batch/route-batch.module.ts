import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CarModule } from '../car/car.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { DistributorModule } from '../distributor/distributor.module';
import { FleetModule } from '../fleet/fleet.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { RouteBatch } from '../order/entities/route-batch.entity';
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

/**
 * Agrupación inteligente de pedidos por recorrido (CU-107, módulo M4). Arma
 * lotes de pedidos programados, los ofrece completos a un chofer por vez y,
 * si nadie los toma, los devuelve al despacho individual (M1, `OrderModule`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RouteBatch, RouteBatchStop, RouteBatchOffer]),
    OrderModule, // asignar los pedidos del lote y devolverlos al despacho individual
    DeliveryModule, // el chofer y su pertenencia
    CarModule, // la capacidad de carga del vehículo
    FleetModule, // vehículo en uso del chofer y gate de habilitación
    DistributorModule, // los parámetros de la agrupación
    GatewaysModule, // la oferta le llega al chofer por el socket
    RedisModule, // cerrojos del proceso y de cada lote
  ],
  controllers: [RouteBatchController, DriverRouteBatchesController],
  providers: [
    RouteBatchService,
    RouteBatchQueryService,
    RouteBatchNotifier,
    RouteBatchCron,
  ],
})
export class RouteBatchModule {}
