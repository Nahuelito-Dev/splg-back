import { Module } from '@nestjs/common';
import { OrderModule } from '../order/order.module';
import { RedisModule } from '../redis/redis.module';
import { RoutesController } from './routes.controller';
import { ROUTES_FETCH, RoutesService } from './routes.service';

@Module({
  imports: [OrderModule, RedisModule],
  controllers: [RoutesController],
  providers: [
    RoutesService,
    {
      provide: ROUTES_FETCH,
      useValue: (url: string, init?: RequestInit) => fetch(url, init),
    },
  ],
})
export class RoutesModule {}
