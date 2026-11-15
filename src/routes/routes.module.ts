import { Module } from '@nestjs/common';
import { OrderModule } from '../order/order.module';
import { RedisModule } from '../redis/redis.module';
import { OsrmTableMatrixAdapter } from './osrm-table.adapter';
import { RouteMatrixPort } from './route-matrix.port';
import { RoutePathService } from './route-path.service';
import { RoutesController } from './routes.controller';
import { ROUTES_FETCH, RoutesService } from './routes.service';

@Module({
  imports: [OrderModule, RedisModule],
  controllers: [RoutesController],
  providers: [
    RoutesService,
    RoutePathService, // recorrido por calles de una hoja de ruta
    OsrmTableMatrixAdapter,
    { provide: RouteMatrixPort, useExisting: OsrmTableMatrixAdapter },
    {
      provide: ROUTES_FETCH,
      useValue: (url: string, init?: RequestInit) => fetch(url, init),
    },
  ],
  exports: [RouteMatrixPort, RoutePathService],
})
export class RoutesModule {}
