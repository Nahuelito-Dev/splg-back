import { Module } from '@nestjs/common';
import { OrderModule } from '../order/order.module';
import { RedisModule } from '../redis/redis.module';
import { OsrmTableMatrixAdapter } from './osrm-table.adapter';
import { RouteMatrixPort } from './route-matrix.port';
import { RoutesController } from './routes.controller';
import { ROUTES_FETCH, RoutesService } from './routes.service';

@Module({
  imports: [OrderModule, RedisModule],
  controllers: [RoutesController],
  providers: [
    RoutesService,
    OsrmTableMatrixAdapter,
    { provide: RouteMatrixPort, useExisting: OsrmTableMatrixAdapter },
    {
      provide: ROUTES_FETCH,
      useValue: (url: string, init?: RequestInit) => fetch(url, init),
    },
  ],
  exports: [RouteMatrixPort],
})
export class RoutesModule {}
